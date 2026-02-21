import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  computeLiveBid,
  ensureBidCollateralBalance,
  getBidCollateralTopUpConfig,
  ensureOperationalHbar,
  getHbarTopUpConfig,
  isRetriableBidFailure,
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
  canonicalizeModelId,
} from "./zg-client.js";
import { buildMessages } from "./prompt-builder.js";
import { parseFindings } from "./response-parser.js";
import type { AuditContext } from "./prompt-builder.js";
import { loadContractSource } from "../shared/contract-source.js";

// ---- Config ----
const AGENT_ID = "llm-contextual-003";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
const SPECIALIZATIONS: ContractType[] = [
  "lending", "dex", "staking", "bridge", "vault",
  "derivatives", "oracle", "governance", "nft",
];
const BASE_REPUTATION = 87;
const MIN_RISK_SCORE = 50;       // only take complex jobs
const MIN_LOC = 1000;            // not worth my time below this
const SUB_CONTRACT_PAYMENT = 3;  // GUARD for dependency analysis
const SUB_CONTRACT_SLA = DEMO_MODE ? 120 : 900; // 2 min demo, 15 min prod
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;
const GUARD_DECIMALS = 8;
const ZG_REQUIRED_IN_LIVE =
  (process.env.ZG_REQUIRED_IN_LIVE ?? String((CONFIG as any).zgInference?.requiredInLive ?? true)) !== "false";
const NO_FALLBACK_MODE = (process.env.NO_FALLBACK_MODE ?? "true") === "true";
const STRICT_LIVE_ZG_REQUIRED = NO_FALLBACK_MODE || (STRICT_LIVE && !DEMO_MODE && ZG_REQUIRED_IN_LIVE);

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
const bidInFlightJobs = new Set<string>();
const bidSubmittedJobs = new Set<string>();
const BID_DEADLINE_SAFETY_MARGIN_MS = Number(process.env.BID_DEADLINE_SAFETY_MARGIN_MS ?? "15000");
const BID_SUBMIT_TIMEOUT_MS = Number(process.env.BID_SUBMIT_TIMEOUT_MS ?? "20000");

type BidQueueTask = {
  jobId: string;
  enqueueAt: number;
  contractAddress: string;
  deadlineHintSec: number | null;
  execute: () => Promise<void>;
};

type EnqueuedBidQueueTask = BidQueueTask & {
  resolve: () => void;
  reject: (error: unknown) => void;
};

const bidQueue: EnqueuedBidQueueTask[] = [];
let bidQueueInFlight = false;
const zgRuntime = {
  providerAddress: "",
  model: "",
  endpoint: "",
};

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(label)), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function normalizeDeadlineHintSec(value: unknown): number | null {
  const deadline = Number(value);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return Math.floor(deadline);
}

function getRemainingMsFromDeadline(deadlineSec: number | null): number {
  if (!Number.isFinite(Number(deadlineSec)) || Number(deadlineSec) <= 0) return Number.POSITIVE_INFINITY;
  return (Number(deadlineSec) * 1000) - Date.now();
}

async function getBidWindowSnapshot(
  contracts: ContractClient,
  jobId: string,
  deadlineHintSec: number | null
): Promise<{ remainingMs: number; reasonCode: string }> {
  let effectiveDeadlineSec = normalizeDeadlineHintSec(deadlineHintSec);
  let jobState: number | null = null;
  try {
    const auction = await contracts.getAuction(jobId);
    const chainDeadlineSec = normalizeDeadlineHintSec(auction?.deadline ?? null);
    if (chainDeadlineSec != null) effectiveDeadlineSec = chainDeadlineSec;
    const state = Number(auction?.jobState ?? NaN);
    if (Number.isFinite(state)) jobState = Math.floor(state);
  } catch {
    // Fall back to invite hint only.
  }

  if (jobState != null && jobState !== 0) {
    return { remainingMs: 0, reasonCode: "auction_not_open" };
  }

  const remainingMs = getRemainingMsFromDeadline(effectiveDeadlineSec);
  if (remainingMs <= BID_DEADLINE_SAFETY_MARGIN_MS) {
    return { remainingMs, reasonCode: "deadline_window_exhausted" };
  }
  return { remainingMs, reasonCode: "ok" };
}

