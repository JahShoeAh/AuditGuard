import {
  HCSClient,
  ContractClient,
  CONFIG,
  computeLiveBid,
  ensureBidCollateralBalance,
  isRetriableBidFailure,
  normalizeBidFailureReasonCode,
  createAgentLogger,
  createAgentWallet,
  randomInt,
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
const STRICT_LIVE = CONFIG.strictLive;
const NO_FALLBACK_MODE = (process.env.NO_FALLBACK_MODE ?? "true") === "true";
const SPECIALIZATIONS: ContractType[] = ["dex", "bridge"];
const BASE_REPUTATION = 82;
const MAX_DATA_PURCHASE_PRICE = 1.0; // GUARD
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;
const GUARD_DECIMALS = 8;

const log = createAgentLogger(AGENT_ID, "fuzzer");

// Track pending jobs awaiting winner selection
const pendingJobs = new Map<string, {
  jobId: string;
  contractAddress: string;
  contractType: ContractType;
  loc: number;
}>();
const startedJobs = new Set<string>();

// Dynamic pricing state
let bidMultiplier = 1.0;
let totalBids = 0;
let totalWins = 0;
const PRICING_ALPHA = 0.3;
const bidInFlightJobs = new Set<string>();
const bidSubmittedJobs = new Set<string>();
let bidSubmissionQueue: Promise<void> = Promise.resolve();

function queueBidSubmission(task: () => Promise<void>): Promise<void> {
  const next = bidSubmissionQueue.then(task);
  bidSubmissionQueue = next.catch(() => undefined);
  return next;
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
  let minBidCollateralWei = ethers.parseUnits(
    CONFIG.bidPolicy.minCollateralGuard.toFixed(2),
    GUARD_DECIMALS
  );
  let minBidCollateralGuard = CONFIG.bidPolicy.minCollateralGuard;

  log.info(`Wallet: ${wallet.evmAddress}`);

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
    let startupActive = false;
    let startupAllowanceOk = true;

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

    if (NO_FALLBACK_MODE && !startupActive) {
      throw new Error(
        "Startup preflight failed: wallet is not an active on-chain agent. " +
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
      const listingIdKey = String(listingId ?? "");
      if (
        category === "SCAN_REPORT" &&
        price <= MAX_DATA_PURCHASE_PRICE &&
        /^\d+$/.test(listingIdKey)
      ) {
        log.info(`Scan report available from ${msg.agentId}: ${price} GUARD`);
        availableReports.set(String(jobId), {
          listingId: listingIdKey,
          price,
          seller: msg.agentId,
          jobId: String(jobId),
        });
      }
    }

    if (msg.type === "AUCTION_INVITE") {
      const { jobId, contractAddress, contractType, riskScore, estimatedLOC, estimatedLineCount, budget } = (msg as any).payload;
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
      const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);
      if (!bid) return;

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
        `AUCTION_INVITE for job #${jobId} — bidding ${finalBid.amount} GUARD ` +
        `(collateral ${finalBid.collateral} GUARD)`
      );

      bidInFlightJobs.add(jobKey);
      try {
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
                strictLive: true,
                evmAddress: wallet.evmAddress,
                availableCollateral: Number(ethers.formatUnits(collateralReady.balanceWei, GUARD_DECIMALS)),
                autoTopUpAttempted: collateralReady.attemptedTopUp,
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
                strictLive: true,
                evmAddress: wallet.evmAddress,
              },
            });
            return;
          }
        }

        let submittedOnChain = false;
        let alreadyBidOnChain = false;
        await queueBidSubmission(async () => {
          alreadyBidOnChain = await contracts.hasAgentBid(jobId, wallet.evmAddress);
          if (alreadyBidOnChain) return;

          // Add jitter to avoid race conditions between competing agents.
          const jitter = randomInt(1000, 5000);
          log.info(`Waiting ${jitter}ms jitter before bidding...`);
          await sleep(jitter);

          const maxAttempts = 3;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const tx = await contracts.submitBid(
                jobId,
                finalBid.amountWei,
                finalBid.collateralWei,
                finalBid.estimatedTimeSec,
                SPECIALIZATIONS[0]
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
              const retriable = isRetriableBidFailure(error);
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
        });

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
    const myAddress = wallet.evmAddress.toLowerCase();
    const winnerIndex = winners.findIndex(w => w.toLowerCase() === myAddress);
    if (winnerIndex === -1) return;

    const jobKey = jobId.toString();
    const pending = pendingJobs.get(jobKey);
    if (!pending) return;

    log.info(`WON auction for job #${jobKey}!`);
    updatePricingAfterOutcome(true);
    pendingJobs.delete(jobKey);

    simulateAuditCycle(
      pending.jobId,
      pending.contractAddress,
      pending.contractType,
      pending.loc,
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
  jobId: string,
  contractAddress: string,
  contractType: ContractType,
  loc: number,
  hcs: HCSClient,
  contracts: ContractClient,
  evmAddress: string
) {
  let hasExternalData = false;

  // ── Day 2: Try to buy scan report from DataMarketplace ──
  const affordableReport = availableReports.get(jobId);
  if (affordableReport) {
    let listingId: bigint;
    try {
      listingId = parseChainUint(affordableReport.listingId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Invalid listingId: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "DATA_PURCHASE_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { jobId, listingId: affordableReport.listingId, strictLive: true, error },
        });
        return;
      }
      listingId = BigInt(0);
    }

    if (listingId >= BigInt(0)) {
      log.info(
        `Purchasing scan from ${affordableReport.seller}: ` +
        `${affordableReport.price} GUARD (listing ${affordableReport.listingId})`
      );

      try {
        await contracts.purchaseData(listingId);
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
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Purchase failed: ${error}`);
        if (STRICT_LIVE && !DEMO_MODE) {
          await hcs.publishAuditLog({
            type: "DATA_PURCHASE_FAILED",
            agentId: AGENT_ID,
            timestamp: Date.now(),
            payload: { jobId, listingId: affordableReport.listingId, strictLive: true, error },
          });
          return;
        }
      }
    }

    availableReports.delete(jobId);
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
      jobId,
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
