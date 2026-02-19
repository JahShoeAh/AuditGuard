import {
  HCSClient,
  ContractClient,
  ListingCategory,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomInt,
  randomBool,
  randomFloat,
  randomSeveritySkewedLow,
  randomFindingTitle,
  hashOf,
  sleep,
} from "../shared/index.js";
import type {
  ContractDiscoveryEvent,
  ContractType,
  Finding,
  HCSMessage,
} from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "static-analysis-047";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const SPECIALIZATIONS: ContractType[] = ["lending", "vault", "staking"];
const BASE_REPUTATION = 75;
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;

const log = createAgentLogger(AGENT_ID, "static_analysis");

// Track pending jobs awaiting winner selection
const pendingJobs = new Map<string, {
  contractAddress: string;
  contractType: ContractType;
  loc: number;
}>();

// Dynamic pricing state — EMA of win rate adjusts bid multiplier
let bidMultiplier = 1.0;
let totalBids = 0;
let totalWins = 0;
const PRICING_ALPHA = 0.3; // EMA smoothing factor

function updatePricingAfterOutcome(won: boolean) {
  totalBids++;
  if (won) totalWins++;
  const winRate = totalBids > 0 ? totalWins / totalBids : 0.5;
  // Win rate > 0.6 means we're too cheap, raise prices; < 0.3 means too expensive, lower
  const target = 0.45;
  bidMultiplier = bidMultiplier * (1 - PRICING_ALPHA) + (1 + (target - winRate)) * PRICING_ALPHA;
  bidMultiplier = Math.max(0.5, Math.min(2.0, bidMultiplier));
  log.info(`Dynamic pricing: winRate=${(winRate * 100).toFixed(0)}% multiplier=${bidMultiplier.toFixed(2)}`);
}

// ---- Bidding Logic ----

export function calculateBid(
  estimatedLOC: number,
  contractType: ContractType,
  riskScore: number
): { amount: number; collateral: number; estimatedTimeSec: number } | null {
  let bid = (10 + estimatedLOC * 0.002) * bidMultiplier;

  if (SPECIALIZATIONS.includes(contractType)) {
    bid *= 0.9;
  }

  const collateral = bid * 0.5;
  const estimatedTimeSec = DEMO_MODE ? randomInt(10, 30) : randomInt(30, 120);

  return {
    amount: Math.round(bid * 100) / 100,
    collateral: Math.round(collateral * 100) / 100,
    estimatedTimeSec,
  };
}

// ---- Mock Audit ----

export function generateFindings(contractType: ContractType, loc: number): Finding[] {
  const count = randomInt(3, 10);
  const findings: Finding[] = [];

  for (let i = 0; i < count; i++) {
    findings.push({
      id: `SA-${String(i + 1).padStart(3, "0")}`,
      severity: randomSeveritySkewedLow(),
      title: randomFindingTitle(contractType),
      description: `Static analysis finding in ${contractType} contract (${loc} LOC)`,
      confidence: randomFloat(0.6, 0.95),
      agentId: AGENT_ID,
      timestamp: Date.now(),
    });
  }

  return findings;
}

export interface InviteResolutionInput {
  queued?: {
    contractType: ContractType;
    loc: number;
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
  const riskScore = Number(invite.riskScore ?? 50);
  return { contractType, loc, riskScore };
}

// ---- Main ----

async function main() {
  log.info("Static Analysis Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");
  log.info(`Specializations: ${SPECIALIZATIONS.join(", ")}`);

  const wallet = createAgentWallet("STATIC");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  log.info(`Wallet: ${wallet.evmAddress}`);

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

  // Map contractAddress → { jobId, contractType, loc } for pending discoveries
  const discoveryQueue = new Map<string, {
    contractType: ContractType;
    loc: number;
  }>();

  // Listen for AUCTION_INVITE from orchestrator (carries real jobId)
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type !== "AUCTION_INVITE") return;
    const { jobId, contractAddress, contractType, riskScore, estimatedLOC, estimatedLineCount } = (msg as any).payload;
    const queued = discoveryQueue.get(contractAddress);
    if (queued) discoveryQueue.delete(contractAddress);