async function drainBidQueue(hcs: HCSClient, contracts: ContractClient): Promise<void> {
  if (bidQueueInFlight) return;
  bidQueueInFlight = true;
  try {
    while (bidQueue.length > 0) {
      const task = bidQueue.shift();
      if (!task) continue;
      try {
        const window = await getBidWindowSnapshot(contracts, task.jobId, task.deadlineHintSec);
        if (window.reasonCode !== "ok") {
          await hcs.publishAuditLog({
            type: "BID_QUEUE_DROPPED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              jobId: task.jobId,
              contractAddress: task.contractAddress,
              reasonCode: window.reasonCode,
              remainingMs: window.remainingMs,
              queuedForMs: Date.now() - task.enqueueAt,
            },
          });
          task.resolve();
          continue;
        }
        await task.execute();
        task.resolve();
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    bidQueueInFlight = false;
  }
}

function queueBidSubmission(
  task: BidQueueTask,
  hcs: HCSClient,
  contracts: ContractClient
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    bidQueue.push({ ...task, resolve, reject });
    void drainBidQueue(hcs, contracts);
  });
}

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
  if (message.includes("@0glabs/0g-serving-broker")) return "missing_runtime_dependency";
  if (message.includes("does not provide an export named")) return "zg_broker_module_interop_error";
  if (message.includes("model not supported")) return "zg_model_mismatch";
  if (message.includes("configured model") && message.includes("provider")) return "zg_model_mismatch";
  if (message.includes("timeout")) return "zg_timeout";
  if (message.includes("metadata")) return "zg_provider_metadata_failed";
  if (message.includes("header")) return "zg_request_headers_failed";
  if (message.includes("ack")) return "zg_provider_ack_failed";
  if (message.includes("ledger")) return "zg_ledger_unfunded";
  return "zg_http_error";
}

