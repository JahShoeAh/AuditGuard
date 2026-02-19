import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  computeLiveBid,
  normalizeBidFailureReasonCode,
  randomInt,
  randomFloat,
  randomBool,
  randomSeveritySkewedHigh,
  randomFindingTitle,
  hashOf,
  sleep,
} from "../shared/index.js";
import type {
  ContractDiscoveryEvent,
  ContractType,
  Finding,
  HCSMessage,
  SubResultDeliveredEvent,
} from "../shared/types.js";
import { ethers } from "ethers";
import {
  ensureZgReady,
  infer,
  getReadinessSnapshot,
  ZGClientError,
} from "./zg-client.js";
import { buildMessages } from "./prompt-builder.js";
import { parseFindings } from "./response-parser.js";
import type { AuditContext } from "./prompt-builder.js";
import { loadContractSource } from "../shared/contract-source.js";

// ---- Config ----
const AGENT_ID = "llm-contextual-003";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const STRICT_LIVE = (process.env.STRICT_LIVE ?? String(CONFIG.strictLive)) === "true";
const SPECIALIZATIONS: ContractType[] = ["lending", "bridge", "dex"];
const BASE_REPUTATION = 87;
const MIN_RISK_SCORE = 50;       // only take complex jobs
const MIN_LOC = 1000;            // not worth my time below this
const SUB_CONTRACT_PAYMENT = 3;  // GUARD for dependency analysis
const SUB_CONTRACT_SLA = DEMO_MODE ? 120 : 900; // 2 min demo, 15 min prod
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;
const GUARD_DECIMALS = 8;
const ZG_REQUIRED_IN_LIVE =
  (process.env.ZG_REQUIRED_IN_LIVE ?? String((CONFIG as any).zgInference?.requiredInLive ?? true)) !== "false";
const STRICT_LIVE_ZG_REQUIRED = STRICT_LIVE && !DEMO_MODE && ZG_REQUIRED_IN_LIVE;

const log = createAgentLogger(AGENT_ID, "llm_contextual");

// Pending sub-contract results
const pendingSubResults: Map<string, (result: SubResultDeliveredEvent) => void> = new Map();

// Track pending jobs awaiting winner selection
const pendingJobs = new Map<string, {
  jobId: string;
  contractAddress: string;
  contractType: ContractType;
  loc: number;
  sourceRef?: string;
}>();
const startedJobs = new Set<string>();

// Dynamic pricing state
let bidMultiplier = 1.0;
let totalBids = 0;
let totalWins = 0;
const PRICING_ALPHA = 0.3;
const zgRuntime = {
  providerAddress: "",
  model: "",
  endpoint: "",
};