    const resolved = resolveAuctionInviteContext({
      queued,
      invite: { contractType, riskScore, estimatedLOC, estimatedLineCount },
    });
    const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);
    if (!bid) return;

    log.info(`AUCTION_INVITE for job #${jobId} — bidding ${bid.amount} GUARD`);

    // Submit bid on-chain with real jobId
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

    // Track for winner selection
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
        evmAddress: wallet.evmAddress,
      },
    });

    // Auto-simulate fallback if no winner event arrives
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
  });

  // Listen for winner selection events on-chain
  contracts.onWinnerSelected((jobId, winners, totalEscrowed, platformFee) => {
    const myAddress = wallet.evmAddress.toLowerCase();
    const winnerIndex = winners.findIndex(w => w.toLowerCase() === myAddress);
    if (winnerIndex === -1) return;

    const jobKey = jobId.toString();
    const pending = pendingJobs.get(jobKey);
    if (!pending) return;

    log.info(`WON auction for job #${jobKey}!`);
    updatePricingAfterOutcome(true);
    pendingJobs.delete(jobKey);

    simulateAuditCycle(pending.contractAddress, pending.contractType, pending.loc, hcs, contracts, wallet.evmAddress)
      .catch(err => log.error(`Audit cycle failed: ${err}`));
  });

  // Listen for contract discovery events — queue them for when AUCTION_INVITE arrives
  hcs.subscribeDiscovery(async (msg: HCSMessage) => {
    if (msg.type !== "CONTRACT_DISCOVERED") return;

    const discovery = msg as ContractDiscoveryEvent;
    const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

    log.info(
      `Evaluating: ${contractAddress.slice(0, 10)}... ` +
      `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
    );

    const bid = calculateBid(estimatedLOC, contractType, riskScore);
    if (!bid) return;

    log.info(`Queuing bid intent: ${bid.amount} GUARD — waiting for AUCTION_INVITE`);

    // Queue this discovery; actual bid submitted when AUCTION_INVITE arrives with jobId
    discoveryQueue.set(contractAddress, {
      contractType,
      loc: estimatedLOC,
    });
  });

  log.info("Subscribed to discovery + agentComms. Waiting for contracts...");
}

async function simulateAuditCycle(
  contractAddress: string,
  contractType: ContractType,
  loc: number,
  hcs: HCSClient,
  contracts: ContractClient,
  evmAddress: string
) {
  const auditTime = DEMO_MODE ? randomInt(10, 30) : randomInt(30, 120);
  log.info(`Running static analysis... (${auditTime}s)`);
  await sleep(auditTime * 1000);

  const findings = generateFindings(contractType, loc);
  const criticalCount = findings.filter((f) => f.severity === "critical").length;

  log.info(
    `Analysis complete: ${findings.length} findings [C:${criticalCount}]`
  );

  // Submit findings hash to report agent via HCS
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

  // ── Day 2: Sell scan report on DataMarketplace for 0.5 GUARD ──
  const reportPrice = ethers.parseUnits("0.5", 8);
  try {
    await contracts.createListing(
      0,                                 // parentJobId
      `Scan report: ${contractType}`,     // title
      `Static analysis report for ${contractAddress.slice(0, 12)}...`, // description
      ListingCategory.SCAN_REPORT,        // category (uint8)
      reportPrice,                        // price
      findingsHash,                       // contentHash (bytes32)
    );
    log.info("Scan report listed on DataMarketplace for 0.5 GUARD");
  } catch (err) {
    log.warn(`DataMarketplace listing failed (continuing): ${err}`);
  }

  await hcs.publishAgentComms({
    type: "DATA_LISTING_CREATED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      category: "SCAN_REPORT",
      price: 0.5,
      description: `Static analysis report for ${contractType} contract`,
      jobId: contractAddress,
    },
  });
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