function formatZgStartupFailure(reasonCode: string, reason: string): string {
  if (reasonCode === "missing_runtime_dependency") {
    return (
      "Startup blocked: missing runtime dependency '@0glabs/0g-serving-broker'. " +
      "Run `npm --workspace agents install` then retry."
    );
  }
  if (reasonCode === "zg_broker_module_interop_error") {
    return (
      "Startup blocked: 0g broker module interop error. " +
      "Set `ZG_BROKER_LOADER_MODE=auto` (recommended) or update @0glabs/0g-serving-broker."
    );
  }
  return `Strict live startup blocked: ${reasonCode}: ${reason}`;
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
  modelAutoCorrected?: boolean;
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
  const requestedModel =
    zgRuntime.model ||
    cfg.model ||
    process.env.ZG_MODEL ||
    "";
  const messages = buildMessages(ctx);
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const inference = await infer({
        model: requestedModel,
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
        modelAutoCorrected: inference.modelAutoCorrected,
      };
    } catch (err) {
      const reasonCode = normalizeZgFailureReasonCode(err);
      if (reasonCode === "missing_runtime_dependency") {
        throw err;
      }
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
        model: canonicalizeModelId((CONFIG as any).zgInference?.model ?? process.env.ZG_MODEL ?? ""),
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
          model: canonicalizeModelId((CONFIG as any).zgInference?.model ?? process.env.ZG_MODEL ?? ""),
          dependency:
            reasonCode === "missing_runtime_dependency"
              ? "@0glabs/0g-serving-broker"
              : undefined,
        },
      });
      if (reasonCode === "missing_runtime_dependency" || STRICT_LIVE_ZG_REQUIRED) {
        throw new Error(formatZgStartupFailure(reasonCode, reason));
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
  if (!DEMO_MODE) {
    const topUpConfig = getBidCollateralTopUpConfig();
    log.info(
      `Collateral auto-top-up: ${topUpConfig.enabled ? "enabled" : "disabled"} ` +
      `(donors=${topUpConfig.donorsConfigured})`
    );
    if (topUpConfig.donorAddressesMasked.length > 0) {
      log.info(`Collateral donors: ${topUpConfig.donorAddressesMasked.join(", ")}`);
    }
    if (topUpConfig.donorWarning) {
      log.warn(`Collateral auto-top-up config: ${topUpConfig.donorWarning}`);
    }
    const hbarTopUpConfig = getHbarTopUpConfig();
    log.info(
      `Payer HBAR auto-top-up: ${hbarTopUpConfig.enabled ? "enabled" : "disabled"} ` +
      `(donors=${hbarTopUpConfig.donorsConfigured}, min=${ethers.formatEther(hbarTopUpConfig.minRequiredWei)} HBAR)`
    );
    if (hbarTopUpConfig.donorAddressesMasked.length > 0) {
      log.info(`HBAR donors: ${hbarTopUpConfig.donorAddressesMasked.join(", ")}`);
    }
    if (hbarTopUpConfig.donorWarning) {
      log.warn(`HBAR auto-top-up config: ${hbarTopUpConfig.donorWarning}`);
    }
  }

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
    let startupActive = false;

    try {
      startupActive = await contracts.isActiveAgent(wallet.evmAddress);
      if (!startupActive) {
        log.warn("Startup preflight: wallet is not an active on-chain agent");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: active-agent check failed: ${error}`);
      if (NO_FALLBACK_MODE) {
        throw new Error(
          `Startup preflight failed: cannot verify active on-chain agent status (${error}). ` +
          `Run 'npm run activate:live-agents' and retry.`
        );
      }
    }

    if (NO_FALLBACK_MODE && !startupActive) {
      throw new Error(
        "Startup preflight failed: wallet is not an active on-chain agent. " +
        "Run 'npm run activate:live-agents' and retry."
      );
    }
  }

  if (!DEMO_MODE) {
    let startupAllowanceOk = true;
    let startupCollateralOk = true;
    let startupHbarOk = true;
    const hbarTopUpConfig = getHbarTopUpConfig();

    const startupHbar = await ensureOperationalHbar({
      contracts,
      recipientAddress: wallet.evmAddress,
      requiredWei: hbarTopUpConfig.minRequiredWei,
      logger: log,
    });
    if (!startupHbar.ok) {
      startupHbarOk = false;
      log.warn(
        `Startup preflight: ${startupHbar.reason ?? "Insufficient payer HBAR for transaction fees"}`
      );
    } else if (startupHbar.toppedUpWei > 0n) {
      log.info(
        `Startup preflight: topped up ${ethers.formatEther(startupHbar.toppedUpWei)} HBAR`
      );
    }

    const startupCollateral = await ensureBidCollateralBalance({
      contracts,
      recipientAddress: wallet.evmAddress,
      requiredWei: minBidCollateralWei,
      logger: log,
    });
    if (!startupCollateral.ok) {
      startupCollateralOk = false;
      log.warn(
        `Startup preflight: ${startupCollateral.reason ?? "Insufficient GUARD balance for bid collateral"}`
      );
    } else if (startupCollateral.toppedUpWei > 0n) {
      log.info(
        `Startup preflight: topped up ${ethers.formatUnits(startupCollateral.toppedUpWei, GUARD_DECIMALS)} GUARD`
      );
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
      startupAllowanceOk = false;
    }

    if (NO_FALLBACK_MODE && !startupCollateralOk) {
      throw new Error(
        "Startup preflight failed: insufficient GUARD collateral and auto top-up could not satisfy minimum. " +
        "Run 'npm run activate:live-agents' and retry."
      );
    }
    if (NO_FALLBACK_MODE && !startupHbarOk) {
      throw new Error(
        "Startup preflight failed: insufficient payer HBAR and auto top-up could not satisfy minimum. " +
        "Run 'npm run activate:live-agents' and retry."
      );
    }
    if (NO_FALLBACK_MODE && !startupAllowanceOk) {
      throw new Error(
        "Startup preflight failed: could not set GUARD allowance for AuditAuction. " +
        "Run 'npm run activate:live-agents' and retry."
      );
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
      const {
        jobId,
        contractAddress,
        contractType,
        riskScore,
        estimatedLOC,
        estimatedLineCount,
        budget,
        auctionDeadlineSec,
        eligibleAgentIds,
        eligibleEvmAddresses,
      } = (msg as any).payload;
      const targetedIds = Array.isArray(eligibleAgentIds) ? eligibleAgentIds.map((v: unknown) => String(v)) : [];
      const targetedAddresses = Array.isArray(eligibleEvmAddresses)
        ? eligibleEvmAddresses.map((v: unknown) => String(v).toLowerCase())
        : [];
      if (targetedIds.length > 0 || targetedAddresses.length > 0) {
        const myAddress = wallet.evmAddress.toLowerCase();
        if (!targetedIds.includes(AGENT_ID) && !targetedAddresses.includes(myAddress)) {
          return;
        }
      }
      const jobKey = String(jobId);
      if (bidSubmittedJobs.has(jobKey) || pendingJobs.has(jobKey)) {
        log.info(`Skipping duplicate AUCTION_INVITE for job #${jobKey} (already bid)`);
        return;
      }
      if (bidInFlightJobs.has(jobKey)) {
        log.info(`Skipping duplicate AUCTION_INVITE for job #${jobKey} (bid submission in flight)`);
        return;
      }
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

      const strictLiveBid = STRICT_LIVE && !DEMO_MODE;
      bidInFlightJobs.add(jobKey);
      try {
        if (strictLiveBid) {
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
                strictLive: strictLiveBid,
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
                strictLive: strictLiveBid,
                evmAddress: wallet.evmAddress,
              },
            });
            return;
          }
        }

        if (!DEMO_MODE) {
          const hbarTopUpConfig = getHbarTopUpConfig();
          const payerReady = await ensureOperationalHbar({
            contracts,
            recipientAddress: wallet.evmAddress,
            requiredWei: hbarTopUpConfig.minRequiredWei,
            logger: log,
          });
          if (!payerReady.ok) {
            await hcs.publishAuditLog({
              type: "BID_SKIPPED",
              agentId: AGENT_ID,
              timestamp: Date.now(),
              payload: {
                jobId: String(jobId),
                contractAddress,
                reason: payerReady.reason ?? "Insufficient payer HBAR for transaction fees",
                reasonCode: payerReady.reasonCode ?? "insufficient_payer_hbar",
                computedBid: finalBid.amount,
                computedCollateral: finalBid.collateral,
                budget: finalBid.inviteBudget ?? Number(budget ?? 0),
                strictLive: strictLiveBid,
                evmAddress: wallet.evmAddress,
                hbarBalance: ethers.formatEther(payerReady.balanceWei),
                autoTopUpAttempted: payerReady.attemptedTopUp,
                topUpSources: payerReady.donorAddressesUsed ?? [],
              },
            });
            return;
          }
          if (payerReady.toppedUpWei > 0n) {
            log.info(
              `Auto top-up applied before bid: +${ethers.formatEther(payerReady.toppedUpWei)} HBAR`
            );
          }

          const collateralReady = await ensureBidCollateralBalance({
            contracts,
            recipientAddress: wallet.evmAddress,
            requiredWei: finalBid.collateralWei,
            logger: log,
          });
          if (!collateralReady.ok) {
            await hcs.publishAuditLog({
              type: "BID_SKIPPED",
              agentId: AGENT_ID,
              timestamp: Date.now(),
              payload: {
                jobId: String(jobId),
                contractAddress,
                reason: collateralReady.reason ?? "Insufficient GUARD balance for bid collateral",
                reasonCode: collateralReady.attemptedTopUp
                  ? "insufficient_collateral_balance_after_topup"
                  : "insufficient_collateral_balance",
                computedBid: finalBid.amount,
                computedCollateral: finalBid.collateral,
                budget: finalBid.inviteBudget ?? Number(budget ?? 0),
                strictLive: strictLiveBid,
                evmAddress: wallet.evmAddress,
                availableCollateral: Number(ethers.formatUnits(collateralReady.balanceWei, GUARD_DECIMALS)),
                autoTopUpAttempted: collateralReady.attemptedTopUp,
                topUpSources: collateralReady.donorAddressesUsed ?? [],
              },
            });
            return;
          }
          if (collateralReady.toppedUpWei > 0n) {
            log.info(
              `Auto top-up applied before bid: +${ethers.formatUnits(collateralReady.toppedUpWei, GUARD_DECIMALS)} GUARD`
            );
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
                strictLive: strictLiveBid,
                evmAddress: wallet.evmAddress,
              },
            });
            return;
          }
        }

        let submittedOnChain = false;
        let alreadyBidOnChain = false;
        const deadlineHint = normalizeDeadlineHintSec(auctionDeadlineSec);
        await queueBidSubmission(
          {
            jobId: jobKey,
            enqueueAt: Date.now(),
            contractAddress,
            deadlineHintSec: deadlineHint,
            execute: async () => {
              alreadyBidOnChain = await contracts.hasAgentBid(jobId, wallet.evmAddress);
              if (alreadyBidOnChain) return;

              // Add jitter to avoid race conditions between competing agents.
              const jitter = randomInt(1000, 5000);
              log.info(`Waiting ${jitter}ms jitter before bidding...`);
              await sleep(jitter);

              const maxAttempts = 3;
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                  const tx = await withTimeout(
                    contracts.submitBid(
                      jobId,
                      finalBid.amountWei,
                      finalBid.collateralWei,
                      finalBid.estimatedTimeSec,
                      SPECIALIZATIONS[0]
                    ),
                    BID_SUBMIT_TIMEOUT_MS,
                    `submitBid timeout after ${BID_SUBMIT_TIMEOUT_MS}ms`
                  );
                  log.info(`On-chain bid submitted (tx: ${tx.hash?.slice(0, 14)}...)`);
                  submittedOnChain = true;
                  return;
                } catch (err) {
                  const error = err instanceof Error ? err.message : String(err);
                  const reasonCode = normalizeBidFailureReasonCode(error);
                  if (reasonCode === "duplicate_bid") {
                    alreadyBidOnChain = true;
                    return;
                  }
                  const ambiguousFailure = /timeout/i.test(error) || isRetriableBidFailure(error);
                  if (ambiguousFailure) {
                    try {
                      alreadyBidOnChain = await contracts.hasAgentBid(jobId, wallet.evmAddress);
                    } catch {
                      // Continue into retry path below.
                    }
                    if (alreadyBidOnChain) return;
                  }

                  const window = await getBidWindowSnapshot(contracts, jobKey, deadlineHint);
                  if (window.reasonCode !== "ok") {
                    await hcs.publishAuditLog({
                      type: "BID_LATE_DROP",
                      agentId: AGENT_ID,
                      timestamp: Date.now(),
                      payload: {
                        jobId: jobKey,
                        contractAddress,
                        reasonCode: window.reasonCode,
                        remainingMs: window.remainingMs,
                        attempt,
                      },
                    });
                    return;
                  }

                  const payerFailure =
                    reasonCode === "insufficient_payer_hbar" ||
                    error.toLowerCase().includes("insufficient funds for transfer");
                  if (payerFailure && attempt < maxAttempts) {
                    const recoveredPayer = await ensureOperationalHbar({
                      contracts,
                      recipientAddress: wallet.evmAddress,
                      requiredWei: getHbarTopUpConfig().minRequiredWei,
                      logger: log,
                    });
                    if (recoveredPayer.ok) {
                      if (recoveredPayer.toppedUpWei > 0n) {
                        log.info(
                          `Recovered payer gas before retry: +${ethers.formatEther(recoveredPayer.toppedUpWei)} HBAR`
                        );
                      }
                      await sleep(300 * attempt);
                      continue;
                    }
                  }
                  const errorLower = error.toLowerCase();
                  const collateralFailure =
                    !DEMO_MODE &&
                    (
                      reasonCode === "insufficient_funds" ||
                      errorLower.includes("collateral") ||
                      errorLower.includes("allowance") ||
                      errorLower.includes("transfer amount exceeds balance") ||
                      errorLower.includes("insufficient guard")
                    );
                  if (collateralFailure && attempt < maxAttempts) {
                    const recoveredCollateral = await ensureBidCollateralBalance({
                      contracts,
                      recipientAddress: wallet.evmAddress,
                      requiredWei: finalBid.collateralWei,
                      logger: log,
                    });
                    if (recoveredCollateral.ok) {
                      if (recoveredCollateral.toppedUpWei > 0n) {
                        log.info(
                          `Recovered collateral before retry: +${ethers.formatUnits(recoveredCollateral.toppedUpWei, GUARD_DECIMALS)} GUARD`
                        );
                      }
                      const approvalTx = await contracts.ensureGuardAllowance(
                        contracts.getAuctionAddress(),
                        finalBid.collateralWei
                      );
                      if (approvalTx) {
                        await approvalTx.wait?.();
                      }
                      await sleep(300 * attempt);
                      continue;
                    }
                  }
                  const retriable = isRetriableBidFailure(error) || /timeout/i.test(error);
                  if (!retriable || attempt === maxAttempts) {
                    throw err;
                  }
                  log.warn(
                    `Transient bid submit failure for job #${jobId} ` +
                    `(attempt ${attempt}/${maxAttempts}): ${error}`
                  );
                  await sleep(300 * attempt);
                }
              }
            },
          },
          hcs,
          contracts
        );

        if (alreadyBidOnChain) {
          bidSubmittedJobs.add(jobKey);
          log.info(`On-chain bid already exists for job #${jobKey}; skipping duplicate submit`);
          return;
        }
        if (!submittedOnChain) return;

        bidSubmittedJobs.add(jobKey);
        pendingJobs.set(jobKey, {
          jobId: jobKey,
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
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const reasonCode = normalizeBidFailureReasonCode(error);
        if (reasonCode === "duplicate_bid") {
          bidSubmittedJobs.add(jobKey);
        }
        log.warn(`On-chain bid failed: ${error}`);
        await hcs.publishAuditLog({
          type: "BID_SUBMISSION_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            jobId: String(jobId),
            contractAddress,
            strictLive: STRICT_LIVE && !DEMO_MODE,
            error,
            reasonCode,
            guardBalance: Number(ethers.formatUnits(await contracts.getGuardBalance(wallet.evmAddress), GUARD_DECIMALS)),
            hbarBalance: ethers.formatEther(await contracts.wallet.provider.getBalance(wallet.evmAddress)),
          },
        });
        return;
      } finally {
        bidInFlightJobs.delete(jobKey);
      }

      return;
    }

  });

  // Listen for winner selection events on-chain
  contracts.onWinnerSelected((jobId, winners, totalEscrowed, platformFee) => {
    const jobKey = jobId.toString();
    const pending = pendingJobs.get(jobKey);
    const hadSubmittedBid = bidSubmittedJobs.has(jobKey);
    if (!pending && !hadSubmittedBid) return;

    const myAddress = wallet.evmAddress.toLowerCase();
    const isWinner = winners.some((w) => String(w).toLowerCase() === myAddress);

    pendingJobs.delete(jobKey);
    bidSubmittedJobs.delete(jobKey);

    if (!isWinner) {
      log.info(`LOST auction for job #${jobKey}; cleared local bid state`);
      return;
    }
    if (!pending) return;

    log.info(`WON auction for job #${jobKey}! Premium contract.`);
    updatePricingAfterOutcome(true);

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

  contracts.onJobCancelled((jobId) => {
    const jobKey = jobId.toString();
    const clearedPending = pendingJobs.delete(jobKey);
    const clearedSubmittedBid = bidSubmittedJobs.delete(jobKey);
    if (clearedPending || clearedSubmittedBid) {
      log.info(`Job #${jobKey} cancelled on-chain; cleared local bid state`);
    }
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
      model: canonicalizeModelId(zgRuntime.model || (CONFIG as any).zgInference?.model || process.env.ZG_MODEL || ""),
      strictLive: STRICT_LIVE_ZG_REQUIRED,
    },
  });

  let findings: Finding[] = [];
  let usedFallback = false;
  let inferenceProviderAddress = zgRuntime.providerAddress || (CONFIG as any).zgInference?.providerAddress || process.env.ZG_PROVIDER_ADDRESS || "";
  let inferenceModel = canonicalizeModelId(
    zgRuntime.model || (CONFIG as any).zgInference?.model || process.env.ZG_MODEL || ""
  );
  let inferenceRequestId: string | undefined;
  let inferenceModelAutoCorrected = false;

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
    inferenceModelAutoCorrected = analysis.modelAutoCorrected === true;
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
        modelAutoCorrected: inferenceModelAutoCorrected,
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
      modelAutoCorrected: inferenceModelAutoCorrected,
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