function parseChainUint(value: string | number | bigint): bigint {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid numeric id: ${normalized}`);
  }
  return BigInt(normalized);
}

function updatePricingAfterOutcome(won: boolean) {
  totalBids++;
  if (won) totalWins++;
  const winRate = totalBids > 0 ? totalWins / totalBids : 0.5;
  const target = 0.45;
  bidMultiplier = bidMultiplier * (1 - PRICING_ALPHA) + (1 + (target - winRate)) * PRICING_ALPHA;
  bidMultiplier = Math.max(0.5, Math.min(2.0, bidMultiplier));
  log.info(`Dynamic pricing: winRate=${(winRate * 100).toFixed(0)}% multiplier=${bidMultiplier.toFixed(2)}`);
}

function normalizeZgFailureReasonCode(error: unknown): string {
  if (error instanceof ZGClientError) return error.code;
  const message = String(error ?? "").toLowerCase();
  if (message.includes("timeout")) return "zg_timeout";
  if (message.includes("metadata")) return "zg_provider_metadata_failed";
  if (message.includes("header")) return "zg_request_headers_failed";
  if (message.includes("ack")) return "zg_provider_ack_failed";
  if (message.includes("ledger")) return "zg_ledger_unfunded";
  return "zg_http_error";
}

// ---- Bidding Logic ----

export function shouldBid(
  estimatedLOC: number,
  contractType: ContractType,
  riskScore: number
): boolean {
  if (riskScore < MIN_RISK_SCORE) {
    log.info(`Risk too low (${riskScore} < ${MIN_RISK_SCORE}), skipping`);
    return false;
  }
  if (estimatedLOC < MIN_LOC) {
    log.info(`Too small (${estimatedLOC} LOC < ${MIN_LOC}), skipping`);
    return false;
  }
  return true;
}

export function calculateBid(
  estimatedLOC: number,
  contractType: ContractType,
  riskScore: number
): { amount: number; collateral: number; estimatedTimeSec: number } {
  let bid = (30 + estimatedLOC * 0.003) * bidMultiplier;

  if (contractType === "lending" || contractType === "bridge") {
    bid *= 1.15; // premium for risky protocol types
  }

  const collateral = bid * 0.4; // lower collateral (high rep)
  const estimatedTimeSec = DEMO_MODE ? randomInt(10, 30) : randomInt(60, 180);

  return {
    amount: Math.round(bid * 100) / 100,
    collateral: Math.round(collateral * 100) / 100,
    estimatedTimeSec,
  };
}

// ---- Mock Audit (fallback) ----

export function generateMockFindings(contractType: ContractType, hasDepAnalysis: boolean): Finding[] {
  const count = randomInt(1, 5);
  const findings: Finding[] = [];

  for (let i = 0; i < count; i++) {
    findings.push({
      id: `LLM-${String(i + 1).padStart(3, "0")}`,
      severity: randomSeveritySkewedHigh(),
      title: randomFindingTitle(contractType),
      description: `Deep semantic analysis finding${hasDepAnalysis ? " (informed by dependency analysis)" : ""}`,
      confidence: randomFloat(0.8, 0.99),
      agentId: AGENT_ID,
      timestamp: Date.now(),
    });
  }

  // Preserve "skewed-high" behavior deterministically for pipeline tests.
  if (findings.length > 0 && !findings.some((f) => f.severity === "critical" || f.severity === "high")) {
    findings[0].severity = "high";
  }

  return findings;
}

/** Backward-compatible alias so existing tests and callers keep working. */
export const generateFindings = generateMockFindings;

export interface InviteResolutionInput {
  queued?: {
    contractType: ContractType;
    loc: number;
    riskScore: number;
    sourceRef?: string;
  };
  invite: {
    contractType?: unknown;
    riskScore?: unknown;
    estimatedLOC?: unknown;
    estimatedLineCount?: unknown;
  };
}

export function resolveAuctionInviteContext(
  input: InviteResolutionInput
): { contractType: ContractType; loc: number; riskScore: number } {
  const { queued, invite } = input;
  const contractType = (queued?.contractType ?? invite.contractType ?? "lending") as ContractType;
  const loc = Number(queued?.loc ?? invite.estimatedLOC ?? invite.estimatedLineCount ?? 1200);
  const riskScore = Number(queued?.riskScore ?? invite.riskScore ?? 50);
  return { contractType, loc, riskScore };
}

// ---- AI-Powered Audit via 0g ----

function isZgEnabled(): boolean {
  const cfg = (CONFIG as any).zgInference ?? {};
  if (cfg.enabled === false) return false;
  if (process.env.ZG_ENABLED === "false") return false;
  const privateKey = process.env.ZG_PRIVATE_KEY ?? "";
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS ?? cfg.providerAddress ?? "";
  return privateKey.length > 0 && providerAddress.length > 0;
}

interface AnalyzeResult {
  findings: Finding[];
  usedFallback: boolean;
  providerAddress?: string;
  model?: string;
  requestId?: string;
}

export async function analyzeWithAI(
  ctx: AuditContext
): Promise<AnalyzeResult> {
  if (!isZgEnabled()) {
    if (STRICT_LIVE_ZG_REQUIRED) {
      throw new ZGClientError(
        "zg_not_configured",
        "0g inference is required in strict live mode but is not configured",
        "analyze_config"
      );
    }
    log.info("[0g fallback] 0g inference disabled — using mock findings");
    return { findings: generateMockFindings(ctx.contractType, ctx.hasDepAnalysis), usedFallback: true };
  }

  const cfg = (CONFIG as any).zgInference ?? {};
  const model = cfg.model || process.env.ZG_MODEL || zgRuntime.model || "qwen-2.5-7b-instruct";
  const messages = buildMessages(ctx);
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const inference = await infer({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4000,
      });
      const raw = inference.content;

      const result = parseFindings(raw, AGENT_ID, ctx.contractType);

      if (result.parseError) {
        log.warn(`[0g] Parse error (attempt ${attempt}): ${result.parseError}`);
        if (attempt < maxAttempts) continue;
        if (STRICT_LIVE_ZG_REQUIRED) {
          throw new ZGClientError(
            "zg_response_invalid",
            `0g response parse failed after retries: ${result.parseError}`,
            "analyze_parse"
          );
        }
        log.info("[0g fallback] All attempts failed to parse — using mock findings");
        return { findings: generateMockFindings(ctx.contractType, ctx.hasDepAnalysis), usedFallback: true };
      }

      log.info(`[0g] AI analysis complete: ${result.findings.length} findings`);
      return {
        findings: result.findings,
        usedFallback: false,
        providerAddress: inference.providerAddress,
        model: inference.model,
        requestId: inference.requestId,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[0g] Inference error (attempt ${attempt}): ${errMsg}`);
      if (attempt < maxAttempts) {
        await sleep(2000);
        continue;
      }
      if (STRICT_LIVE_ZG_REQUIRED) {
        throw err;
      }
    }
  }

  if (STRICT_LIVE_ZG_REQUIRED) {
    throw new ZGClientError(
      "zg_response_invalid",
      "0g inference failed after all retry attempts",
      "analyze_retry"
    );
  }
  log.info("[0g fallback] All retry attempts exhausted — using mock findings");
  return { findings: generateMockFindings(ctx.contractType, ctx.hasDepAnalysis), usedFallback: true };
}

