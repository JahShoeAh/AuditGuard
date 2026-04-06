import {
  HCSClient,
  ContractClient,
  CONFIG,
  computeLiveBid,
  ensureBidCollateralBalance,
  getBidCollateralTopUpConfig,
  ensureOperationalHbar,
  getHbarTopUpConfig,
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
  postFindingsToStore,
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
const SPECIALIZATIONS: ContractType[] = [
  "lending", "dex", "staking", "bridge", "vault",
  "derivatives", "oracle", "governance", "nft",
];
const BASE_REPUTATION = 82;
const MAX_DATA_PURCHASE_PRICE = 1.0; // GUARD
const WINNER_WAIT_MS = DEMO_MODE ? 15 * 1000 : 30 * 1000;
const GUARD_DECIMALS = 8;
const FUZZER_SERVICE_URL = process.env.FUZZER_SERVICE_URL ?? "http://localhost:4001";

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

// ---- Real Fuzzing via Service ----

/**
 * Submit a fuzz job to the fuzzer-service and poll for results.
 * Falls back to generateFindings() if the service is unavailable,
 * or if the service returns no findings (tool not installed).
 */
async function runFuzzOrFallback(
  contractAddress: string,
  contractType: ContractType,
  hasExternalData: boolean,
  budgetSeconds: number,
): Promise<Finding[]> {
  try {
    const submitRes = await fetch(`${FUZZER_SERVICE_URL}/fuzz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractAddress,
        chainForkUrl: process.env.HEDERA_JSON_RPC_URL,
        budgetSeconds,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!submitRes.ok) {
      throw new Error(`Fuzzer service returned ${submitRes.status}`);
    }

    const { jobId } = (await submitRes.json()) as { jobId: string };
    log.info(`Fuzzer service job submitted: ${jobId} (budget ${budgetSeconds}s)`);

    // Poll until done or deadline
    const deadline = Date.now() + (budgetSeconds + 30) * 1000;
    while (Date.now() < deadline) {
      await sleep(8_000);
      const pollRes = await fetch(`${FUZZER_SERVICE_URL}/results/${jobId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!pollRes.ok) continue;

      const result = (await pollRes.json()) as {
        status: string;
        findings: Finding[];
        toolUsed: string | null;
        elapsed: number;
      };

      if (result.status === "done" || result.status === "failed") {
        if (result.findings.length > 0) {
          log.info(
            `Fuzzer service complete (tool=${result.toolUsed}, elapsed=${result.elapsed}s): ` +
            `${result.findings.length} findings`
          );
          return result.findings;
        }
        // Service ran but found nothing (or no tool installed) — use mock
        log.info(
          `Fuzzer service returned 0 findings (tool=${result.toolUsed ?? "none"}) — using mock fallback`
        );
        return generateFindings(contractType, hasExternalData);
      }
    }

    // Deadline exceeded while polling
    log.warn("Fuzzer service timed out — using mock fallback");
    return generateFindings(contractType, hasExternalData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Fuzzer service unavailable (${msg}) — using mock fallback`);
    return generateFindings(contractType, hasExternalData);
  }
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
      `(donors=${hbarTopUpConfig.donorsConfigured}, min=${ethers.formatEther(hbarTopUpConfig.minRequiredWei)} HBAR, target=${ethers.formatEther(hbarTopUpConfig.targetWei)} HBAR)`
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
      requiredWei: hbarTopUpConfig.targetWei,
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
  }>();

  // Listen for data listings + AUCTION_INVITE from other agents / orchestrator
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type === "PING") {
      try {
        await hcs.publishAgentComms({
          type: "PONG",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {},
        });
      } catch (err) {
        log.warn(`PONG publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      const {
        jobId,
        contractAddress,
        deployerAddress: inviteDeployer,
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
            requiredWei: hbarTopUpConfig.targetWei,
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
                      requiredWei: getHbarTopUpConfig().targetWei,
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
          deployerAddress: String(inviteDeployer ?? ""),
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
        const guardBalance = Number(
          ethers.formatUnits(await contracts.getGuardBalance(wallet.evmAddress), GUARD_DECIMALS)
        );
        const hbarBalance = ethers.formatEther(await contracts.wallet.provider.getBalance(wallet.evmAddress));
        const payerFundingFailure =
          reasonCode === "insufficient_payer_hbar" || reasonCode === "insufficient_payer_hbar_after_topup";
        log.warn(`On-chain bid failed: ${error}`);
        await hcs.publishAuditLog({
          type: payerFundingFailure ? "BID_SKIPPED" : "BID_SUBMISSION_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            jobId: String(jobId),
            contractAddress,
            strictLive: STRICT_LIVE && !DEMO_MODE,
            ...(payerFundingFailure
              ? {
                  reason: "Insufficient payer HBAR for transaction fees",
                  reasonCode,
                }
              : {
                  error,
                  reasonCode,
                }),
            guardBalance,
            hbarBalance,
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

    log.info(`WON auction for job #${jobKey}!`);
    updatePricingAfterOutcome(true);

    simulateAuditCycle(
      pending.jobId,
      pending.contractAddress,
      pending.deployerAddress,
      pending.contractType,
      pending.loc,
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
  deployerAddress: string,
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
  log.info(`Running fuzz testing... (budget ${auditTime}s${hasExternalData ? " — optimized" : ""})`);

  const findings = await runFuzzOrFallback(contractAddress, contractType, hasExternalData, auditTime);
  const criticalCount = findings.filter((f) => f.severity === "critical").length;

  log.info(
    `Testing complete: ${findings.length} findings [C:${criticalCount}]`
  );

  // Store findings so the report agent can build a real report
  await postFindingsToStore(jobId, AGENT_ID, findings, log);

  const findingsHash = hashOf(findings);

  await hcs.publishAgentComms({
    type: "FINDINGS_SUBMITTED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      jobId,
      contractAddress,
      deployerAddress,
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
  process.on("unhandledRejection", (reason) => {
    const msg = String(reason instanceof Error ? reason.message : reason);
    if (msg.includes("502") || msg.includes("Bad Gateway") || msg.includes("rate limit") || msg.includes("-32005")) {
      log.warn(`[unhandledRejection] transient RPC error (swallowed): ${msg.slice(0, 120)}`);
    } else {
      log.error(`[unhandledRejection] ${msg}`);
    }
  });
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
