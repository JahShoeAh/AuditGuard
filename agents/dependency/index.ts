import {
  HCSClient,
  ContractClient,
  CONFIG,
  ensureOperationalHbar,
  getHbarTopUpConfig,
  createAgentLogger,
  createAgentWallet,
  randomInt,
  hashOf,
  sleep,
} from "../shared/index.js";
import type { HCSMessage, SubAuctionPostedEvent } from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "dependency-analyzer-008";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
let currentBacklog = 0;
const startedJobs = new Set<string>();

const log = createAgentLogger(AGENT_ID, "dependency");

function parseChainUint(value: string | number | bigint): bigint {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid numeric id: ${normalized}`);
  }
  return BigInt(normalized);
}

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

  if (!DEMO_MODE) {
    try {
      const hbarTopUpConfig = getHbarTopUpConfig();
      log.info(
        `Payer HBAR auto-top-up: ${hbarTopUpConfig.enabled ? "enabled" : "disabled"} ` +
        `(donors=${hbarTopUpConfig.donorsConfigured}, min=${ethers.formatEther(hbarTopUpConfig.minRequiredWei)} HBAR, ` +
        `target=${ethers.formatEther(hbarTopUpConfig.targetWei)} HBAR)`
      );
      const startupPayer = await ensureOperationalHbar({
        contracts,
        recipientAddress: wallet.evmAddress,
        requiredWei: hbarTopUpConfig.targetWei,
        logger: log,
      });
      if (!startupPayer.ok) {
        log.warn(`Startup preflight: ${startupPayer.reason ?? "Insufficient payer HBAR for transaction fees"}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup HBAR preflight failed: ${error}`);
    }
  }

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

    if (msg.type === "WINNERS_SELECTED_FALLBACK") {
      const { jobId, selectionEpoch } = (msg as any).payload ?? {};
      const dedupKey = `${String(jobId)}:${selectionEpoch ?? "0"}`;
      if (startedJobs.has(dedupKey)) {
        log.info(`Already processing job ${String(jobId)}, skipping`);
        return;
      }
      startedJobs.add(dedupKey);
      log.info("Received main job fallback, ignoring because this agent handles sub-contracts only");
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
    let onChainSubAuctionId: bigint;
    try {
      onChainSubAuctionId = parseChainUint(subAuctionId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Invalid sub-auction id: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "SUB_BID_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { subAuctionId, parentJobId, strictLive: true, error },
        });
        return;
      }
      onChainSubAuctionId = BigInt(0);
    }

    log.info(`Sub-bidding: ${bid.amount} GUARD (est. ${bid.estimatedTimeSec}s)`);

    if (!DEMO_MODE) {
      try {
        const hbarTopUpConfig = getHbarTopUpConfig();
        const payerReady = await ensureOperationalHbar({
          contracts,
          recipientAddress: wallet.evmAddress,
          requiredWei: hbarTopUpConfig.minRequiredWei,
          logger: log,
        });
        if (!payerReady.ok) {
          await hcs.publishAuditLog({
            type: "SUB_BID_FAILED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: {
              subAuctionId,
              parentJobId,
              reason: payerReady.reason ?? "Insufficient payer HBAR for transaction fees",
              reasonCode: payerReady.reasonCode ?? "insufficient_payer_hbar",
              hbarBalance: ethers.formatEther(payerReady.balanceWei),
              autoTopUpAttempted: payerReady.attemptedTopUp,
              topUpSources: payerReady.donorAddressesUsed ?? [],
            },
          });
          return;
        }
        if (payerReady.toppedUpWei > 0n) {
          log.info(`Auto top-up applied before sub-bid: +${ethers.formatEther(payerReady.toppedUpWei)} HBAR`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Pre-bid HBAR preflight failed: ${error}`);
        await hcs.publishAuditLog({
          type: "SUB_BID_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { subAuctionId, parentJobId, reason: `payer_preflight_failed: ${error}` },
        });
        return;
      }
    }

    // Submit sub-bid on-chain
    try {
      // Add jitter to avoid race conditions
      const jitter = randomInt(1000, 5000);
      log.info(`Waiting ${jitter}ms jitter before sub-bidding...`);
      await sleep(jitter);

      await contracts.submitSubBid(
        onChainSubAuctionId,
        ethers.parseUnits(bid.amount.toString(), 8),
        bid.estimatedTimeSec,
        ethers.parseUnits((bid.amount * 0.5).toString(), 8), // 50% collateral
      );
      log.info("Sub-bid submitted on-chain");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`On-chain sub-bid failed: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "SUB_BID_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { subAuctionId, parentJobId, strictLive: true, error },
        });
        return;
      }
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
        if (!DEMO_MODE) {
          try {
            const hbarTopUpConfig = getHbarTopUpConfig();
            const payerReady = await ensureOperationalHbar({
              contracts,
              recipientAddress: wallet.evmAddress,
              requiredWei: hbarTopUpConfig.minRequiredWei,
              logger: log,
            });
            if (!payerReady.ok) {
              log.warn(
                `Pre-delivery payer preflight failed: ` +
                `${payerReady.reason ?? "Insufficient payer HBAR for transaction fees"} (continuing)`
              );
            } else if (payerReady.toppedUpWei > 0n) {
              log.info(
                `Auto top-up applied before result delivery: +${ethers.formatEther(payerReady.toppedUpWei)} HBAR`
              );
            }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            log.warn(`Pre-delivery HBAR preflight failed: ${error} (continuing)`);
          }
        }

        try {
          await contracts.deliverResult(onChainSubAuctionId, result.analysisHash);
          log.info("Result delivered on-chain");
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          log.warn(`On-chain delivery failed: ${error}`);
          if (STRICT_LIVE && !DEMO_MODE) {
            await hcs.publishAuditLog({
              type: "SUB_RESULT_DELIVERY_FAILED",
              agentId: AGENT_ID,
              timestamp: Date.now(),
              payload: { subAuctionId, parentJobId, strictLive: true, error },
            });
            return;
          }
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