// ---- Main ----

async function main() {
  log.info("LLM Contextual Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");
  log.info(`Specializations: ${SPECIALIZATIONS.join(", ")}`);
  log.info(`Min risk: ${MIN_RISK_SCORE}, Min LOC: ${MIN_LOC}`);

  const wallet = createAgentWallet("LLM");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);
  let minBidCollateralWei = ethers.parseUnits(
    CONFIG.bidPolicy.minCollateralGuard.toFixed(2),
    GUARD_DECIMALS
  );
  let minBidCollateralGuard = CONFIG.bidPolicy.minCollateralGuard;
  const zgEnabled = isZgEnabled();
  log.info(`Wallet: ${wallet.evmAddress}`);

  if (!zgEnabled && STRICT_LIVE_ZG_REQUIRED) {
    const reasonCode = "zg_not_configured";
    const reason = "0g inference is required in strict live mode but ZG_* env is not configured";
    await hcs.publishAuditLog({
      type: "LLM_PROVIDER_UNHEALTHY",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        reasonCode,
        reason,
        strictLive: true,
        providerAddress: (CONFIG as any).zgInference?.providerAddress ?? process.env.ZG_PROVIDER_ADDRESS ?? "",
        model: (CONFIG as any).zgInference?.model ?? process.env.ZG_MODEL ?? "",
      },
    });
    throw new Error(reason);
  }

  if (zgEnabled) {
    log.info("Initializing 0g Compute Network broker...");
    try {
      const readiness = await ensureZgReady();
      zgRuntime.providerAddress = readiness.providerAddress;
      zgRuntime.model = readiness.model;
      zgRuntime.endpoint = readiness.endpoint;
      await hcs.publishAuditLog({
        type: "LLM_PROVIDER_READY",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          providerAddress: readiness.providerAddress,
          model: readiness.model,
          endpoint: readiness.endpoint,
          requestId: readiness.requestId ?? null,
          strictLive: STRICT_LIVE_ZG_REQUIRED,
        },
      });
      log.info(`0g broker ready (${readiness.providerAddress.slice(0, 10)}..., model=${readiness.model})`);
    } catch (err) {
      const reasonCode = normalizeZgFailureReasonCode(err);
      const reason = err instanceof Error ? err.message : String(err);
      await hcs.publishAuditLog({
        type: "LLM_PROVIDER_UNHEALTHY",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          reasonCode,
          reason,
          strictLive: STRICT_LIVE_ZG_REQUIRED,
          providerAddress: (CONFIG as any).zgInference?.providerAddress ?? process.env.ZG_PROVIDER_ADDRESS ?? "",
          model: (CONFIG as any).zgInference?.model ?? process.env.ZG_MODEL ?? "",
        },
      });
      if (STRICT_LIVE_ZG_REQUIRED) {
        throw new Error(`Strict live startup blocked: ${reasonCode}: ${reason}`);
      }
      log.warn(`0g startup not healthy; mock fallback remains enabled in non-strict mode: ${reason}`);
    }
  } else {
    log.info("0g inference disabled — will use mock fallback");
  }

  const readySnapshot = getReadinessSnapshot();
  if (readySnapshot) {
    zgRuntime.providerAddress = readySnapshot.providerAddress;
    zgRuntime.model = readySnapshot.model;
    zgRuntime.endpoint = readySnapshot.endpoint;
  }

  try {
    minBidCollateralWei = await contracts.getMinBidCollateral();
    minBidCollateralGuard = Number(ethers.formatUnits(minBidCollateralWei, GUARD_DECIMALS));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to read MIN_BID_COLLATERAL from chain, using config default: ${error}`);
  }
  log.info(`Live bid policy: min collateral ${minBidCollateralGuard.toFixed(2)} GUARD`);

  // Register with the orchestrator so our bids are accepted
  await hcs.publishAuditLog({
    type: "AGENT_REGISTERED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      evmAddress: wallet.evmAddress,
      specializations: SPECIALIZATIONS,
      stake: 100,
      reputation: BASE_REPUTATION,
    },
  });
  log.info("Published AGENT_REGISTERED to auditLog");

  if (STRICT_LIVE && !DEMO_MODE) {
    try {
      const active = await contracts.isActiveAgent(wallet.evmAddress);
      if (!active) {
        log.warn("Startup preflight: wallet is not an active on-chain agent");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: active-agent check failed: ${error}`);
    }

    try {
      const approvalTx = await contracts.ensureGuardAllowance(
        contracts.getAuctionAddress(),
        minBidCollateralWei
      );
      if (approvalTx) {
        await approvalTx.wait?.();
        log.info("Startup preflight: approved GUARD allowance for AuditAuction");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: GUARD allowance setup failed: ${error}`);
    }
  }

  // Queue discoveries until AUCTION_INVITE arrives with real jobId
  const discoveryQueue = new Map<string, {
    contractType: ContractType;
    loc: number;
    riskScore: number;
    sourceRef?: string;
  }>();

  // Listen for sub-contract result deliveries + AUCTION_INVITE
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type === "PING") {
      await hcs.publishAgentComms({
        type: "PONG",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {},
      });
      return;
    }

    if (msg.type === "SUB_RESULT_DELIVERED") {
      const result = msg as SubResultDeliveredEvent;
      const callback = pendingSubResults.get(result.payload.subAuctionId);
      if (callback) {
        callback(result);
        pendingSubResults.delete(result.payload.subAuctionId);
      }
    }

    if (msg.type === "AUCTION_INVITE") {
      const { jobId, contractAddress, contractType, riskScore, estimatedLOC, estimatedLineCount, budget } = (msg as any).payload;
      const queued = discoveryQueue.get(contractAddress);
      if (queued) discoveryQueue.delete(contractAddress);

      const resolved = resolveAuctionInviteContext({
        queued,
        invite: { contractType, riskScore, estimatedLOC, estimatedLineCount },
      });

      // Keep premium gating behavior even when using invite fallback context.
      if (!shouldBid(resolved.loc, resolved.contractType, resolved.riskScore)) return;
      const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);

      const computed = computeLiveBid(bid, budget, {
        ...CONFIG.bidPolicy,
        minCollateralGuard: Math.max(CONFIG.bidPolicy.minCollateralGuard, minBidCollateralGuard),
      });
      if (computed.skip || !computed.bid) {
        await hcs.publishAuditLog({
          type: "BID_SKIPPED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            jobId: String(jobId),
            contractAddress,
            reason: computed.skip?.reason ?? "Bid policy rejected invite",
            reasonCode: computed.skip?.reasonCode ?? "bid_policy_rejected",
            computedBid: bid.amount,
            computedCollateral: bid.collateral,
            budget: Number(budget ?? 0),
            strictLive: STRICT_LIVE && !DEMO_MODE,
            evmAddress: wallet.evmAddress,
          },
        });
        return;
      }
      const finalBid = computed.bid;
      log.info(
        `AUCTION_INVITE for job #${jobId} — premium bid ${finalBid.amount} GUARD ` +
        `(collateral ${finalBid.collateral} GUARD)`
      );

      if (STRICT_LIVE && !DEMO_MODE) {
        let active = false;
        try {
          active = await contracts.isActiveAgent(wallet.evmAddress);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await hcs.publishAuditLog({
            type: "BID_SKIPPED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: String(jobId),
              contractAddress,
              reason: `Active-agent check failed: ${error}`,
              reasonCode: "active_agent_check_failed",
              computedBid: finalBid.amount,
              computedCollateral: finalBid.collateral,
              budget: finalBid.inviteBudget ?? Number(budget ?? 0),
              strictLive: true,
              evmAddress: wallet.evmAddress,
            },
          });
          return;
        }
        if (!active) {
          await hcs.publishAuditLog({
            type: "BID_SKIPPED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: String(jobId),
              contractAddress,
              reason: "Wallet is not an active on-chain agent",
              reasonCode: "inactive_agent",
              computedBid: finalBid.amount,
              computedCollateral: finalBid.collateral,
              budget: finalBid.inviteBudget ?? Number(budget ?? 0),
              strictLive: true,
              evmAddress: wallet.evmAddress,
            },
          });
          return;
        }

        const balance = await contracts.getGuardBalance(wallet.evmAddress);
        if (balance < finalBid.collateralWei) {
          await hcs.publishAuditLog({
            type: "BID_SKIPPED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: String(jobId),
              contractAddress,
              reason: "Insufficient GUARD balance for bid collateral",
              reasonCode: "insufficient_collateral_balance",
              computedBid: finalBid.amount,
              computedCollateral: finalBid.collateral,
              budget: finalBid.inviteBudget ?? Number(budget ?? 0),
              strictLive: true,
              evmAddress: wallet.evmAddress,
            },
          });
          return;
        }

        try {
          const approvalTx = await contracts.ensureGuardAllowance(
            contracts.getAuctionAddress(),
            finalBid.collateralWei
          );
          if (approvalTx) {
            await approvalTx.wait?.();
            log.info(`Updated GUARD allowance for job #${jobId}`);
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await hcs.publishAuditLog({
            type: "BID_SKIPPED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: String(jobId),
              contractAddress,
              reason: `Failed to update GUARD allowance: ${error}`,
              reasonCode: "allowance_update_failed",
              computedBid: finalBid.amount,
              computedCollateral: finalBid.collateral,
              budget: finalBid.inviteBudget ?? Number(budget ?? 0),
              strictLive: true,
              evmAddress: wallet.evmAddress,
            },
          });
          return;
        }
      }

      try {
        // Add jitter to avoid race conditions (nonce/gas collisions) with other agents
        const jitter = randomInt(1000, 5000);
        log.info(`Waiting ${jitter}ms jitter before bidding...`);
        await sleep(jitter);

        const tx = await contracts.submitBid(
          jobId,
          finalBid.amountWei,
          finalBid.collateralWei,
          finalBid.estimatedTimeSec,
          SPECIALIZATIONS[0]
        );
        log.info(`On-chain bid submitted (tx: ${tx.hash?.slice(0, 14)}...)`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const reasonCode = normalizeBidFailureReasonCode(error);
        log.warn(`On-chain bid failed: ${error}`);
        if (STRICT_LIVE && !DEMO_MODE) {
          await hcs.publishAuditLog({
            type: "BID_SUBMISSION_FAILED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: String(jobId),
              contractAddress,
              strictLive: true,
              error,
              reasonCode,
            },
          });
          return;
        }
      }

      pendingJobs.set(String(jobId), {
        jobId: String(jobId),
        contractAddress,
        contractType: resolved.contractType,
        loc: resolved.loc,
        sourceRef: queued?.sourceRef ?? (msg as any)?.payload?.sourceRef,
      });

      await hcs.publishAuditLog({
        type: "BID_SUBMITTED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          jobId,
          contractAddress,
          bidAmount: finalBid.amount,
          collateral: finalBid.collateral,
          estimatedTimeSec: finalBid.estimatedTimeSec,
          reputation: BASE_REPUTATION,
          tier: "PREMIUM",
          evmAddress: wallet.evmAddress,
        },
      });

      setTimeout(async () => {
        if (pendingJobs.has(String(jobId))) {
          log.info(`No WinnersSelected after ${WINNER_WAIT_MS / 1000}s — auto-simulating`);
          updatePricingAfterOutcome(true);
          pendingJobs.delete(String(jobId));
          await simulateAuditCycle(
            String(jobId),
            contractAddress,
            resolved.contractType,
            resolved.loc,
            queued?.sourceRef ?? (msg as any)?.payload?.sourceRef,
            hcs,
            contracts,
            wallet.evmAddress
          );
        }
      }, WINNER_WAIT_MS);
      return;
    }

    if (msg.type === "WINNERS_SELECTED_FALLBACK") {
      const { jobId, winners, selectionEpoch } = (msg as any).payload ?? {};
      const jobKey = String(jobId);
      const dedupKey = `${jobKey}:${selectionEpoch ?? "0"}`;
      if (startedJobs.has(dedupKey)) {
        log.info(`Already processing job ${jobKey}, skipping`);
        return;
      }
      const isWinner = Array.isArray(winners) && winners.some((w: any) => {
        const winnerAddress = typeof w === "string" ? w : w?.evmAddress;
        return typeof winnerAddress === "string" && winnerAddress.toLowerCase() === wallet.evmAddress.toLowerCase();
      });
      if (!isWinner) return;

      const pending = pendingJobs.get(jobKey);
      if (!pending) {
        log.warn(`Fallback winner notification for job #${jobKey} but no pending context`);
        return;
      }

      log.info(`Won job ${jobKey} via fallback notification`);
      startedJobs.add(dedupKey);
      updatePricingAfterOutcome(true);
      pendingJobs.delete(jobKey);
      simulateAuditCycle(
        pending.jobId,
        pending.contractAddress,
        pending.contractType,
        pending.loc,
        pending.sourceRef,
        hcs,
        contracts,
        wallet.evmAddress
      ).catch((err) => log.error(`Audit cycle failed: ${err}`));
    }
  });

  // Listen for winner selection events on-chain
  contracts.onWinnerSelected((jobId, winners, totalEscrowed, platformFee) => {
    const myAddress = wallet.evmAddress.toLowerCase();
    const winnerIndex = winners.findIndex(w => w.toLowerCase() === myAddress);
    if (winnerIndex === -1) return;

    const jobKey = jobId.toString();
    const pending = pendingJobs.get(jobKey);
    if (!pending) return;

    log.info(`WON auction for job #${jobKey}! Premium contract.`);
    updatePricingAfterOutcome(true);
    pendingJobs.delete(jobKey);

    simulateAuditCycle(
      pending.jobId,
      pending.contractAddress,
      pending.contractType,
      pending.loc,
      pending.sourceRef,
      hcs,
      contracts,
      wallet.evmAddress
    )
      .catch(err => log.error(`Audit cycle failed: ${err}`));
  });

  // Listen for discoveries — queue until AUCTION_INVITE arrives
  hcs.subscribeDiscovery(async (msg: HCSMessage) => {
    if (msg.type !== "CONTRACT_DISCOVERED") return;

    const discovery = msg as ContractDiscoveryEvent;
    const { contractAddress, contractType, riskScore, estimatedLOC, sourceRef } = discovery.payload;

    log.info(
      `Evaluating: ${contractAddress.slice(0, 10)}... ` +
      `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
    );

    if (!shouldBid(estimatedLOC, contractType, riskScore)) return;

    const bid = calculateBid(estimatedLOC, contractType, riskScore);
    log.info(`Queuing premium bid intent: ${bid.amount} GUARD — waiting for AUCTION_INVITE`);

    discoveryQueue.set(contractAddress, {
      contractType,
      loc: estimatedLOC,
      riskScore,
      sourceRef,
    });
  });

  log.info("Subscribed to discovery + agentComms. Waiting for high-value contracts...");
}

async function simulateAuditCycle(
  jobId: string,
  contractAddress: string,
  contractType: ContractType,
  loc: number,
  sourceRef: string | undefined,
  hcs: HCSClient,
  contracts: ContractClient,
  evmAddress: string
) {
  let hasDepAnalysis = false;

  // 70% chance contract has external dependencies requiring sub-contract
  if (randomBool(0.7)) {
    log.info(
      `External dependencies detected. Sub-contracting dependency analysis ` +
      `(${SUB_CONTRACT_PAYMENT} GUARD, ${SUB_CONTRACT_SLA}s SLA)`
    );

    let subAuctionId = `sub-${Date.now()}-${randomInt(1000, 9999)}`;
    let parentJobId: bigint;
    try {
      parentJobId = parseChainUint(jobId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Invalid parent job id for sub-auction: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "SUB_AUCTION_CREATE_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { jobId, strictLive: true, error },
        });
        return;
      }
      parentJobId = BigInt(0);
    }

    // Create sub-auction on-chain
    try {
      const tx = await contracts.createSubAuction(
        parentJobId,
        "Dependency analysis for audit job",  // taskDescription
        "dependency_analysis",                // requiredSpecialization
        ethers.parseUnits(SUB_CONTRACT_PAYMENT.toString(), 8),
        SUB_CONTRACT_SLA,
      );
      const receipt = await tx.wait();
      if (receipt?.logs) {
        for (const log of receipt.logs) {
          try {
            const parsed = contracts.subAuction.interface.parseLog(log);
            if (parsed?.name === "SubAuctionCreated") {
              subAuctionId = String(parsed.args.subJobId);
              break;
            }
          } catch {
            // Ignore unrelated logs.
          }
        }
      }
      log.info("Sub-auction created on-chain");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`On-chain sub-auction failed: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "SUB_AUCTION_CREATE_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { jobId, strictLive: true, error },
        });
        return;
      }
    }

    // Broadcast sub-auction to agent network
    await hcs.publishAgentComms({
      type: "SUB_AUCTION_POSTED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        subAuctionId,
        taskType: "dependency_analysis",
        paymentAmount: SUB_CONTRACT_PAYMENT,
        slaDurationSec: SUB_CONTRACT_SLA,
        parentJobId: jobId,
      },
    });

    await hcs.publishAuditLog({
      type: "SUB_AUCTION_CREATED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        subAuctionId,
        taskType: "dependency_analysis",
        payment: SUB_CONTRACT_PAYMENT,
        parentJobId: jobId,
      },
    });

    // Wait for sub-contractor to deliver (with timeout)
    log.info("Waiting for dependency analysis delivery...");
    hasDepAnalysis = await waitForSubResult(subAuctionId, SUB_CONTRACT_SLA * 1000);

    if (hasDepAnalysis) {
      log.info("Dependency analysis received. Incorporating into audit.");

      // Accept result on-chain
      try {
        const chainSubAuctionId = parseChainUint(subAuctionId);
        await contracts.acceptResult(chainSubAuctionId);
        log.info("Sub-result accepted on-chain");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`On-chain accept failed: ${error}`);
        if (STRICT_LIVE && !DEMO_MODE) {
          await hcs.publishAuditLog({
            type: "SUB_RESULT_ACCEPT_FAILED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: { jobId, subAuctionId, strictLive: true, error },
          });
          return;
        }
      }

      await hcs.publishAuditLog({
        type: "SUB_RESULT_ACCEPTED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: { subAuctionId },
      });
    } else {
      log.info("Sub-contract timed out. Proceeding without dependency data.");
    }
  }

  // Main audit
  const auditTime = DEMO_MODE ? randomInt(10, 30) : randomInt(60, 180);
  log.info(`Running deep semantic analysis... (${auditTime}s)`);
  await sleep(auditTime * 1000);

  let contractSource: string | undefined;
  if (sourceRef) {
    const src = loadContractSource(sourceRef);
    if (src) {
      contractSource = src;
      log.info(`Loaded ${src.length} chars of source for ${sourceRef}`);
    }
  }

  const inferenceStartedAt = Date.now();
  await hcs.publishAuditLog({
    type: "LLM_INFERENCE_STARTED",
    agentId: AGENT_ID,
    timestamp: inferenceStartedAt,
    payload: {
      jobId,
      contractAddress,
      providerAddress: zgRuntime.providerAddress || (CONFIG as any).zgInference?.providerAddress || process.env.ZG_PROVIDER_ADDRESS || "",
      model: zgRuntime.model || (CONFIG as any).zgInference?.model || process.env.ZG_MODEL || "",
      strictLive: STRICT_LIVE_ZG_REQUIRED,
    },
  });

  let findings: Finding[] = [];
  let usedFallback = false;
  let inferenceProviderAddress = zgRuntime.providerAddress || (CONFIG as any).zgInference?.providerAddress || process.env.ZG_PROVIDER_ADDRESS || "";
  let inferenceModel = zgRuntime.model || (CONFIG as any).zgInference?.model || process.env.ZG_MODEL || "";
  let inferenceRequestId: string | undefined;

  try {
    const analysis = await analyzeWithAI({
      contractAddress,
      contractType,
      estimatedLOC: loc,
      riskScore: 0,
      hasDepAnalysis,
    });
    findings = analysis.findings;
    usedFallback = analysis.usedFallback;
    inferenceProviderAddress = analysis.providerAddress || inferenceProviderAddress;
    inferenceModel = analysis.model || inferenceModel;
    inferenceRequestId = analysis.requestId;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const reasonCode = normalizeZgFailureReasonCode(err);
    await hcs.publishAuditLog({
      type: "LLM_INFERENCE_FAILED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        jobId,
        contractAddress,
        reasonCode,
        reason,
        providerAddress: inferenceProviderAddress,
        model: inferenceModel,
        strictLive: STRICT_LIVE_ZG_REQUIRED,
      },
    });
    log.warn(`LLM inference failed for job #${jobId}: ${reasonCode} ${reason}`);
    return;
  }

  if (STRICT_LIVE_ZG_REQUIRED && usedFallback) {
    const reason = "Strict live mode disallows mock fallback for LLM findings";
    await hcs.publishAuditLog({
      type: "LLM_INFERENCE_FAILED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        jobId,
        contractAddress,
        reasonCode: "zg_response_invalid",
        reason,
        providerAddress: inferenceProviderAddress,
        model: inferenceModel,
        strictLive: true,
      },
    });
    log.warn(reason);
    return;
  }
  if (usedFallback) {
    log.info("Used mock fallback for this audit cycle");
  }

  await hcs.publishAuditLog({
    type: "LLM_INFERENCE_SUCCEEDED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      jobId,
      contractAddress,
      findingsCount: findings.length,
      latencyMs: Date.now() - inferenceStartedAt,
      usedFallback,
      providerAddress: inferenceProviderAddress,
      model: inferenceModel,
      requestId: inferenceRequestId ?? null,
      strictLive: STRICT_LIVE_ZG_REQUIRED,
    },
  });

  const criticalCount = findings.filter((f) => f.severity === "critical").length;

  log.info(
    `Analysis complete: ${findings.length} findings [C:${criticalCount}]` +
    (hasDepAnalysis ? " (dep-informed)" : "")
  );

  const findingsHash = hashOf(findings);

  await hcs.publishAgentComms({
    type: "FINDINGS_SUBMITTED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      jobId,
      findingsHash,
      findingsCount: findings.length,
      criticalCount,
      highCount: findings.filter((f) => f.severity === "high").length,
      mediumCount: findings.filter((f) => f.severity === "medium").length,
      lowCount: findings.filter((f) => f.severity === "low").length,
      evmAddress,
      inferenceSource: usedFallback ? "mock" : "0g",
      providerAddress: inferenceProviderAddress,
      model: inferenceModel,
      requestId: inferenceRequestId,
      usedFallback,
    },
  });

  log.info(`Findings submitted. Hash: ${findingsHash.slice(0, 16)}...`);
}

function waitForSubResult(subAuctionId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSubResults.delete(subAuctionId);
      resolve(false);
    }, timeoutMs);

    pendingSubResults.set(subAuctionId, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
