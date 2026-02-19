import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
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
import { callInference, ZGClientError, initZgClient } from "./zg-client.js";
import { buildMessages } from "./prompt-builder.js";
import { parseFindings } from "./response-parser.js";
import type { AuditContext } from "./prompt-builder.js";

// ---- Config ----
const AGENT_ID = "llm-contextual-003";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const SPECIALIZATIONS: ContractType[] = ["lending", "bridge", "dex"];
const BASE_REPUTATION = 87;
const MIN_RISK_SCORE = 50;       // only take complex jobs
const MIN_LOC = 1000;            // not worth my time below this
const SUB_CONTRACT_PAYMENT = 3;  // GUARD for dependency analysis
const SUB_CONTRACT_SLA = DEMO_MODE ? 120 : 900; // 2 min demo, 15 min prod
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;

const log = createAgentLogger(AGENT_ID, "llm_contextual");

// Pending sub-contract results
const pendingSubResults: Map<string, (result: SubResultDeliveredEvent) => void> = new Map();

// Track pending jobs awaiting winner selection
const pendingJobs = new Map<string, {
  contractAddress: string;
  contractType: ContractType;
  loc: number;
}>();

// Dynamic pricing state
let bidMultiplier = 1.0;
let totalBids = 0;
let totalWins = 0;
const PRICING_ALPHA = 0.3;

function updatePricingAfterOutcome(won: boolean) {
  totalBids++;
  if (won) totalWins++;
  const winRate = totalBids > 0 ? totalWins / totalBids : 0.5;
  const target = 0.45;
  bidMultiplier = bidMultiplier * (1 - PRICING_ALPHA) + (1 + (target - winRate)) * PRICING_ALPHA;
  bidMultiplier = Math.max(0.5, Math.min(2.0, bidMultiplier));
  log.info(`Dynamic pricing: winRate=${(winRate * 100).toFixed(0)}% multiplier=${bidMultiplier.toFixed(2)}`);
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

  return findings;
}

/** Backward-compatible alias so existing tests and callers keep working. */
export const generateFindings = generateMockFindings;

export interface InviteResolutionInput {
  queued?: {
    contractType: ContractType;
    loc: number;
    riskScore: number;
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
  if (process.env.ZG_ENABLED === "false") return false;
  const privateKey = process.env.ZG_PRIVATE_KEY ?? "";
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS ?? "";
  return privateKey.length > 0 && providerAddress.length > 0;
}

export async function analyzeWithAI(
  ctx: AuditContext
): Promise<{ findings: Finding[]; usedFallback: boolean }> {
  if (!isZgEnabled()) {
    log.info("[0g fallback] 0g inference disabled — using mock findings");
    return { findings: generateMockFindings(ctx.contractType, ctx.hasDepAnalysis), usedFallback: true };
  }

  const cfg = (CONFIG as any).zgInference ?? {};
  const model = cfg.model || process.env.ZG_MODEL || "qwen-2.5-7b-instruct";
  const messages = buildMessages(ctx);
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await callInference({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4000,
      });

      const result = parseFindings(raw, AGENT_ID, ctx.contractType);

      if (result.parseError) {
        log.warn(`[0g] Parse error (attempt ${attempt}): ${result.parseError}`);
        if (attempt < maxAttempts) continue;
        log.info("[0g fallback] All attempts failed to parse — using mock findings");
        return { findings: generateMockFindings(ctx.contractType, ctx.hasDepAnalysis), usedFallback: true };
      }

      log.info(`[0g] AI analysis complete: ${result.findings.length} findings`);
      return { findings: result.findings, usedFallback: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[0g] Inference error (attempt ${attempt}): ${errMsg}`);
      if (attempt < maxAttempts) {
        await sleep(2000);
        continue;
      }
    }
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

  log.info(`Wallet: ${wallet.evmAddress}`);

  // Initialize 0g inference broker (deposit funds, acknowledge provider)
  if (isZgEnabled()) {
    log.info("Initializing 0g Compute Network broker...");
    await initZgClient();
    log.info("0g broker ready");
  } else {
    log.info("0g inference disabled — will use mock fallback");
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

  // Queue discoveries until AUCTION_INVITE arrives with real jobId
  const discoveryQueue = new Map<string, {
    contractType: ContractType;
    loc: number;
    riskScore: number;
  }>();

  // Listen for sub-contract result deliveries + AUCTION_INVITE
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type === "SUB_RESULT_DELIVERED") {
      const result = msg as SubResultDeliveredEvent;
      const callback = pendingSubResults.get(result.payload.subAuctionId);
      if (callback) {
        callback(result);
        pendingSubResults.delete(result.payload.subAuctionId);
      }
    }

    if (msg.type === "AUCTION_INVITE") {
      const { jobId, contractAddress, contractType, riskScore, estimatedLOC, estimatedLineCount } = (msg as any).payload;
      const queued = discoveryQueue.get(contractAddress);
      if (queued) discoveryQueue.delete(contractAddress);

      const resolved = resolveAuctionInviteContext({
        queued,
        invite: { contractType, riskScore, estimatedLOC, estimatedLineCount },
      });

      // Keep premium gating behavior even when using invite fallback context.
      if (!shouldBid(resolved.loc, resolved.contractType, resolved.riskScore)) return;
      const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);

      log.info(`AUCTION_INVITE for job #${jobId} — premium bid ${bid.amount} GUARD`);

      try {
        const tx = await contracts.submitBid(
          jobId,
          ethers.parseUnits(bid.amount.toString(), 8),
          ethers.parseUnits(bid.collateral.toString(), 8),
          bid.estimatedTimeSec,
          SPECIALIZATIONS[0]
        );
        log.info(`On-chain bid submitted (tx: ${tx.hash?.slice(0, 14)}...)`);
      } catch (err) {
        log.warn(`On-chain bid failed (continuing via HCS): ${err}`);
      }

      pendingJobs.set(String(jobId), {
        contractAddress,
        contractType: resolved.contractType,
        loc: resolved.loc,
      });

      await hcs.publishAuditLog({
        type: "BID_SUBMITTED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          jobId,
          contractAddress,
          bidAmount: bid.amount,
          collateral: bid.collateral,
          estimatedTimeSec: bid.estimatedTimeSec,
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
            contractAddress,
            resolved.contractType,
            resolved.loc,
            hcs,
            contracts,
            wallet.evmAddress
          );
        }
      }, WINNER_WAIT_MS);
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

