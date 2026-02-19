import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomInt,
  randomBool,
  randomFloat,
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
} from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "fuzzer-012";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const SPECIALIZATIONS: ContractType[] = ["dex", "bridge"];
const BASE_REPUTATION = 82;
const MAX_DATA_PURCHASE_PRICE = 1.0; // GUARD
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;

const log = createAgentLogger(AGENT_ID, "fuzzer");

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

// Track available data listings for purchase
const availableReports = new Map<string, {
  listingId: string;
  price: number;
  seller: string;
  jobId: string;
}>();

// ---- Bidding Logic ----

export function calculateBid(
  estimatedLOC: number,
  contractType: ContractType,
  riskScore: number
): { amount: number; collateral: number; estimatedTimeSec: number } | null {
  let bid = (15 + estimatedLOC * 0.005) * bidMultiplier;

  if (riskScore > 70) {
    bid *= 1.2; // complex = charge more
  }

  if (SPECIALIZATIONS.includes(contractType)) {
    log.info(`Specialization match (${contractType}), applying 15% discount`);
    bid *= 0.85;
  }

  const collateral = bid * 0.6;
  const estimatedTimeSec = DEMO_MODE ? randomInt(15, 45) : randomInt(30, 90);

  return {
    amount: Math.round(bid * 100) / 100,
    collateral: Math.round(collateral * 100) / 100,
    estimatedTimeSec,
  };
}

// ---- Mock Audit ----

export function generateFindings(contractType: ContractType, hasExternalData: boolean): Finding[] {
  const count = randomInt(2, 6);
  const findings: Finding[] = [];

  for (let i = 0; i < count; i++) {
    findings.push({
      id: `FZ-${String(i + 1).padStart(3, "0")}`,
      severity: randomSeveritySkewedHigh(),
      title: randomFindingTitle(contractType),
      description: `Fuzz testing finding${hasExternalData ? " (optimized with external data)" : ""}`,
      confidence: randomFloat(0.7, 0.98),
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
  const contractType = (queued?.contractType ?? invite.contractType ?? "dex") as ContractType;
  const loc = Number(queued?.loc ?? invite.estimatedLOC ?? invite.estimatedLineCount ?? 1200);
  const riskScore = Number(invite.riskScore ?? 50);
  return { contractType, loc, riskScore };
}

// ---- Main ----

async function main() {
  log.info("Fuzzer Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");
  log.info(`Specializations: ${SPECIALIZATIONS.join(", ")}`);
  log.info(`Max data purchase price: ${MAX_DATA_PURCHASE_PRICE} GUARD`);

  const wallet = createAgentWallet("FUZZER");
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

  // Queue discoveries until AUCTION_INVITE arrives with real jobId
  const discoveryQueue = new Map<string, {
    contractType: ContractType;
    loc: number;
  }>();

  // Listen for data listings + AUCTION_INVITE from other agents / orchestrator
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

    if (msg.type === "DATA_LISTING_CREATED" && msg.agentId !== AGENT_ID) {
      const { listingId, price, description, jobId, category } = msg.payload as any;
      if (category === "SCAN_REPORT" && price <= MAX_DATA_PURCHASE_PRICE) {
        log.info(`Scan report available from ${msg.agentId}: ${price} GUARD`);
        availableReports.set(jobId, {
          listingId,
          price,
          seller: msg.agentId,
          jobId,
        });
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
      const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);
      if (!bid) return;

      log.info(`AUCTION_INVITE for job #${jobId} — bidding ${bid.amount} GUARD`);

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

    log.info(`WON auction for job #${jobKey}!`);
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

    const bid = calculateBid(estimatedLOC, contractType, riskScore);
    if (!bid) return;

    log.info(`Queuing bid intent: ${bid.amount} GUARD — waiting for AUCTION_INVITE`);
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
  let hasExternalData = false;

  // ── Day 2: Try to buy scan report from DataMarketplace ──
  const affordableReport = availableReports.get(contractAddress);
  if (affordableReport) {
    log.info(
      `Purchasing scan from ${affordableReport.seller}: ` +
      `${affordableReport.price} GUARD (listing ${affordableReport.listingId})`
    );

    try {
      await contracts.purchaseData(Number(affordableReport.listingId));
      hasExternalData = true;
      log.info("Report purchased — optimizing fuzzing");

      await hcs.publishAuditLog({
        type: "DATA_PURCHASED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          listingId: affordableReport.listingId,
          seller: affordableReport.seller,
          price: affordableReport.price,
        },
      });
    } catch (err) {
      log.warn(`Purchase failed (continuing without data): ${err}`);
    }

    availableReports.delete(contractAddress);
  }

  // Fuzz with optional time reduction from purchased data
  const baseTime = DEMO_MODE ? randomInt(15, 45) : randomInt(30, 90);
  const auditTime = hasExternalData ? Math.round(baseTime * 0.8) : baseTime;
  log.info(`Running fuzz testing... (${auditTime}s${hasExternalData ? " — optimized" : ""})`);
  await sleep(auditTime * 1000);

  const findings = generateFindings(contractType, hasExternalData);
  const criticalCount = findings.filter((f) => f.severity === "critical").length;

  log.info(
    `Testing complete: ${findings.length} findings [C:${criticalCount}]`
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

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
