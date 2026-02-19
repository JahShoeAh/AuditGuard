import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomInt,
  randomBool,
  hashOf,
  sleep,
} from "../shared/index.js";
import type { HCSMessage, SubAuctionPostedEvent } from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "dependency-analyzer-008";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const MAX_BACKLOG = 3;
let currentBacklog = 0;

const log = createAgentLogger(AGENT_ID, "dependency");

// ---- Bidding Logic ----

export function calculateSubBid(
  offeredPayment: number,
  currentBacklog: number
): { amount: number; estimatedTimeSec: number } {
  // Undercut strategy — bid less when not busy, less discount when loaded
  const discountFactor = currentBacklog > 2 ? 0.95 : 0.85;
  const amount = offeredPayment * discountFactor;
  const estimatedTimeSec = DEMO_MODE ? randomInt(10, 20) : randomInt(15, 45);

  return {
    amount: Math.round(amount * 100) / 100,
    estimatedTimeSec,
  };
}

// ---- Mock Analysis ----

export function generateDependencyAnalysis() {
  const riskFactors = [
    "unverified-proxy",
    "deprecated-oracle",
    "centralization-risk",
    "reentrancy-surface",
    "unaudited-dependency",
  ].filter(() => Math.random() > 0.5);

  return {
    dependencies: randomInt(3, 15),
    knownVulnerable: randomInt(0, 3),
    outdatedDeps: randomInt(0, 5),
    riskFactors,
    analysisHash: hashOf({ riskFactors, ts: Date.now() }),
  };
}

// ---- Main ----

async function main() {
  log.info("Dependency Analyzer Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");

  const wallet = createAgentWallet("DEPENDENCY");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  log.info(`Wallet: ${wallet.evmAddress}`);

  // Listen for sub-auction postings
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

    if (msg.type !== "SUB_AUCTION_POSTED") return;

    const subAuction = msg as SubAuctionPostedEvent;
    const { subAuctionId, taskType, paymentAmount, slaDurationSec, parentJobId } = subAuction.payload;

    if (taskType !== "dependency_analysis") {
      log.info(`Ignoring sub-auction ${subAuctionId}: taskType=${taskType}`);
      return;
    }

    log.info(
      `Sub-auction spotted: ${subAuctionId} ` +
      `(${paymentAmount} GUARD, ${slaDurationSec}s SLA, parent: ${String(parentJobId).slice(0, 10)}...)`
    );

    const bid = calculateSubBid(paymentAmount, currentBacklog);

    log.info(`Sub-bidding: ${bid.amount} GUARD (est. ${bid.estimatedTimeSec}s)`);

    // Submit sub-bid on-chain
    try {
      await contracts.submitSubBid(
        0,
        ethers.parseUnits(bid.amount.toString(), 8),
        bid.estimatedTimeSec,
        ethers.parseUnits((bid.amount * 0.5).toString(), 8), // 50% collateral
      );
      log.info("Sub-bid submitted on-chain");
    } catch (err) {
      log.warn(`On-chain sub-bid failed (continuing via HCS): ${err}`);
    }

    await hcs.publishAuditLog({
      type: "SUB_BID_SUBMITTED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        subAuctionId,
        bidAmount: bid.amount,
        parentJobId,
        evmAddress: wallet.evmAddress,
      },
    });

    // Auto-simulate being selected after a brief delay
    currentBacklog++;
    const analysisDelay = bid.estimatedTimeSec * 1000;

    setTimeout(async () => {
      try {
        log.info(`Performing dependency analysis for ${subAuctionId}...`);
        await sleep(analysisDelay);

        const result = generateDependencyAnalysis();

        log.info(
          `Analysis complete: ${result.dependencies} deps, ` +
          `${result.knownVulnerable} vulnerable, ` +
          `${result.riskFactors.length} risk factors`
        );

        // Deliver result on-chain
        try {
          await contracts.deliverResult(0, result.analysisHash);
          log.info("Result delivered on-chain");
        } catch (err) {
          log.warn(`On-chain delivery failed (continuing via HCS): ${err}`);
        }

        // Notify requester via HCS
        await hcs.publishAgentComms({
          type: "SUB_RESULT_DELIVERED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            subAuctionId,
            parentJobId,
            resultHash: result.analysisHash,
            dependencies: result.dependencies,
            knownVulnerable: result.knownVulnerable,
            outdatedDeps: result.outdatedDeps,
            riskFactors: result.riskFactors,
          },
        });

        await hcs.publishAuditLog({
          type: "SUB_RESULT_DELIVERED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { subAuctionId, resultHash: result.analysisHash },
        });
      } finally {
        currentBacklog = Math.max(0, currentBacklog - 1);
      }
    }, DEMO_MODE ? 5000 : 10000); // start analysis after brief delay
  });

  log.info("Subscribed to agent comms. Waiting for sub-auctions...");
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