    simulateAuditCycle(pending.contractAddress, pending.contractType, pending.loc, hcs, contracts, wallet.evmAddress)
      .catch(err => log.error(`Audit cycle failed: ${err}`));
  });

  // Listen for discoveries — queue until AUCTION_INVITE arrives
  hcs.subscribeDiscovery(async (msg: HCSMessage) => {
    if (msg.type !== "CONTRACT_DISCOVERED") return;

    const discovery = msg as ContractDiscoveryEvent;
    const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

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
    });
  });

  log.info("Subscribed to discovery + agentComms. Waiting for high-value contracts...");
}

async function simulateAuditCycle(
  contractAddress: string,
  contractType: ContractType,
  loc: number,
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

    const subAuctionId = `sub-${Date.now()}-${randomInt(1000, 9999)}`;

    // Create sub-auction on-chain
    try {
      await contracts.createSubAuction(
        0, // parentJobId
        "Dependency analysis for audit job",  // taskDescription
        "dependency_analysis",                // requiredSpecialization
        ethers.parseUnits(SUB_CONTRACT_PAYMENT.toString(), 8),
        SUB_CONTRACT_SLA,
      );
      log.info("Sub-auction created on-chain");
    } catch (err) {
      log.warn(`On-chain sub-auction failed (continuing via HCS): ${err}`);
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
        parentJobId: contractAddress,
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
        parentJobId: contractAddress,
      },
    });

    // Wait for sub-contractor to deliver (with timeout)
    log.info("Waiting for dependency analysis delivery...");
    hasDepAnalysis = await waitForSubResult(subAuctionId, SUB_CONTRACT_SLA * 1000);

    if (hasDepAnalysis) {
      log.info("Dependency analysis received. Incorporating into audit.");

      // Accept result on-chain
      try {
        await contracts.acceptResult(0);
        log.info("Sub-result accepted on-chain");
      } catch (err) {
        log.warn(`On-chain accept failed (continuing): ${err}`);
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

  const { findings, usedFallback } = await analyzeWithAI({
    contractAddress,
    contractType,
    estimatedLOC: loc,
    riskScore: 0,
    hasDepAnalysis,
  });
  if (usedFallback) {
    log.info("Used mock fallback for this audit cycle");
  }
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
      jobId: contractAddress,
      findingsHash,
      findingsCount: findings.length,
      criticalCount,
      highCount: findings.filter((f) => f.severity === "high").length,
      mediumCount: findings.filter((f) => f.severity === "medium").length,
      lowCount: findings.filter((f) => f.severity === "low").length,
      evmAddress,
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
