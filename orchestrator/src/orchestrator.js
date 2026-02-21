import { ethers } from "ethers";
import { CONFIG, getOperatorKeys } from "./config.js";
import { HCSClient } from "./hcs-client.js";
import { ContractClient } from "./contract-client.js";
import { Roster } from "./roster.js";
import { createLogger } from "./logger.js";
import { InftBridge } from "./inft-bridge.js";
import { enrichScheduledDiscovery } from "./scheduled-enrichment-client.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { parseUnits } from "ethers";
import { normalizeDeployer } from "../../packages/sdk/db/report-types.js";
import { generateAndStoreReport } from "./report-writer.js";

function parsePositiveIntEnv(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Orchestrator Agent — isolated implementation.
 * Listens to discovery + registration, invites eligible agents,
 * opens auctions on-chain, and uses strict on-chain winner selection.
 *
 * Dependencies (HCS, contracts, roster, logger) are injectable for testing.
 */
export class OrchestratorAgent {
  constructor(opts = {}) {
    this.log = opts.log ?? createLogger("orchestrator");
    this.hcs = opts.hcs ?? new HCSClient();
    this.contracts = opts.contracts ?? this.buildContractClient();
    this.strictLive = opts.strictLive ?? CONFIG.strictLive;
    this.orchestratorAddress = this.contracts.getAddress?.() ?? "";
    this.roster = opts.roster ?? new Roster(this.log);
    this.inft = opts.inft ?? new InftBridge();
    this.jobs = new Map(); // jobId(string) -> state
    this.enablePing = opts.enablePing ?? true;
    this.createAuditJobLock = Promise.resolve();
    this.minOperationalHbar = Number(process.env.ORCHESTRATOR_MIN_HBAR ?? "0.5");
    this.targetOperationalHbar = Number(process.env.ORCHESTRATOR_TARGET_HBAR ?? "2.0");
    this.topupDonorReserveHbar = Number(process.env.ORCHESTRATOR_TOPUP_DONOR_MIN_HBAR ?? "1.0");
    this.autoTopupHbar = (process.env.ORCHESTRATOR_AUTO_TOPUP_HBAR ?? "true") !== "false";
    this.operationalCheckIntervalMs = Number(process.env.ORCHESTRATOR_OPERATIONAL_CHECK_INTERVAL_MS ?? "30000");
    this.lastOperationalCheckAt = 0;
    this.fastWinnerPathEnabled = (process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED ?? "false") === "true";
    this.staleAuctionReconcileEnabled = (process.env.ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS ?? "true") !== "false";
    this.staleAuctionReconcileIntervalMs = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS_INTERVAL_MS,
      this.fastWinnerPathEnabled ? 5000 : 30000
    );
    this.staleAuctionReconcileMaxPerCycle = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE,
      3
    );
    this.staleAuctionReconcileMaxSelectsPerCycle = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE,
      10
    );
    this.staleAuctionReconcileMaxInspectPerCycle = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_RECONCILE_MAX_INSPECT_PER_CYCLE,
      Math.max(this.staleAuctionReconcileMaxPerCycle + this.staleAuctionReconcileMaxSelectsPerCycle, 50)
    );
    this.staleAuctionReconcileFailureCooldownMs = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_RECONCILE_FAILURE_COOLDOWN_MS,
      15000
    );
    this.rehydrateMissingJobForSelection =
      process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION == null
        ? this.fastWinnerPathEnabled
        : process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION !== "false";
    this.winnerSelectionTimers = new Map();
    this.winnerSelectionStartupBackfillEnabled =
      (process.env.ORCHESTRATOR_STARTUP_WINNER_REARM ?? "true") !== "false";
    this.winnerSelectionStartupBackfillMaxJobs = parsePositiveIntEnv(
      process.env.ORCHESTRATOR_STARTUP_WINNER_REARM_MAX_JOBS,
      200
    );
    this.staleAuctionReconcileTimer = null;
    this.rosterBootstrapOnchain = (process.env.ORCHESTRATOR_ROSTER_BOOTSTRAP_ONCHAIN ?? "true") !== "false";
    this.filterInvitesOnchainActive = (process.env.ORCHESTRATOR_FILTER_INVITES_ONCHAIN_ACTIVE ?? "true") !== "false";
    this.onchainActiveCacheTtlMs = Number(process.env.ORCHESTRATOR_ACTIVE_CACHE_TTL_MS ?? "15000");
    this.onchainActiveStaleFallbackTtlMs = Number(
      process.env.ORCHESTRATOR_ACTIVE_STALE_CACHE_TTL_MS ?? "300000"
    );
    this.activeCheckRetries = Number(process.env.ORCHESTRATOR_ACTIVE_CHECK_RETRIES ?? "3");
    this.activeCheckFailOpen = (process.env.ORCHESTRATOR_ACTIVE_CHECK_FAIL_OPEN ?? "false") === "true";
    this.discoveryDedupeEnabled = (process.env.ORCHESTRATOR_ENABLE_DISCOVERY_DEDUPE ?? "true") !== "false";
    this.discoveryDedupeTtlMs = Number(process.env.ORCHESTRATOR_DISCOVERY_DEDUPE_TTL_MS ?? "120000");
    this.auctionCloseSingleflightEnabled = (process.env.ORCHESTRATOR_AUCTION_CLOSE_SINGLEFLIGHT ?? "true") !== "false";
    this.onchainActiveCache = new Map();
    this.recentDiscovery = new Map();
    this.rosterBootstrapPromise = Promise.resolve();
    this.inflightCloseJobs = new Map();
    this.inflightSelectWinnerJobs = new Map();
    this.recentWinnerAnnouncements = new Map();
    const winnerAnnounceDedupRaw = Number(process.env.ORCHESTRATOR_WINNER_ANNOUNCE_DEDUP_MS ?? "15000");
    this.winnerAnnounceDedupMs = Number.isFinite(winnerAnnounceDedupRaw)
      ? Math.max(1_000, Math.floor(winnerAnnounceDedupRaw))
      : 15_000;
    this.reconcileCloseCooldown = new Map();
    this._isReconcileRunning = false;
    this.staleAuctionReconcileCursor = 0;
    this.scheduledEnrichmentClient = opts.scheduledEnrichmentClient ?? enrichScheduledDiscovery;
    this.scheduledEnrichmentMaxAttempts = Number(
      process.env.ORCHESTRATOR_SCHEDULED_ENRICHMENT_MAX_ATTEMPTS ?? "2"
    );
    this.scheduledEnrichmentTimeoutMs = Number(
      process.env.ORCHESTRATOR_SCHEDULED_ENRICHMENT_TIMEOUT_MS ?? "45000"
    );
    this.scheduledEnrichmentRetryIntervalMs = Number(
      process.env.ORCHESTRATOR_SCHEDULED_ENRICHMENT_RETRY_INTERVAL_MS ?? "15000"
    );
    this.scheduledEnrichmentQueue = new Map();
    this.scheduledEnrichmentTimer = null;
    this.scheduledEnrichmentInFlight = false;
    this.log.info(
      `[Orchestrator] winner path config: fast=${this.fastWinnerPathEnabled}, ` +
      `rehydrate_missing_job=${this.rehydrateMissingJobForSelection}, ` +
      `reconcile_interval_ms=${this.staleAuctionReconcileIntervalMs}, ` +
      `reconcile_max_closes=${this.staleAuctionReconcileMaxPerCycle}, ` +
      `reconcile_max_selects=${this.staleAuctionReconcileMaxSelectsPerCycle}, ` +
      `reconcile_max_inspect=${this.staleAuctionReconcileMaxInspectPerCycle}, ` +
      `bid_finality_grace_ms=${Number(CONFIG.timeouts?.bidFinalityGraceMs ?? 0)}, ` +
      `write_queue_max_high_streak=${Number(CONFIG.queue?.writeQueueMaxHighStreak ?? 0)}`
    );
  }

  buildContractClient() {
    try {
      const client = ContractClient.fromOperatorKey(getOperatorKeys().privateKey.replace(/^0x/, ""));
      const missing = [];
      if (typeof client.createAuditJob !== "function") missing.push("createAuditJob");
      if (typeof client.selectWinners !== "function") missing.push("selectWinners");
      if (typeof client.cancelJob !== "function") missing.push("cancelJob");
      if (typeof client.getActiveJobs !== "function") missing.push("getActiveJobs");
      if (typeof client.getJob !== "function") missing.push("getJob");
      if (typeof client.getAllAgents !== "function") missing.push("getAllAgents");
      if (typeof client.getAgent !== "function") missing.push("getAgent");
      if (typeof client.isActiveAgent !== "function") missing.push("isActiveAgent");
      if (typeof client.purchaseData !== "function") missing.push("purchaseData");
      if (typeof client.createSubAuction !== "function") missing.push("createSubAuction");
      if (typeof client.acceptSubResult !== "function") missing.push("acceptSubResult");
      if (typeof client.settleJob !== "function") missing.push("settleJob");
      if (missing.length) {
        throw new Error(`Contract client missing required methods: ${missing.join(", ")}`);
      }
      return client;
    } catch (err) {
      throw new Error(`Contract client init failed: ${err.message}`);
    }
  }

  normalizeId(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "bigint") return value.toString();
    return String(value);
  }

  normalizeJobId(jobId) {
    return this.normalizeId(jobId);
  }

  toChainJobId(jobId) {
    const key = this.normalizeJobId(jobId);
    if (!/^\d+$/.test(key)) {
      throw new Error(`Invalid numeric jobId for chain call: ${key}`);
    }
    return BigInt(key);
  }

  toChainUint(value, label) {
    const key = this.normalizeId(value);
    if (!/^\d+$/.test(key)) {
      throw new Error(`Invalid numeric ${label}: ${key}`);
    }
    return BigInt(key);
  }

  getJobByKey(jobId) {
    const key = this.normalizeJobId(jobId);
    if (this.jobs.has(key)) return this.jobs.get(key);
    return this.jobs.get(jobId);
  }

  setJobByKey(jobId, job) {
    const key = this.normalizeJobId(jobId);
    this.jobs.set(key, job);
  }

  normalizeWinnerAddresses(winners) {
    if (!Array.isArray(winners)) return [];
    const seen = new Set();
    const normalized = [];
    for (const winner of winners) {
      const addr = this.normalizeAddress(winner);
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(addr);
    }
    return normalized;
  }

  buildWinnerFingerprint(winners) {
    return this.normalizeWinnerAddresses(winners)
      .map((winner) => winner.toLowerCase())
      .sort()
      .join("|");
  }

  pruneWinnerAnnouncementCache(nowMs = Date.now()) {
    for (const [jobId, entry] of this.recentWinnerAnnouncements.entries()) {
      const publishedAt = Number(entry?.publishedAt ?? 0);
      if (!Number.isFinite(publishedAt) || nowMs - publishedAt > this.winnerAnnounceDedupMs) {
        this.recentWinnerAnnouncements.delete(jobId);
      }
    }
  }

  async publishWinnerSelectedAuditLog(jobId, winners, extras = {}) {
    const key = this.normalizeJobId(jobId);
    const winnerAddrs = this.normalizeWinnerAddresses(winners);
    if (!winnerAddrs.length) return false;

    const txHash = typeof extras?.txHash === "string" && extras.txHash
      ? extras.txHash
      : null;
    const winnersFingerprint = winnerAddrs
      .map((winner) => winner.toLowerCase())
      .sort()
      .join("|");
    const nowMs = Date.now();
    this.pruneWinnerAnnouncementCache(nowMs);

    const existing = this.recentWinnerAnnouncements.get(key);
    if (existing && nowMs - Number(existing.publishedAt ?? 0) <= this.winnerAnnounceDedupMs) {
      const sameWinners = existing.winnersFingerprint === winnersFingerprint;
      const sameTxHash = txHash && existing.txHash
        ? String(existing.txHash).toLowerCase() === txHash.toLowerCase()
        : false;
      if (sameWinners || sameTxHash) return false;
    }

    this.recentWinnerAnnouncements.set(key, {
      winnersFingerprint,
      txHash: txHash ? txHash.toLowerCase() : null,
      publishedAt: nowMs,
    });

    await this.hcs.publishAuditLog({
      type: "WINNER_SELECTED",
      agentId: "orchestrator",
      timestamp: now(),
      payload: {
        jobId: key,
        winners: winnerAddrs,
        ...(extras?.totalEscrowed != null ? { totalEscrowed: extras.totalEscrowed.toString() } : {}),
        ...(extras?.platformFee != null ? { platformFee: extras.platformFee.toString() } : {}),
        ...(txHash ? { txHash } : {}),
      },
    }).catch(() => {});
    return true;
  }

  async publishWinnerSelectionTiming(jobId, details = {}) {
    const key = this.normalizeJobId(jobId);
    await this.hcs.publishAuditLog({
      type: "WINNER_SELECTION_TIMING",
      agentId: "orchestrator",
      timestamp: now(),
      payload: {
        jobId: key,
        deadlineSec: details.deadlineSec ?? null,
        graceMs: details.graceMs ?? null,
        scheduledAt: details.scheduledAt ?? null,
        selectStartedAt: details.selectStartedAt ?? null,
        txSentAt: details.txSentAt ?? null,
        receiptAt: details.receiptAt ?? null,
        closeToReceiptMs: details.closeToReceiptMs ?? null,
        path: details.path ?? "unknown",
        attempts: details.attempts ?? 0,
        result: details.result ?? "unknown",
        error: details.error ?? null,
        priorityUsed: details.priorityUsed ?? "normal",
        deadlineReached: details.deadlineReached ?? null,
        onChainBidCount: details.onChainBidCount ?? null,
        suppressedReason: details.suppressedReason ?? null,
      },
    }).catch(() => {});
  }

  clearWinnerSelectionTimer(jobId) {
    const key = this.normalizeJobId(jobId);
    const timer = this.winnerSelectionTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.winnerSelectionTimers.delete(key);
  }

  scheduleWinnerSelection(jobId, auctionDeadlineSec, triggerPath = "timer") {
    const key = this.normalizeJobId(jobId);
    const graceMs = Number(CONFIG.timeouts?.bidFinalityGraceMs ?? 0);
    const hasDeadline = Number.isFinite(Number(auctionDeadlineSec)) && Number(auctionDeadlineSec) > 0;
    const fallbackDelayMs = Math.max(1, Number(CONFIG.timeouts.winnerWaitMs ?? 120_000) + graceMs);
    const delayMs = hasDeadline
      ? Math.max(0, (Number(auctionDeadlineSec) * 1000) - Date.now() + graceMs)
      : fallbackDelayMs;

    const trackedJob = this.getJobByKey(key);
    if (trackedJob) {
      trackedJob.winnerSelectionScheduledAt = Date.now() + delayMs;
      trackedJob.bidFinalityGraceMs = graceMs;
      if (hasDeadline) trackedJob.auctionDeadlineSec = Math.floor(Number(auctionDeadlineSec));
      this.setJobByKey(key, trackedJob);
    }

    this.clearWinnerSelectionTimer(key);
    const winnerTimer = setTimeout(() => {
      this.winnerSelectionTimers.delete(key);
      this.requestWinnerSelection(key, { sourcePath: triggerPath }).catch((err) => {
        this.log.warn(
          `[Orchestrator] Scheduled winner selection dispatch failed for job ${key}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, delayMs);
    winnerTimer.unref?.();
    this.winnerSelectionTimers.set(key, winnerTimer);
  }

  resolveWinnerSelectionPriority(readiness = null) {
    if (!this.fastWinnerPathEnabled) return "normal";
    if (!readiness?.canSelect) return "normal";
    if (!readiness?.deadlineReached) return "normal";
    if (Number(readiness?.onChainBidCount ?? 0) <= 0) return "normal";
    return "high";
  }

  async publishWinnerSelectionDeferred(jobId, details = {}) {
    const key = this.normalizeJobId(jobId);
    await this.hcs.publishAuditLog({
      type: "WINNER_SELECTION_DEFERRED",
      agentId: "orchestrator",
      timestamp: now(),
      payload: {
        jobId: key,
        reasonCode: details.reasonCode ?? "unknown",
        sourcePath: details.sourcePath ?? "unknown",
        deadlineSec: details.deadlineSec ?? null,
        onChainBidCount: details.onChainBidCount ?? null,
      },
    }).catch(() => {});
  }

  async evaluateWinnerSelectionReadiness(jobId, sourcePath = "unknown", options = {}) {
    const key = this.normalizeJobId(jobId);
    const localJob = this.getJobByKey(key);
    const getJob =
      this.contracts.getJob?.bind(this.contracts) ??
      this.contracts.auction?.getJob?.bind(this.contracts.auction);

    let chainJob = options.chainJob ?? null;
    if (!chainJob && typeof getJob === "function") {
      try {
        chainJob = await getJob(this.toChainJobId(key));
      } catch {
        chainJob = null;
      }
    }

    const chainStatusRaw =
      options.chainStatus ?? (chainJob?.status != null ? Number(chainJob.status) : null);
    const chainStatus = Number.isFinite(Number(chainStatusRaw)) ? Number(chainStatusRaw) : null;
    const terminalStatus = chainStatus != null && chainStatus !== 0 && chainStatus !== 1;

    const deadlineCandidates = [
      options.deadlineSec,
      chainJob?.auctionDeadline,
      localJob?.auctionDeadlineSec,
    ];
    let deadlineSec = null;
    for (const candidate of deadlineCandidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        deadlineSec = Math.floor(numeric);
        break;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const deadlineReached = deadlineSec != null ? nowSec >= deadlineSec : false;
    let onChainBidCount = null;
    if (Number.isFinite(Number(options.onChainBidCount))) {
      onChainBidCount = Math.max(0, Math.floor(Number(options.onChainBidCount)));
    } else {
      try {
        onChainBidCount = await this.getOnChainBidCount(key);
      } catch {
        onChainBidCount = null;
      }
    }

    const hasBids = Number(onChainBidCount ?? 0) > 0;
    const jobExists = Boolean(localJob || chainJob);
    let reasonCode = "ready";
    if (!jobExists) reasonCode = "not_found";
    else if (terminalStatus) reasonCode = "terminal_status";
    else if (!deadlineReached) reasonCode = "deadline_not_reached";
    else if (!hasBids) reasonCode = "no_onchain_bids";

    const readiness = {
      jobId: key,
      sourcePath,
      jobExists,
      chainStatus,
      deadlineSec,
      deadlineReached,
      onChainBidCount,
      hasBids,
      canSelect: reasonCode === "ready",
      shouldCancelNoBids: reasonCode === "no_onchain_bids",
      reasonCode,
    };
    return readiness;
  }

  async requestWinnerSelection(jobId, options = {}) {
    const key = this.normalizeJobId(jobId);
    const sourcePath =
      typeof options?.sourcePath === "string" && options.sourcePath
        ? options.sourcePath
        : "manual";
    const readiness = await this.evaluateWinnerSelectionReadiness(key, sourcePath, options.readinessHint ?? {});
    const graceMs = Number(CONFIG.timeouts?.bidFinalityGraceMs ?? 0);
    const scheduledAtRaw = Number(this.getJobByKey(key)?.winnerSelectionScheduledAt ?? 0);
    const scheduledAt = Number.isFinite(scheduledAtRaw) && scheduledAtRaw > 0 ? scheduledAtRaw : null;

    if (readiness.canSelect) {
      const priorityUsed = this.resolveWinnerSelectionPriority(readiness);
      return this.selectWinnersOnChain(key, {
        path: sourcePath,
        readiness,
        priorityUsed,
      });
    }

    await this.publishWinnerSelectionDeferred(key, {
      reasonCode: readiness.reasonCode,
      sourcePath,
      deadlineSec: readiness.deadlineSec,
      onChainBidCount: readiness.onChainBidCount,
    });

    if (readiness.reasonCode === "deadline_not_reached" && readiness.deadlineSec != null) {
      this.scheduleWinnerSelection(key, readiness.deadlineSec, "timer");
      await this.publishWinnerSelectionTiming(key, {
        deadlineSec: readiness.deadlineSec,
        graceMs,
        scheduledAt,
        selectStartedAt: Date.now(),
        txSentAt: null,
        receiptAt: null,
        closeToReceiptMs: null,
        path: sourcePath,
        attempts: 0,
        result: "deferred",
        error: null,
        priorityUsed: "normal",
        deadlineReached: false,
        onChainBidCount: readiness.onChainBidCount,
        suppressedReason: readiness.reasonCode,
      });
      return;
    }

    if (readiness.shouldCancelNoBids) {
      await this.closeExpiredAuction(key, `${sourcePath}_no_bids_before_deadline`);
      await this.publishWinnerSelectionTiming(key, {
        deadlineSec: readiness.deadlineSec,
        graceMs,
        scheduledAt,
        selectStartedAt: Date.now(),
        txSentAt: null,
        receiptAt: null,
        closeToReceiptMs: null,
        path: sourcePath,
        attempts: 0,
        result: "skipped",
        error: null,
        priorityUsed: "normal",
        deadlineReached: readiness.deadlineReached,
        onChainBidCount: readiness.onChainBidCount,
        suppressedReason: readiness.reasonCode,
      });
      return;
    }

    await this.publishWinnerSelectionTiming(key, {
      deadlineSec: readiness.deadlineSec,
      graceMs,
      scheduledAt,
      selectStartedAt: Date.now(),
      txSentAt: null,
      receiptAt: null,
      closeToReceiptMs: null,
      path: sourcePath,
      attempts: 0,
      result: "skipped",
      error: null,
      priorityUsed: "normal",
      deadlineReached: readiness.deadlineReached,
      onChainBidCount: readiness.onChainBidCount,
      suppressedReason: readiness.reasonCode,
    });
  }

  async bootstrapWinnerSelectionFromActiveJobs() {
    if (!this.winnerSelectionStartupBackfillEnabled) return;
    const getActiveJobs =
      this.contracts.getActiveJobs?.bind(this.contracts) ??
      this.contracts.auction?.getActiveJobs?.bind(this.contracts.auction);
    const getJob =
      this.contracts.getJob?.bind(this.contracts) ??
      this.contracts.auction?.getJob?.bind(this.contracts.auction);
    if (typeof getActiveJobs !== "function" || typeof getJob !== "function") return;

    const activeJobIds = await getActiveJobs();
    if (!Array.isArray(activeJobIds) || activeJobIds.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    let scheduled = 0;
    let skippedExpired = 0;
    for (const rawJobId of activeJobIds) {
      if (scheduled >= this.winnerSelectionStartupBackfillMaxJobs) break;
      const key = this.normalizeJobId(rawJobId);
      let chainJob = null;
      try {
        chainJob = await getJob(this.toChainJobId(key));
      } catch {
        continue;
      }

      const status = Number(chainJob?.status ?? -1);
      if (status !== 0) continue; // JobStatus.AUCTION_OPEN
      const deadlineSec = Number(chainJob?.auctionDeadline ?? 0);
      if (!Number.isFinite(deadlineSec) || deadlineSec <= 0) continue;
      if (deadlineSec <= nowSec) {
        skippedExpired += 1;
        continue;
      }

      const existingJob = this.getJobByKey(key) ?? {};
      this.setJobByKey(key, {
        winners: [],
        findings: [],
        bidders: [],
        reportPublished: false,
        settled: false,
        ...existingJob,
        contractAddress:
          existingJob.contractAddress ??
          (this.normalizeAddress(chainJob?.contractAddress) || null),
        contractType:
          existingJob.contractType ??
          (typeof chainJob?.contractType === "string" && chainJob.contractType.trim()
            ? chainJob.contractType
            : "unknown"),
        auctionDeadlineSec: deadlineSec,
      });
      this.scheduleWinnerSelection(key, deadlineSec, "startup_rearm");
      scheduled += 1;
    }
    if (scheduled > 0 || skippedExpired > 0) {
      this.log.info(
        `[Orchestrator] startup winner re-arm: scheduled=${scheduled} skipped_expired=${skippedExpired}`
      );
    }
  }

  async hydrateJobForSelection(jobId) {
    if (!this.rehydrateMissingJobForSelection) return null;
    const key = this.normalizeJobId(jobId);
    const getJob =
      this.contracts.getJob?.bind(this.contracts) ??
      this.contracts.auction?.getJob?.bind(this.contracts.auction);
    if (typeof getJob !== "function") return null;

    let chainJob = null;
    try {
      chainJob = await getJob(this.toChainJobId(key));
    } catch {
      return null;
    }
    if (!chainJob) return null;
    const status = Number(chainJob?.status ?? -1);
    if (status !== 0 && status !== 1) return null; // AUCTION_OPEN or BIDDING_CLOSED

    let hydratedBidders = [];
    try {
      hydratedBidders = this.mapOnChainBidsToLocal(await this.getOnChainBids(key));
    } catch {
      hydratedBidders = [];
    }
    const deadlineSec = Number(chainJob?.auctionDeadline ?? 0);
    const job = {
      contractAddress: this.normalizeAddress(chainJob?.contractAddress) || null,
      contractType:
        typeof chainJob?.contractType === "string" && chainJob.contractType.trim()
          ? chainJob.contractType
          : "unknown",
      bidders: hydratedBidders,
      winners: [],
      findings: [],
      reportPublished: false,
      settled: false,
      auctionDeadlineSec: Number.isFinite(deadlineSec) && deadlineSec > 0
        ? Math.floor(deadlineSec)
        : null,
    };
    this.setJobByKey(key, job);
    return job;
  }

  async withCreateAuditJobLock(task) {
    const previous = this.createAuditJobLock;
    let releaseLock = () => { };
    this.createAuditJobLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    await previous.catch(() => { });
    try {
      return await task();
    } finally {
      releaseLock();
    }
  }

  validateDiscoveryPayload(payload) {
    if (!ethers.isAddress(payload.contractAddress)) {
      throw new Error(`invalid contractAddress: ${payload.contractAddress}`);
    }
    if (!Number.isFinite(Number(payload.budget)) || Number(payload.budget) <= 0) {
      throw new Error(`invalid budget: ${payload.budget}`);
    }
    if (!Number.isInteger(Number(payload.riskScore)) || Number(payload.riskScore) < 0 || Number(payload.riskScore) > 100) {
      throw new Error(`invalid riskScore: ${payload.riskScore}`);
    }
    if (!Number.isFinite(Number(payload.estimatedLOC)) || Number(payload.estimatedLOC) < 0) {
      throw new Error(`invalid estimatedLOC: ${payload.estimatedLOC}`);
    }
  }

  toHexPrivateKey(rawKey) {
    const key = String(rawKey ?? "").trim().replace(/^['"]|['"]$/g, "");
    const stripped = key.startsWith("0x") ? key.slice(2) : key;
    if (!/^[0-9a-fA-F]{64}$/.test(stripped)) return null;
    return `0x${stripped}`;
  }

  getTopupDonorWallets() {
    const provider = this.contracts.wallet?.provider;
    if (!provider) return [];
    const envKeys = [
      process.env.STATIC_PRIVATE_KEY,
      process.env.AUDITOR_AGENT_1_PRIVATE_KEY,
      process.env.FUZZER_PRIVATE_KEY,
      process.env.AUDITOR_AGENT_2_PRIVATE_KEY,
      process.env.LLM_PRIVATE_KEY,
      process.env.AUDITOR_AGENT_3_PRIVATE_KEY,
      process.env.DEPENDENCY_PRIVATE_KEY,
      process.env.REPORT_PRIVATE_KEY,
      process.env.ALERT_PRIVATE_KEY,
      process.env.SCANNER_PRIVATE_KEY,
      process.env.OPERATOR_PRIVATE_KEY,
      process.env.HEDERA_PRIVATE_KEY,
    ];
    const seen = new Set();
    const donors = [];
    for (const raw of envKeys) {
      const hex = this.toHexPrivateKey(raw);
      if (!hex) continue;
      const wallet = new ethers.Wallet(hex, provider);
      const addr = wallet.address.toLowerCase();
      if (addr === this.orchestratorAddress.toLowerCase()) continue;
      if (seen.has(addr)) continue;
      seen.add(addr);
      donors.push(wallet);
    }
    return donors;
  }

  isNonceTooLowError(message) {
    return /nonce too low/i.test(String(message ?? ""));
  }

  isInsufficientFundsError(message) {
    return /(insufficient funds|insufficient_payer_balance|orchestrator_hbar_low)/i.test(
      String(message ?? "")
    );
  }

  isTransientRpcError(message) {
    return /(502 bad gateway|server response 5\d\d|timeout|timed out|unavailable|fetch failed|busy|temporar)/i.test(
      String(message ?? "")
    );
  }

  isAuctionTerminalError(message) {
    return /(only open jobs cancellable|invalid job status|job does not exist|already (completed|cancelled))/i.test(
      String(message ?? "")
    );
  }

  async ensureOrchestratorOperationalHbar(reason = "runtime", { force = false } = {}) {
    const provider = this.contracts.wallet?.provider;
    if (!provider || !this.orchestratorAddress) return;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastOperationalCheckAt < this.operationalCheckIntervalMs) return;
    this.lastOperationalCheckAt = nowMs;

    const minWei = ethers.parseEther(String(this.minOperationalHbar));
    const targetHbar = Math.max(this.targetOperationalHbar, this.minOperationalHbar);
    const targetWei = ethers.parseEther(String(targetHbar));
    const donorReserveWei = ethers.parseEther(String(this.topupDonorReserveHbar));

    let balanceWei = await provider.getBalance(this.orchestratorAddress);
    if (balanceWei >= minWei) return;
    this.log.warn(
      `Low HBAR for orchestrator (${ethers.formatEther(balanceWei)} HBAR) before ${reason}; ` +
      `minimum is ${this.minOperationalHbar} HBAR`
    );

    if (!this.autoTopupHbar) {
      throw new Error(
        `orchestrator_hbar_low:${ethers.formatEther(balanceWei)}<${this.minOperationalHbar}; ` +
        "set ORCHESTRATOR_AUTO_TOPUP_HBAR=true or fund orchestrator account"
      );
    }

    let remainingWei = targetWei > balanceWei ? targetWei - balanceWei : 0n;
    const donors = this.getTopupDonorWallets();
    for (const donor of donors) {
      if (remainingWei <= 0n) break;
      const donorBalanceWei = await provider.getBalance(donor.address);
      if (donorBalanceWei <= donorReserveWei) continue;
      const spendableWei = donorBalanceWei - donorReserveWei;
      if (spendableWei <= 0n) continue;

      const sendWei = spendableWei < remainingWei ? spendableWei : remainingWei;
      if (sendWei <= 0n) continue;
      const tx = await donor.sendTransaction({
        to: this.orchestratorAddress,
        value: sendWei,
      });
      await tx.wait();
      this.log.info(
        `HBAR top-up: ${donor.address} -> orchestrator +${ethers.formatEther(sendWei)} HBAR ` +
        `(tx ${tx.hash})`
      );
      remainingWei -= sendWei;
    }

    balanceWei = await provider.getBalance(this.orchestratorAddress);
    if (balanceWei < minWei) {
      throw new Error(
        `orchestrator_hbar_low_after_topup:${ethers.formatEther(balanceWei)}<${this.minOperationalHbar}`
      );
    }
  }

  start() {
    this.ensureOrchestratorOperationalHbar("startup", { force: true }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Startup preflight: ${msg}`);
    });
    this.rosterBootstrapPromise = this.syncRosterFromRegistry().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Startup roster bootstrap failed: ${msg}`);
    });
    this.subscribeDiscovery();
    this.subscribeAgentComms();
    this.subscribeAuditLog();
    this.subscribeContractEvents();
    this.subscribeSchedulerEvents();  // HSS audit triggers
    this.bootstrapWinnerSelectionFromActiveJobs().catch((err) => {
      this.log.warn(
        `[Orchestrator] startup winner re-arm failed: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    });
    this.startStaleAuctionReconcileLoop();
    this.startScheduledEnrichmentRetryLoop();
    if (this.enablePing) this.startPingLoop();
    this.log.info("Orchestrator started (isolated branch)");
  }

  normalizeAddress(value) {
    if (!value) return "";
    const str = String(value);
    return ethers.isAddress(str) ? str : "";
  }

  toGuardAmount(value) {
    try {
      const guardRaw = typeof value === "bigint" ? value : BigInt(value ?? 0);
      return Number(ethers.formatUnits(guardRaw, CONFIG.guardToken.decimals));
    } catch {
      const numeric = Number(value ?? 0);
      return Number.isFinite(numeric) ? numeric : 0;
    }
  }

  toNumeric(value) {
    if (value == null) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "bigint") return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  findAgentIdByAddress(evmAddress) {
    const normalized = this.normalizeAddress(evmAddress).toLowerCase();
    if (!normalized) return "";
    const entries = this.roster?.agents instanceof Map
      ? this.roster.agents.entries()
      : [];
    for (const [agentId, agent] of entries) {
      const current = this.normalizeAddress(agent?.evmAddress).toLowerCase();
      if (current && current === normalized) return String(agentId);
    }
    return "";
  }

  async getOnChainBidCount(jobId) {
    const getBidCount =
      this.contracts.getBidCount?.bind(this.contracts) ??
      this.contracts.auction?.getBidCount?.bind(this.contracts.auction);
    if (typeof getBidCount !== "function") {
      const bids = await this.getOnChainBids(jobId);
      return Array.isArray(bids) ? bids.length : 0;
    }
    const countRaw = await getBidCount(this.toChainJobId(jobId));
    const count = Math.floor(this.toNumeric(countRaw));
    return Number.isFinite(count) && count >= 0 ? count : 0;
  }

  async getOnChainBids(jobId) {
    const getBidsForJob =
      this.contracts.getBidsForJob?.bind(this.contracts) ??
      this.contracts.auction?.getBidsForJob?.bind(this.contracts.auction);
    if (typeof getBidsForJob !== "function") return [];
    const bids = await getBidsForJob(this.toChainJobId(jobId));
    return Array.isArray(bids) ? bids : [];
  }

  mapOnChainBidsToLocal(onChainBids = []) {
    if (!Array.isArray(onChainBids)) return [];
    return onChainBids
      .map((bid, bidIndex) => {
        const evmAddress = this.normalizeAddress(bid?.agent);
        if (!evmAddress) return null;
        const agentId = this.findAgentIdByAddress(evmAddress) || `onchain:${evmAddress.toLowerCase()}`;
        return {
          agentId,
          evmAddress,
          bidAmount: this.toGuardAmount(bid?.bidAmount ?? 0n),
          collateral: this.toGuardAmount(bid?.collateralLocked ?? 0n),
          estimatedTimeSec: this.toNumeric(bid?.estimatedCompletionTime ?? 0),
          reputation: this.toNumeric(bid?.reputationAtBid ?? 0),
          timestamp: this.toNumeric(bid?.timestamp ?? now()),
          onChainBidIndex: bidIndex,
        };
      })
      .filter(Boolean);
  }

  extractClassifierMetadata(payload = {}) {
    const classifier =
      payload?.classifier && typeof payload.classifier === "object"
        ? payload.classifier
        : {};
    const riskSource = classifier.riskSource ?? payload.riskSource ?? null;
    const riskModel = classifier.riskModel ?? payload.riskModel ?? null;
    const topRiskFactorsRaw = classifier.topRiskFactors ?? payload.topRiskFactors ?? [];
    const topRiskFactors = Array.isArray(topRiskFactorsRaw) ? topRiskFactorsRaw : [];
    const evmType = classifier.evmType ?? payload.evmType ?? null;
    const isProxy = classifier.isProxy ?? payload.isProxy ?? null;
    const standardsRaw = classifier.standards ?? payload.standards ?? [];
    const standards = Array.isArray(standardsRaw) ? standardsRaw : [];
    const contractName = classifier.contractName ?? payload.contractName ?? null;
    const proxyTarget = classifier.proxyTarget ?? payload.proxyTarget ?? null;
    const sourceOrigin = classifier.sourceOrigin ?? payload.sourceOrigin ?? null;
    const riskDimensions = classifier.riskDimensions ?? payload.riskDimensions ?? null;
    const riskRationale = classifier.riskRationale ?? payload.riskRationale ?? null;
    const riskLatencyMs = classifier.riskLatencyMs ?? payload.riskLatencyMs ?? null;
    const riskComponents = classifier.riskComponents ?? payload.riskComponents ?? null;

    const hasMetadata =
      riskSource != null ||
      riskModel != null ||
      topRiskFactors.length > 0 ||
      evmType != null ||
      isProxy != null ||
      contractName != null ||
      proxyTarget != null ||
      standards.length > 0 ||
      sourceOrigin != null;

    if (!hasMetadata) return null;
    return {
      riskSource,
      riskModel,
      topRiskFactors,
      evmType,
      isProxy,
      standards,
      contractName,
      proxyTarget,
      sourceOrigin,
      riskDimensions,
      riskRationale,
      riskLatencyMs,
      riskComponents,
    };
  }

  buildClassifierHints(classifierMetadata) {
    if (!classifierMetadata) return null;
    return {
      riskSource: classifierMetadata.riskSource ?? null,
      riskModel: classifierMetadata.riskModel ?? null,
      topRiskFactors: Array.isArray(classifierMetadata.topRiskFactors)
        ? classifierMetadata.topRiskFactors
        : [],
      evmType: classifierMetadata.evmType ?? null,
      isProxy: classifierMetadata.isProxy ?? null,
    };
  }

  hasOpenJobForContract(contractAddress) {
    const normalized = this.normalizeAddress(contractAddress).toLowerCase();
    if (!normalized) return false;
    for (const job of this.jobs.values()) {
      const jobAddress = this.normalizeAddress(job?.contractAddress).toLowerCase();
      if (!jobAddress || jobAddress !== normalized) continue;
      if (job?.reportPublished) continue;
      if (job?.cancelledOnChain) continue;
      if (job?.terminalOnChain) continue;
      return true;
    }
    return false;
  }

  shouldDedupeDiscovery(contractAddress) {
    if (!this.discoveryDedupeEnabled) return false;
    const normalized = this.normalizeAddress(contractAddress).toLowerCase();
    if (!normalized) return false;

    const nowMs = Date.now();
    const seenAt = this.recentDiscovery.get(normalized) ?? 0;
    const withinTtl = seenAt > 0 && nowMs - seenAt <= this.discoveryDedupeTtlMs;
    const hasOpenJob = this.hasOpenJobForContract(normalized);
    if (!withinTtl && !hasOpenJob) return false;

    this.recentDiscovery.set(normalized, nowMs);
    return true;
  }

  markDiscoverySeen(contractAddress) {
    const normalized = this.normalizeAddress(contractAddress).toLowerCase();
    if (!normalized) return;
    this.recentDiscovery.set(normalized, Date.now());
  }

  async syncRosterFromRegistry() {
    if (!this.rosterBootstrapOnchain) {
      this.log.info("On-chain roster bootstrap disabled by config");
      return;
    }
    const getAllAgents =
      this.contracts.getAllAgents?.bind(this.contracts) ??
      this.contracts.agentRegistry?.getAllAgents?.bind(this.contracts.agentRegistry);
    const getAgent =
      this.contracts.getAgent?.bind(this.contracts) ??
      this.contracts.agentRegistry?.getAgent?.bind(this.contracts.agentRegistry);
    const isActiveAgent =
      this.contracts.isActiveAgent?.bind(this.contracts) ??
      this.contracts.agentRegistry?.isActiveAgent?.bind(this.contracts.agentRegistry);

    if (typeof getAllAgents !== "function" || typeof getAgent !== "function" || typeof isActiveAgent !== "function") {
      this.log.warn("On-chain roster bootstrap skipped: AgentRegistry read methods unavailable");
      return;
    }

    const allAgents = await getAllAgents();
    const agentAddresses = Array.isArray(allAgents) ? allAgents : [];
    if (!agentAddresses.length) {
      this.log.info("On-chain roster bootstrap returned zero registered agents");
      return;
    }

    let upserted = 0;
    let activeCount = 0;
    for (const rawAddress of agentAddresses) {
      const evmAddress = this.normalizeAddress(rawAddress);
      if (!evmAddress) continue;

      let active = false;
      try {
        active = Boolean(await isActiveAgent(evmAddress));
      } catch (err) {
        this.log.warn(`On-chain active check failed for ${evmAddress}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.onchainActiveCache.set(evmAddress.toLowerCase(), { active, checkedAt: Date.now() });
      if (!active) continue;
      activeCount += 1;

      let profile = null;
      try {
        profile = await getAgent(evmAddress);
      } catch (err) {
        this.log.warn(`On-chain getAgent failed for ${evmAddress}: ${err instanceof Error ? err.message : String(err)}`);
        profile = null;
      }

      const agentId = String(profile?.agentId || `onchain-${evmAddress.slice(2, 10)}`);
      const stake = this.toGuardAmount(profile?.stakedAmount ?? profile?.stakeAmount ?? 0n);
      const reputation = this.toNumeric(profile?.reputationScore ?? profile?.reputation ?? 0);
      const specializations = Array.isArray(profile?.specializations) && profile.specializations.length
        ? profile.specializations.map((s) => String(s))
        : ["any"];
      const endpoint = String(profile?.ucpEndpoint ?? "");

      this.roster.upsert({
        agentId,
        evmAddress,
        specializations,
        stake,
        reputation,
        endpoint,
      });
      upserted += 1;
    }
    this.log.info(
      `On-chain roster bootstrap complete: active=${activeCount}, roster_upserts=${upserted}, total_registry_entries=${agentAddresses.length}`
    );
  }

  async getCachedOnchainActiveStatus(evmAddress) {
    const normalized = this.normalizeAddress(evmAddress);
    if (!normalized) return { active: false, unavailable: false, reason: "invalid_address" };
    const key = normalized.toLowerCase();
    const cached = this.onchainActiveCache.get(key);
    if (cached && Date.now() - cached.checkedAt <= this.onchainActiveCacheTtlMs) {
      return { active: cached.active, unavailable: false, reason: null };
    }
    const isActiveAgent =
      this.contracts.isActiveAgent?.bind(this.contracts) ??
      this.contracts.agentRegistry?.isActiveAgent?.bind(this.contracts.agentRegistry);
    if (typeof isActiveAgent !== "function") {
      return { active: true, unavailable: false, reason: null };
    }

    let lastError = "";
    const attempts = Math.max(1, this.activeCheckRetries);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const active = Boolean(await isActiveAgent(normalized));
        this.onchainActiveCache.set(key, { active, checkedAt: Date.now() });
        return { active, unavailable: false, reason: null };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const retriable = this.isTransientRpcError(lastError);
        if (!retriable || attempt === attempts) break;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    // If live RPC is transiently unavailable, reuse stale on-chain cache
    // so invite eligibility doesn't collapse to zero for healthy agents.
    if (cached) {
      const cacheAgeMs = Date.now() - cached.checkedAt;
      if (cacheAgeMs <= this.onchainActiveStaleFallbackTtlMs) {
        this.log.warn(
          `Invite-time on-chain active check failed for ${normalized}; using stale cache ` +
          `(age=${cacheAgeMs}ms, active=${cached.active}): ${lastError}`
        );
        return {
          active: cached.active,
          unavailable: true,
          reason: `stale_cache_fallback:${lastError}`,
        };
      }
    }

    this.log.warn(
      `Invite-time on-chain active check failed for ${normalized}: ${lastError}`
    );
    if (this.activeCheckFailOpen) {
      return { active: true, unavailable: true, reason: lastError };
    }
    return { active: false, unavailable: true, reason: lastError };
  }

  async filterEligibleAgentsOnChain(eligibleAgents) {
    if (!this.filterInvitesOnchainActive) {
      return { eligible: eligibleAgents, excluded: [] };
    }

    const eligible = [];
    const excluded = [];
    for (const agent of eligibleAgents) {
      const evmAddress = this.normalizeAddress(agent?.evmAddress);
      if (!evmAddress) {
        excluded.push({
          agentId: agent?.agentId ?? "unknown",
          evmAddress: agent?.evmAddress ?? null,
          reasons: ["missing_evm_address"],
        });
        continue;
      }
      const activeCheck = await this.getCachedOnchainActiveStatus(evmAddress);
      if (activeCheck.active) {
        eligible.push(agent);
      } else {
        excluded.push({
          agentId: agent?.agentId ?? "unknown",
          evmAddress,
          reasons: [activeCheck.unavailable ? "active_check_unavailable" : "inactive_onchain"],
        });
      }
    }
    return { eligible, excluded };
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  subscribeDiscovery() {
    this.hcs.subscribeDiscovery(async (msg) => {
      if (msg.type !== MessageType.CONTRACT_DISCOVERED) return;
      await this.handleDiscovery(msg);
    });
    this.log.info(`Listening on discovery topic ${CONFIG.hcsTopics.discovery}`);
  }

  subscribeAgentComms() {
    this.hcs.subscribeAgentComms(async (msg) => {
      if (msg.type === MessageType.PONG) this.roster.recordPong(msg.agentId);
      if (msg.type === MessageType.FINDINGS_SUBMITTED) await this.handleFindings(msg);
      if (msg.type === "REPORT_PUBLISHED") await this.handleReportPublished(msg);
      if (msg.type === MessageType.DATA_LISTING_CREATED) await this.handleDataListing(msg);
      if (msg.type === MessageType.SUB_AUCTION_POSTED) await this.handleSubAuctionRequest(msg);
      if (msg.type === MessageType.SUB_RESULT_DELIVERED) await this.handleSubResult(msg);
    });
    this.log.info(`Listening on agentComms topic ${CONFIG.hcsTopics.agentComms}`);
  }

  subscribeAuditLog() {
    this.hcs.subscribeAuditLog((msg) => {
      if (msg.type === MessageType.AGENT_REGISTERED) this.handleAgentRegistered(msg);
      if (msg.type === "BID_SUBMITTED") this.handleBidSubmitted(msg);
    });
    this.log.info(`Listening on auditLog topic ${CONFIG.hcsTopics.auditLog}`);
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  handleAgentRegistered(msg) {
    const payload = msg.payload || {};
    this.roster.upsert({
      agentId: msg.agentId,
      evmAddress: payload.evmAddress,
      specializations: payload.specializations ?? ["any"],
      stake: payload.stake ?? 0,
      reputation: payload.reputation ?? 0,
      endpoint: payload.ucpEndpoint,
    });
  }

  handleBidSubmitted(msg) {
    const { jobId, contractAddress, bidAmount, collateral, estimatedTimeSec, reputation, evmAddress } = msg.payload || {};
    const key = this.normalizeJobId(jobId);
    if (!key) {
      this.log.warn(`Bid from ${msg.agentId} — missing jobId`);
      return;
    }

    const job = this.getJobByKey(key);
    if (!job || job.cancelledOnChain || job.terminalOnChain || job.reportPublished) {
      this.log.warn(`Bid from ${msg.agentId} — no matching open job for jobId ${key}`);
      return;
    }

    if (
      contractAddress &&
      job.contractAddress &&
      String(contractAddress).toLowerCase() !== String(job.contractAddress).toLowerCase()
    ) {
      this.log.warn(
        `Bid rejected from ${msg.agentId}: jobId/address mismatch ` +
        `(jobId=${key}, payload=${String(contractAddress).slice(0, 12)}, job=${String(job.contractAddress).slice(0, 12)})`
      );
      return;
    }

    const agent = this.roster.get(msg.agentId);
    const minStake = CONFIG.stakes.minStake;
    if (agent && (agent.stake ?? 0) < minStake) {
      this.log.warn(`Bid rejected from ${msg.agentId}: stake ${agent.stake} < ${minStake}`);
      return;
    }
    if (bidAmount <= 0) {
      this.log.warn(`Bid rejected from ${msg.agentId}: invalid amount ${bidAmount}`);
      return;
    }

    if (!Array.isArray(job.bidders)) {
      job.bidders = [];
    }
    const resolvedEvmAddress = this.normalizeAddress(evmAddress ?? agent?.evmAddress);
    let duplicateReason = "";
    for (const existing of job.bidders) {
      if (String(existing?.agentId ?? "") === String(msg.agentId)) {
        duplicateReason = "duplicate_agent_id";
        break;
      }
      if (!resolvedEvmAddress) continue;
      const existingAddress = this.normalizeAddress(existing?.evmAddress);
      if (!existingAddress || existingAddress.toLowerCase() !== resolvedEvmAddress.toLowerCase()) continue;
      duplicateReason = "duplicate_evm_address";
      if (String(existing?.agentId ?? "") !== String(msg.agentId)) {
        this.log.warn(
          `Bid dedupe on shared EVM address for job ${key}: ` +
          `${String(existing?.agentId ?? "unknown")} and ${String(msg.agentId)} -> ${resolvedEvmAddress}`
        );
      }
      break;
    }
    if (duplicateReason) {
      this.log.info(`Bid deduped (${duplicateReason}): ${msg.agentId} for job ${key}`);
      this.hcs.publishAuditLog({
        type: "BID_DEDUPED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId: key,
          duplicateReason,
          agentId: msg.agentId,
          evmAddress: resolvedEvmAddress || (evmAddress ?? agent?.evmAddress ?? null),
        },
      }).catch(() => { });
      return;
    }

    job.bidders.push({
      agentId: msg.agentId,
      evmAddress: resolvedEvmAddress || (evmAddress ?? agent?.evmAddress),
      bidAmount: bidAmount ?? 0,
      collateral: collateral ?? 0,
      estimatedTimeSec: estimatedTimeSec ?? 0,
      reputation: reputation ?? agent?.reputation ?? 0,
      timestamp: msg.timestamp ?? now(),
    });
    job.hcsBidCount = Number(job.hcsBidCount ?? 0) + 1;
    this.setJobByKey(key, job);

    this.log.info(
      `Bid recorded: ${msg.agentId} bid ${bidAmount} GUARD for job ${key} ` +
      `(total bids: ${job.bidders.length})`
    );
  }

  async handleDiscovery(msg) {
    await this.rosterBootstrapPromise.catch(() => { });
    const { contractAddress, contractType, budget, riskScore, estimatedLOC, deployerAddress } = msg.payload;
    const classifierMetadata = this.extractClassifierMetadata(msg.payload || {});
    if (this.shouldDedupeDiscovery(contractAddress)) {
      this.log.info(`Discovery deduped for ${String(contractAddress).slice(0, 12)}…`);
      await this.hcs.publishAuditLog({
        type: "DISCOVERY_DEDUPED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          contractAddress,
          contractType: contractType ?? "unknown",
          reason: "recent_duplicate_or_open_job_exists",
        },
      });
      return;
    }
    try {
      this.validateDiscoveryPayload({ contractAddress, budget, riskScore, estimatedLOC });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`Discovery rejected: ${reason}`);
      await this.hcs.publishAuditLog({
        type: "DISCOVERY_REJECTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          reason,
          strictLive: this.strictLive,
          contractAddress: contractAddress ?? "",
          contractType: contractType ?? "unknown",
        },
      });
      return;
    }
    this.markDiscoverySeen(contractAddress);

    let jobId = "";
    let auctionOpenedOnChain = false;
    let auctionDeadlineSec = null;
    let createAttempts = 0;
    let createTxHash = null;
    const createCorrelationId = `create:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
    const budgetGuardRaw = Number(budget ?? CONFIG.payments.totalGuard ?? 0);
    const budgetGuard = Number.isFinite(budgetGuardRaw) && budgetGuardRaw > 0
      ? budgetGuardRaw
      : Number(CONFIG.payments.totalGuard);
    this.log.info(`New discovery ${contractAddress.slice(0, 12)}… type=${contractType}`);

    // Open auction on-chain (async — bids can arrive while this runs)
    try {
      await this.withCreateAuditJobLock(async () => {
        const createMaxAttempts = Math.max(1, Number(CONFIG.createRetry?.maxAttempts ?? 1));
        const createBackoffMs = Math.max(1, Number(CONFIG.createRetry?.backoffMs ?? 500));
        const createBackoffMaxMs = Math.max(createBackoffMs, Number(CONFIG.createRetry?.maxBackoffMs ?? 10_000));
        const auctionDurationMs = Math.max(
          Number(CONFIG.timeouts?.auctionDurationMs ?? CONFIG.timeouts.winnerWaitMs),
          Number(CONFIG.timeouts?.minAuctionDurationMs ?? 30_000)
        );
        const auctionDurationSec = Math.max(1, Math.ceil(auctionDurationMs / 1000));
        const budgetWei = parseUnits(String(budgetGuard), CONFIG.guardToken.decimals);
        const createAuditJob =
          this.contracts.createAuditJob?.bind(this.contracts) ??
          this.contracts.auction?.createAuditJob?.bind(this.contracts.auction);
        if (typeof createAuditJob !== "function") {
          throw new Error("createAuditJob unavailable on contract client");
        }

        let lastCreateError = null;
        for (let attempt = 1; attempt <= createMaxAttempts; attempt++) {
          createAttempts = attempt;
          let expectedOnChainJobId = null;
          try {
            await this.ensureOrchestratorOperationalHbar("create_audit_job", { force: true });
            const expectedJobIdRaw = await this.contracts.auction.nextJobId?.();
            expectedOnChainJobId = expectedJobIdRaw != null ? Number(expectedJobIdRaw) : null;

            const tx = await createAuditJob(
              contractAddress,
              "hedera-testnet",
              contractType ?? "unknown",
              riskScore ?? 0,
              budgetWei,
              estimatedLOC ?? 0,
              auctionDurationSec
            );

            const receipt = await tx.wait();
            if (!receipt || (receipt.status != null && receipt.status !== 1)) {
              throw new Error(`createAuditJob tx failed: ${tx.hash}`);
            }

            let onChainJobId = Number.isFinite(expectedOnChainJobId) ? expectedOnChainJobId : null;
            let parsedDeadlineSec = null;
            if (receipt?.logs) {
              for (const log of receipt.logs) {
                try {
                  const parsed = this.contracts.auction.interface.parseLog(log);
                  if (parsed?.name === "JobPosted") {
                    const parsedJobId = Number(this.normalizeJobId(parsed.args.jobId));
                    if (Number.isFinite(parsedJobId)) onChainJobId = parsedJobId;
                    const parsedDeadline = Number(parsed?.args?.auctionDeadline);
                    if (Number.isFinite(parsedDeadline) && parsedDeadline > 0) {
                      parsedDeadlineSec = parsedDeadline;
                    }
                    break;
                  }
                } catch { /* ignore */ }
              }
            }

            // Hedera receipts occasionally return without parseable logs for this tx.
            // If that happens, infer the posted job from post-tx nextJobId.
            if (onChainJobId == null || !Number.isFinite(onChainJobId)) {
              try {
                const postTxNextJobIdRaw = await this.contracts.auction.nextJobId?.();
                const postTxNextJobId = postTxNextJobIdRaw != null ? Number(postTxNextJobIdRaw) : null;
                if (Number.isFinite(postTxNextJobId) && postTxNextJobId > 0) {
                  onChainJobId = postTxNextJobId - 1;
                }
              } catch {
                // Keep original failure below if post-tx lookup also fails.
              }
            }

            if (onChainJobId == null || !Number.isFinite(onChainJobId)) {
              throw new Error("createAuditJob succeeded but JobPosted jobId could not be resolved");
            }

            let resolvedDeadlineSec = parsedDeadlineSec;
            if (!Number.isFinite(resolvedDeadlineSec) || resolvedDeadlineSec <= 0) {
              try {
                const getJob =
                  this.contracts.getJob?.bind(this.contracts) ??
                  this.contracts.auction?.getJob?.bind(this.contracts.auction);
                if (typeof getJob === "function") {
                  const onChainJob = await getJob(this.toChainJobId(onChainJobId));
                  const chainDeadlineSec = Number(onChainJob?.auctionDeadline);
                  if (Number.isFinite(chainDeadlineSec) && chainDeadlineSec > 0) {
                    resolvedDeadlineSec = chainDeadlineSec;
                  }
                }
              } catch {
                // fallback below
              }
            }
            if (!Number.isFinite(resolvedDeadlineSec) || resolvedDeadlineSec <= 0) {
              const fallbackWinnerWaitSec = Math.max(
                1,
                Math.ceil(Number(CONFIG.timeouts?.winnerWaitMs ?? (auctionDurationSec * 1000)) / 1000)
              );
              resolvedDeadlineSec = Math.floor(Date.now() / 1000) + fallbackWinnerWaitSec;
            }

            jobId = this.normalizeJobId(onChainJobId);
            auctionDeadlineSec = Math.floor(Number(resolvedDeadlineSec));
            auctionOpenedOnChain = true;
            createTxHash = tx.hash ?? null;
            this.log.info(
              `Auction opened on-chain for job ${jobId} (tx: ${tx.hash}, deadlineSec=${auctionDeadlineSec})`
            );
            return;
          } catch (err) {
            lastCreateError = err;
            const message = err instanceof Error ? err.message : String(err);
            const nonceError = this.isNonceTooLowError(message);
            const lowFundsError = this.isInsufficientFundsError(message);
            const transientRpc = this.isTransientRpcError(message);
            const retriable = nonceError || lowFundsError || transientRpc;
            const finalAttempt = attempt >= createMaxAttempts;

            if (lowFundsError && !finalAttempt) {
              this.log.warn(
                `createAuditJob low-funds precheck (attempt ${attempt}/${createMaxAttempts}) — forcing HBAR top-up and retry`
              );
              try {
                await this.ensureOrchestratorOperationalHbar("create_audit_job_retry", { force: true });
              } catch (topupErr) {
                this.log.warn(
                  `createAuditJob top-up retry failed: ${topupErr instanceof Error ? topupErr.message : String(topupErr)}`
                );
              }
            } else if (nonceError && !finalAttempt) {
              this.log.warn(
                `createAuditJob nonce race (attempt ${attempt}/${createMaxAttempts}) — retrying`
              );
            } else if (transientRpc && !finalAttempt) {
              this.log.warn(
                `createAuditJob transient RPC failure (attempt ${attempt}/${createMaxAttempts}) — retrying`
              );
            }

            if (!retriable || finalAttempt) {
              throw err;
            }

            const delayMs = Math.min(createBackoffMaxMs, createBackoffMs * (2 ** Math.max(0, attempt - 1)));
            if (attempt === 1) {
              await this.hcs.publishAuditLog({
                type: "JOB_CREATE_DEFERRED",
                agentId: "orchestrator",
                timestamp: now(),
                payload: {
                  createCorrelationId,
                  contractAddress,
                  contractType: contractType ?? "unknown",
                  attempt,
                  maxAttempts: createMaxAttempts,
                  error: message,
                  nextRetryInMs: delayMs,
                },
              }).catch(() => { });
            }
            await this.hcs.publishAuditLog({
              type: "JOB_CREATE_RETRYING",
              agentId: "orchestrator",
              timestamp: now(),
              payload: {
                createCorrelationId,
                contractAddress,
                contractType: contractType ?? "unknown",
                attempt,
                maxAttempts: createMaxAttempts,
                error: message,
                nextRetryInMs: delayMs,
              },
            }).catch(() => { });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }

        const errorMessage = lastCreateError instanceof Error ? lastCreateError.message : String(lastCreateError);
        throw new Error(errorMessage);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Auction create failed: ${message}`);
      await this.hcs.publishAuditLog({
        type: "ONCHAIN_TX_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          phase: "create_audit_job",
          strictLive: this.strictLive,
          contractAddress,
          createCorrelationId,
          attempts: createAttempts,
          error: message,
        },
      });
      await this.hcs.publishAuditLog({
        type: "JOB_CREATE_ABORTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          createCorrelationId,
          contractAddress,
          contractType: contractType ?? "unknown",
          attempts: createAttempts,
          error: message,
        },
      }).catch(() => { });
      if (this.strictLive) {
        this.log.warn(`Strict live mode: halting discovery after createAuditJob failure`);
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            createCorrelationId,
            contractAddress,
            phase: "create_audit_job",
            error: message,
          },
        });
      }
      return;
    }

    this.setJobByKey(jobId, {
      contractAddress,
      deployerAddress: normalizeDeployer(deployerAddress ?? ''),
      contractType,
      classifier: classifierMetadata,
      bidders: [],
      openedAt: now(),
      onChainJobId: Number(jobId),
      auctionDeadlineSec,
      createCorrelationId,
      winners: [],
      findings: [],
      reportPublished: false,
    });

    // Publish a normalized auction-opened signal for dashboard/live listeners.
    try {
      await this.hcs.publishAuditLog({
        type: "JOB_CREATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractAddress,
          contractType: contractType ?? "unknown",
          budget: budgetGuard,
          riskScore: riskScore ?? 0,
          estimatedLOC: estimatedLOC ?? 0,
          onChain: auctionOpenedOnChain,
          auctionDeadlineSec,
          createCorrelationId,
          createAttempts,
          createTxHash,
          ...(classifierMetadata ? { classifier: classifierMetadata } : {}),
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish JOB_CREATED for ${contractAddress?.slice(0, 12)}: ${err}`);
    }

    // Avoid startup races where discoveries arrive before on-chain roster hydration
    // has populated active agents.
    await this.rosterBootstrapPromise.catch(() => { });

    const eligibility = typeof this.roster.evaluateEligibility === "function"
      ? this.roster.evaluateEligibility(contractType)
      : { eligible: this.roster.eligibleFor(contractType), excluded: [] };
    let eligible = Array.isArray(eligibility.eligible) ? eligibility.eligible : [];
    const excludedAgents = Array.isArray(eligibility.excluded) ? [...eligibility.excluded] : [];
    const onchainFiltered = await this.filterEligibleAgentsOnChain(eligible);
    eligible = onchainFiltered.eligible;
    excludedAgents.push(...onchainFiltered.excluded);

    // One-shot repair path: if eligibility collapses to zero, resync roster
    // from on-chain registry and evaluate again before giving up.
    if (eligible.length === 0 && this.rosterBootstrapOnchain) {
      try {
        await this.syncRosterFromRegistry();
        const refreshedEligibility = typeof this.roster.evaluateEligibility === "function"
          ? this.roster.evaluateEligibility(contractType)
          : { eligible: this.roster.eligibleFor(contractType), excluded: [] };
        const refreshedOnchainFiltered = await this.filterEligibleAgentsOnChain(
          Array.isArray(refreshedEligibility.eligible) ? refreshedEligibility.eligible : []
        );
        if (refreshedOnchainFiltered.eligible.length > 0) {
          eligible = refreshedOnchainFiltered.eligible;
          excludedAgents.length = 0;
          excludedAgents.push(
            ...(Array.isArray(refreshedEligibility.excluded) ? refreshedEligibility.excluded : []),
            ...refreshedOnchainFiltered.excluded
          );
          this.log.info(`Invite eligibility recovered after on-chain roster resync for job ${jobId}`);
        }
      } catch (err) {
        this.log.warn(
          `Invite eligibility roster resync failed for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const excludedByReason = {};
    for (const item of excludedAgents) {
      for (const reason of item.reasons ?? []) {
        excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
      }
    }
    this.log.info(
      `Invite eligibility for job ${jobId}: eligible=${eligible.length} excluded=${excludedAgents.length} ` +
      `${JSON.stringify(excludedByReason)}`
    );
    const inviteTrackedJob = this.getJobByKey(jobId);
    if (inviteTrackedJob) {
      inviteTrackedJob.eligibleInvitedCount = eligible.length;
      inviteTrackedJob.excludedInviteCount = excludedAgents.length;
      this.setJobByKey(jobId, inviteTrackedJob);
    }
    try {
      await this.hcs.publishAuditLog({
        type: "AUCTION_INVITE_SUMMARY",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractType: contractType ?? "unknown",
          eligibleAgents: eligible.map((agent) => ({
            agentId: agent.agentId,
            evmAddress: agent.evmAddress,
          })),
          eligible_invited_count: eligible.length,
          excludedAgents,
          excludedByReason,
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish AUCTION_INVITE_SUMMARY for job ${jobId}: ${err}`);
    }
    try {
      await this.inviteAgents(jobId, eligible, msg.payload, classifierMetadata);
    } catch (err) {
      this.log.warn(`Failed to publish AUCTION_INVITE messages for job ${jobId}: ${err}`);
    }

    // ── Redeploy detection: notify AuditScheduler if contract is in REDEPLOY mode ──
    if (this.contracts.auditScheduler?.getSchedule) {
      try {
        const sched = await this.contracts.auditScheduler.getSchedule(contractAddress);
        // TriggerMode 1 = REDEPLOY; only notify if active
        if (sched?.active && Number(sched.mode) === 1) {
          const bytecodeHash = msg.payload?.bytecodeHash;
          const storedHash = sched._bytecodeHash ?? null; // we track this in memory across calls
          if (bytecodeHash && storedHash && bytecodeHash !== storedHash) {
            await this.contracts.auditScheduler.onRedeployDetected(contractAddress);
            this.log.info(`Redeploy detected for ${contractAddress.slice(0, 12)}… — HSS schedule armed`);
          }
          // Cache current hash for future comparisons
          sched._bytecodeHash = bytecodeHash;
        }
      } catch (err) {
        this.log.warn(`AuditScheduler redeploy check failed: ${err.message}`);
      }
    }

    // Winner selection timer.
    if (!this.strictLive || auctionOpenedOnChain) {
      this.scheduleWinnerSelection(jobId, auctionDeadlineSec, "timer");
    }
  }

  async handleFindings(msg) {
    const { jobId, findingsHash, evmAddress, findingsCount = 0, criticalCount = 0 } = msg.payload;
    this.log.info(`Findings submitted for job ${jobId}: ${findingsHash?.slice(0, 12)}…`);

    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key) ?? { findings: [], winners: [], bidders: [], reportPublished: false, settled: false };
    const resolvedAddress =
      (typeof evmAddress === "string" && ethers.isAddress(evmAddress) ? evmAddress : undefined) ??
      this.roster.get(msg.agentId)?.evmAddress;

    job.findings.push({
      agentId: msg.agentId,
      evmAddress: resolvedAddress,
      findingsHash,
      findingsCount,
      criticalCount
    });
    this.setJobByKey(key, job);

    // Start time-based auto-publish timer on first finding
    if (job.findings.length === 1 && !job.reportPublished) {
      const publishTimer = setTimeout(async () => {
        const latest = this.getJobByKey(key);
        if (latest && !latest.reportPublished) {
          this.log.info(`Auto-publish timeout for job ${jobId} — publishing report`);
          await this.autoPublishReport(key, latest);
        }
      }, CONFIG.reporting.autoPublishTimeoutMs);
      publishTimer.unref?.();
    }

    // Threshold-based auto-publish
    if (job.findings.length >= CONFIG.reporting.autoPublishAfterFindings && !job.reportPublished) {
      await this.autoPublishReport(key, job);
    }
  }

  async autoPublishReport(jobId, job) {
    if (job.reportPublished) return;
    const key = this.normalizeJobId(jobId);
    await this.handleReportPublished({
      payload: {
        jobId: key,
        totalFindings: job.findings.reduce((s, f) => s + (f.findingsCount ?? 0), 0),
        criticalFindings: job.findings.reduce((s, f) => s + (f.criticalCount ?? 0), 0),
        reportHash: job.findings.map((f) => f.findingsHash).join("|").slice(0, 66),
      },
    });
  }

  async handleReportPublished(msg) {
    const { jobId, totalFindings = 0, reportHash } = msg.payload || {};
    const criticalFindings = Number(msg.payload?.criticalFindings ?? msg.payload?.criticalCount ?? 0);
    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key) ?? { findings: [], winners: [], reportPublished: false, settled: false };
    if (job.reportPublished) return;

    this.log.info(`Report published for job ${jobId} (hash ${String(reportHash).slice(0,16)}...)`);
    job.reportPublished = true;
    this.setJobByKey(key, job);

    // Persist report to S3 + PostgreSQL
    generateAndStoreReport(key, job, job.findings ?? [])
      .then(() => this.log.info(`[ReportWriter] Saved report for job ${key}`))
      .catch((err) => this.log.warn(`[ReportWriter] Failed for job ${key}: ${err.message}`));

    // Relay report publish to auditLog (ensures HCS has the hash)
    await this.hcs.publishAuditLog({
      type: "REPORT_PUBLISHED",
      agentId: msg.agentId ?? "report-agent",
      timestamp: now(),
      payload: {
        jobId,
        totalFindings,
        criticalFindings,
        reportHash,
        contributors: job.findings.map((f) => f.agentId),
      },
    });

    if (!job.winners?.length) {
      this.requestWinnerSelection(key, { sourcePath: "report_published" }).catch((err) => {
        this.log.warn(
          `[Orchestrator] report-published winner selection dispatch failed for job ${key}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      });
    }

    await this.maybeAlert(key, criticalFindings);
    const reportAgentAddress = this.resolveReportAgentAddress(msg);
    await this.settleAll(key, job, reportAgentAddress);
    await this.updateReputation(key, job.findings);
    await this.inft.markJobCompleted(key, null);
  }

  async handleDataListing(msg) {
    const payload = msg.payload || {};
    const { listingId, category, price, jobId } = payload;
    if (!CONFIG.dataMarketplace.allowedCategories.includes(category)) return;
    if (price > CONFIG.dataMarketplace.maxAutoBuyGuard) return;
    const numericListingId = Number(listingId);
    if (!Number.isFinite(numericListingId) || numericListingId <= 0) {
      this.log.warn(`Auto-buy skipped: invalid listingId ${listingId}`);
      return;
    }

    if (this.strictLive) {
      const buyer = this.orchestratorAddress;
      if (!buyer || !ethers.isAddress(buyer)) {
        this.log.warn(`Strict live: skipping auto-buy for listing ${listingId}, invalid orchestrator buyer address`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "invalid_buyer_address" },
        });
        return;
      }

      if (!this.contracts.agentRegistry?.isActiveAgent) {
        this.log.info(`Strict live: skipping auto-buy for listing ${listingId}, cannot verify buyer activity`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "agent_registry_unavailable", buyer },
        });
        return;
      }

      const isActive = await this.contracts.agentRegistry.isActiveAgent(buyer);
      if (!isActive) {
        this.log.info(`Strict live: skipping auto-buy for listing ${listingId}, buyer ${buyer} is not an active agent`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "inactive_buyer_agent", buyer },
        });
        return;
      }
    }

    try {
      await this.ensureOrchestratorOperationalHbar("data_marketplace_auto_buy", { force: true });
      const listingKey = this.toChainUint(listingId, "listingId");
      await this.contracts.purchaseData(listingKey);
      this.log.info(`Auto-bought listing ${listingId} (${category}) for ${price} GUARD`);
      await this.hcs.publishAuditLog({
        type: "DATA_PURCHASED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { listingId, price, jobId, buyer: "orchestrator" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Auto-buy failed for listing ${listingId}: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "data_marketplace_auto_buy",
            listingId,
            strictLive: true,
            error: message,
            jobId,
          },
        });
      }
    }
  }

  async handleSubAuctionRequest(msg) {
    const p = msg.payload || {};
    const { parentJobId, taskType, paymentAmount } = p;
    const payGuard = paymentAmount ?? CONFIG.subAuction.paymentGuard;
    const paymentWei = parseUnits(payGuard.toString(), CONFIG.guardToken.decimals);

    try {
      await this.ensureOrchestratorOperationalHbar("create_sub_auction", { force: true });
      const parentId = this.toChainUint(parentJobId, "parentJobId");
      await this.contracts.createSubAuction(
        parentId,
        taskType ?? "dependency_analysis",
        taskType ?? "dependency_analysis",
        paymentWei,
        CONFIG.subAuction.slaSeconds,
        CONFIG.subAuction.auctionDurationSeconds,
      );
      this.log.info(`Created sub-auction for job ${parentJobId} task=${taskType}`);
      await this.hcs.publishAuditLog({
        type: "SUB_AUCTION_CREATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { parentJobId, taskType, paymentGuard: payGuard },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Sub-auction creation failed: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "create_sub_auction",
            strictLive: true,
            parentJobId: this.normalizeJobId(parentJobId),
            error: message,
          },
        });
      }
    }
  }

  async handleSubResult(msg) {
    const { subAuctionId } = msg.payload || {};
    try {
      await this.ensureOrchestratorOperationalHbar("accept_sub_result", { force: true });
      const subId = this.toChainUint(subAuctionId, "subAuctionId");
      await this.contracts.acceptSubResult(subId);
      this.log.info(`Accepted sub-auction result ${subAuctionId}`);
      await this.hcs.publishAuditLog({
        type: "SUB_RESULT_ACCEPTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { subAuctionId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Accepting sub result failed: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "accept_sub_result",
            strictLive: true,
            subAuctionId: this.normalizeId(subAuctionId),
            error: message,
          },
        });
      }
    }
  }

  // Report publishing now handled by the Report Agent; orchestrator waits for REPORT_PUBLISHED

  async maybeAlert(jobId, criticalTotal) {
    if (criticalTotal < CONFIG.alerts.criticalThreshold) return;
    await this.hcs.publishAuditLog({
      type: "ALERT_FIRED",
      agentId: "orchestrator",
      timestamp: now(),
      payload: { jobId, criticalFindings: criticalTotal },
    });
    this.log.info(`Alert fired for job ${jobId} (critical=${criticalTotal})`);
  }

  async settleAll(jobId, job, reportAgentAddress) {
    const findingsArr = job?.findings ?? [];
    if (!findingsArr.length) return;

    if (job?.settled) {
      this.log.info(`Job ${jobId} already settled in-memory, skipping`);
      return;
    }

    const onChainSettled = await this.isJobAlreadySettledOnChain(jobId);
    if (onChainSettled) {
      this.log.info(`Job ${jobId} already settled on-chain, skipping`);
      job.settled = true;
      this.setJobByKey(jobId, job);
      return;
    }

    const winnerSet = new Set((job.winners ?? []).map((w) => String(w).toLowerCase()));
    if (!winnerSet.size) {
      this.log.warn(`Settlement skipped for job ${jobId}: no winners selected`);
      return;
    }

    const contributorScores = new Map();
    for (const finding of findingsArr) {
      const address =
        (typeof finding.evmAddress === "string" && ethers.isAddress(finding.evmAddress)
          ? finding.evmAddress
          : this.roster.get(finding.agentId)?.evmAddress);
      if (!address || !winnerSet.has(address.toLowerCase())) continue;

      const current = contributorScores.get(address.toLowerCase()) ?? {
        recipient: address,
        agentId: finding.agentId,
        score: 0,
        critical: 0
      };
      current.score += (finding.findingsCount ?? 0) + 2 * (finding.criticalCount ?? 0);
      current.critical += (finding.criticalCount ?? 0);
      contributorScores.set(address.toLowerCase(), current);
    }

    const scores = Array.from(contributorScores.values()).filter((f) => f.score > 0);
    if (!scores.length) {
      this.log.warn(`Settlement skipped for job ${jobId}: no winner findings with valid addresses`);
      return;
    }

    const totalPool = parseUnits(CONFIG.payments.totalGuard.toString(), CONFIG.guardToken.decimals);
    const bonusPerCritical = parseUnits(CONFIG.payments.bonusPerCritical.toString(), CONFIG.guardToken.decimals);
    const totalScore = scores.reduce((s, f) => s + f.score, 0) || 1;
    const totalScoreBigInt = BigInt(totalScore);

    const payments = scores.map((f) => {
      const share = (totalPool * BigInt(f.score)) / totalScoreBigInt;
      const bonus = bonusPerCritical * BigInt(f.critical);
      return {
        recipient: f.recipient,
        basePayment: share,
        bonus,
        reportFee: BigInt(0),
        paymentType: 0,
        description: `Report-settlement:${f.agentId}`,
      };
    });

    const reportAgent = reportAgentAddress || this.orchestratorAddress;
    if (!reportAgent || !ethers.isAddress(reportAgent)) {
      this.log.warn(`Settlement skipped for job ${jobId}: invalid report agent address`);
      return;
    }

    try {
      await this.ensureOrchestratorOperationalHbar("settle_job", { force: true });
      await this.contracts.settleJob(
        this.toChainJobId(jobId),
        payments,
        reportAgent
      );
      job.settled = true;
      this.setJobByKey(jobId, job);
      await this.hcs.publishAuditLog({
        type: "PAYMENT_SETTLED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          recipients: payments.map((p) => p.recipient),
          reportAgent,
          winnerCount: winnerSet.size
        },
      });
      this.log.info(`Settled job ${jobId} to ${payments.length} recipients`);
    } catch (err) {
      this.log.warn(`Settlement failed for job ${jobId}: ${err}`);
    }
  }

  resolveReportAgentAddress(msg) {
    const payloadAddress = msg?.payload?.reportAgentAddress ?? msg?.payload?.reportAgentEvmAddress;
    if (typeof payloadAddress === "string" && ethers.isAddress(payloadAddress)) return payloadAddress;

    const fromRoster = this.roster.get(msg?.agentId ?? "")?.evmAddress;
    if (typeof fromRoster === "string" && ethers.isAddress(fromRoster)) return fromRoster;

    return this.orchestratorAddress;
  }

  async isJobAlreadySettledOnChain(jobId) {
    try {
      if (!this.contracts.paymentSettlement?.isJobSettled) return false;
      return await this.contracts.paymentSettlement.isJobSettled(this.toChainJobId(jobId));
    } catch {
      return false;
    }
  }

  async updateReputation(jobId, findingsArr) {
    for (const f of findingsArr) {
      const delta = (f.findingsCount ?? 0) + 2 * (f.criticalCount ?? 0);
      await this.hcs.publishAuditLog({
        type: "REPUTATION_UPDATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { jobId, agentId: f.agentId, delta },
      });
      // Optional iNFT hook (basis points)
      const deltaBps = delta * 100;
      await this.inft.updateReputation(f.agentId, deltaBps, jobId);
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  async dispatchToUcpEndpoint(endpoint, message) {
    if (!endpoint || String(endpoint).startsWith("hcs://")) return;

    const url = `${String(endpoint).replace(/\/$/, "")}/task`;
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: ctrl.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.log.info(`UCP HTTP dispatch → ${url} (type=${message.type})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`UCP HTTP dispatch failed for ${endpoint}: ${reason}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async inviteAgents(jobId, agents, payload, classifierMetadata = null) {
    if (!Array.isArray(agents) || agents.length === 0) {
      this.log.info(`No eligible agents to invite for job ${jobId}`);
      return;
    }

    const trackedJob = this.getJobByKey(jobId);
    const invitePayload = {
      jobId,
      contractAddress: payload.contractAddress,
      contractType: payload.contractType,
      budget: payload.budget ?? CONFIG.payments.totalGuard,
      riskScore: payload.riskScore ?? payload.initialRiskScore ?? 0,
      estimatedLOC: payload.estimatedLOC ?? payload.estimatedLineCount ?? 0,
      estimatedLineCount: payload.estimatedLineCount ?? payload.estimatedLOC ?? 0,
      auctionDeadlineSec: Number(trackedJob?.auctionDeadlineSec ?? 0) || undefined,
    };
    const effectiveClassifier = classifierMetadata || this.extractClassifierMetadata(payload || {});
    const classifierHints = this.buildClassifierHints(effectiveClassifier);
    if (classifierHints) {
      invitePayload.classifierHints = classifierHints;
    }
    const eligibleAgentIds = agents.map((agent) => String(agent?.agentId ?? "")).filter(Boolean);
    const eligibleEvmAddresses = agents.map((agent) => this.normalizeAddress(agent?.evmAddress)).filter(Boolean);
    const inviteBatchId = `invite:${String(jobId)}:${Date.now()}`;

    await this.hcs.publishAgentComms({
      type: MessageType.AUCTION_INVITE,
      agentId: "orchestrator",
      timestamp: now(),
      payload: {
        ...invitePayload,
        inviteBatchId,
        eligibleAgentIds,
        eligibleEvmAddresses,
      },
    });

    for (const agent of agents) {
      const entry = this.roster.get(agent.agentId);
      if (entry?.endpoint) {
        this.dispatchToUcpEndpoint(entry.endpoint, {
          type: "AUCTION_INVITE",
          agentId: "orchestrator",
          timestamp: now(),
          payload: invitePayload,
        }).catch(() => { });
      }
    }

    this.log.info(`Invited ${agents.length} agents to job ${jobId}`);
  }

  async closeExpiredAuction(jobId, reasonCode = "expired_no_bids") {
    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key) ?? { contractAddress: null };
    if (!this.getJobByKey(key)) this.setJobByKey(key, job);

    if (job.cancelledOnChain) {
      return true;
    }

    const existingClose = this.inflightCloseJobs.get(key);
    if (this.auctionCloseSingleflightEnabled && existingClose) {
      this.log.info(`[Orchestrator] closeExpiredAuction single-flight skip for job ${key}`);
      await this.hcs.publishAuditLog({
        type: "AUCTION_CLOSE_SKIPPED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId: key,
          contractAddress: job.contractAddress,
          reasonCode: "close_singleflight_skipped",
        },
      }).catch(() => { });
      return existingClose;
    }

    const runClose = async () => {
      if (typeof this.contracts.cancelJob !== "function") {
        this.log.warn(`[Orchestrator] cancelJob unavailable; cannot hard-close expired auction ${key}`);
        return false;
      }

      let lastError = "";
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.ensureOrchestratorOperationalHbar("cancel_expired_auction", { force: true });
          const receipt = await this.contracts.cancelJob(Number(key));
            job.cancelledOnChain = true;
            job.cancelledReason = reasonCode;
            job.terminalOnChain = true;
            job.terminalReason = "cancelled";
            job.terminalTxHash = receipt?.hash ?? null;
            job.terminalAt = Date.now();
            this.setJobByKey(key, job);
            this.clearWinnerSelectionTimer(key);
            this.log.info(
              `[Orchestrator] On-chain cancelJob succeeded for expired job ${key}, tx: ${receipt?.hash ?? "unknown"}`
            );
          await this.hcs.publishAuditLog({
            type: "JOB_CANCELLED",
            agentId: "orchestrator",
            timestamp: now(),
            payload: {
              jobId: key,
              contractAddress: job.contractAddress,
              phase: "cancel_expired",
              reasonCode,
              txHash: receipt?.hash ?? null,
            },
          });
          return true;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          lastError = error;

          if (this.isAuctionTerminalError(error)) {
            job.cancelledOnChain = true;
            job.cancelledReason = `${reasonCode}:already_terminal`;
            job.terminalOnChain = true;
            job.terminalReason = "cancel_already_terminal";
            job.terminalAt = Date.now();
            this.setJobByKey(key, job);
            this.clearWinnerSelectionTimer(key);
            this.log.info(`[Orchestrator] Expired job ${key} already terminal on-chain during cancel path`);
            return true;
          }

          const nonceError = this.isNonceTooLowError(error);
          const lowFundsError = this.isInsufficientFundsError(error);
          const transientRpc = this.isTransientRpcError(error);
          const retriable = nonceError || lowFundsError || transientRpc;
          if (!retriable || attempt === maxAttempts) break;

          if (lowFundsError) {
            this.log.warn(
              `[Orchestrator] cancelJob low-funds precheck for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — forcing HBAR top-up and retry`
            );
            try {
              await this.ensureOrchestratorOperationalHbar("cancel_expired_auction_retry", { force: true });
            } catch (topupErr) {
              this.log.warn(
                `[Orchestrator] cancelJob top-up retry failed for job ${key}: ` +
                `${topupErr instanceof Error ? topupErr.message : String(topupErr)}`
              );
            }
          } else if (nonceError) {
            this.log.warn(
              `[Orchestrator] cancelJob nonce race for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          } else {
            this.log.warn(
              `[Orchestrator] cancelJob transient RPC failure for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }

      this.log.warn(`[Orchestrator] On-chain cancelJob failed for expired job ${key}: ${lastError}`);
      await this.hcs.publishAuditLog({
        type: "ONCHAIN_TX_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          phase: "cancel_expired",
          strictLive: this.strictLive,
          contractAddress: job.contractAddress,
          jobId: key,
          reasonCode,
          error: lastError,
        },
      });
      return false;
    };

    if (!this.auctionCloseSingleflightEnabled) {
      return runClose();
    }

    const inflight = runClose().finally(() => {
      this.inflightCloseJobs.delete(key);
    });
    this.inflightCloseJobs.set(key, inflight);
    return inflight;
  }

  async reconcileExpiredActiveAuctions() {
    if (this._isReconcileRunning) return;
    this._isReconcileRunning = true;
    try {
      await this._reconcileExpiredActiveAuctionsInner();
    } finally {
      this._isReconcileRunning = false;
    }
  }

  async _reconcileExpiredActiveAuctionsInner() {
    const getActiveJobs =
      this.contracts.getActiveJobs?.bind(this.contracts) ??
      this.contracts.auction?.getActiveJobs?.bind(this.contracts.auction);
    const getJob =
      this.contracts.getJob?.bind(this.contracts) ??
      this.contracts.auction?.getJob?.bind(this.contracts.auction);
    if (typeof getActiveJobs !== "function" || typeof getJob !== "function") return;

    let activeJobIds = [];
    try {
      activeJobIds = await getActiveJobs();
    } catch (err) {
      this.log.warn(
        `[Orchestrator] Active job reconcile skipped: failed to read getActiveJobs: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const activeIds = Array.isArray(activeJobIds) ? activeJobIds : [];
    if (activeIds.length === 0) return;
    const inspectCap = Math.max(1, this.staleAuctionReconcileMaxInspectPerCycle);
    const inspectCount = Math.min(inspectCap, activeIds.length);
    const startIndex = ((this.staleAuctionReconcileCursor % activeIds.length) + activeIds.length) % activeIds.length;
    this.staleAuctionReconcileCursor = (startIndex + inspectCount) % activeIds.length;
    let closeAttempts = 0;
    let selectAttempts = 0;
    let deferredSelectionCount = 0;
    for (let offset = 0; offset < inspectCount; offset++) {
      if (
        closeAttempts >= this.staleAuctionReconcileMaxPerCycle &&
        selectAttempts >= this.staleAuctionReconcileMaxSelectsPerCycle
      ) {
        break;
      }
      const rawId = activeIds[(startIndex + offset) % activeIds.length];
      const key = this.normalizeJobId(rawId);
      const job = this.getJobByKey(key);
      if (job?.terminalOnChain || job?.cancelledOnChain) continue;
      const cooldownUntil = Number(this.reconcileCloseCooldown.get(key) ?? 0);
      if (cooldownUntil > nowMs) continue;
      try {
        const chainJob = await getJob(this.toChainJobId(key));
        const deadlineSec = Number(chainJob?.auctionDeadline ?? 0);
        const status = Number(chainJob?.status ?? -1);
        const isAuctionOpen = status === 0; // JobStatus.AUCTION_OPEN
        if (!isAuctionOpen) {
          if (job) {
            job.terminalOnChain = true;
            job.terminalReason = "reconcile_skip_terminal";
            job.terminalAt = Date.now();
            this.setJobByKey(key, job);
          }
          continue;
        }
        if (!Number.isFinite(deadlineSec) || deadlineSec <= 0) continue;
        if (deadlineSec > nowSec) continue;

        const onChainBidCount = await this.getOnChainBidCount(key);
        if (onChainBidCount > 0) {
          if (selectAttempts >= this.staleAuctionReconcileMaxSelectsPerCycle) {
            this.reconcileCloseCooldown.set(key, nowMs + this.staleAuctionReconcileFailureCooldownMs);
            deferredSelectionCount += 1;
            continue;
          }
          selectAttempts += 1;
          this.log.info(
            `[Orchestrator] Reconcile skip-cancel for expired active job ${key}: ` +
            `on-chain bids=${onChainBidCount}; triggering winner selection`
          );
          this.requestWinnerSelection(key, {
            sourcePath: "reconcile",
            readinessHint: {
              chainStatus: status,
              deadlineSec,
              onChainBidCount,
            },
          }).catch((err) => {
            this.log.warn(
              `[Orchestrator] Reconcile-triggered selectWinners failed for job ${key}: ` +
              `${err instanceof Error ? err.message : String(err)}`
            );
          });
          this.reconcileCloseCooldown.delete(key);
          continue;
        }

        closeAttempts += 1;
        const closed = await this.closeExpiredAuction(key, "reconcile_expired_active_job");
        if (!closed) {
          this.reconcileCloseCooldown.set(key, nowMs + this.staleAuctionReconcileFailureCooldownMs);
          this.log.warn(`[Orchestrator] Reconcile failed to close expired active job ${key}`);
        } else {
          this.reconcileCloseCooldown.delete(key);
        }
      } catch (err) {
        this.reconcileCloseCooldown.set(key, nowMs + this.staleAuctionReconcileFailureCooldownMs);
        this.log.warn(
          `[Orchestrator] Reconcile failed for job ${key}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (deferredSelectionCount > 0) {
      this.log.info(
        `[Orchestrator] Reconcile select cap reached (${this.staleAuctionReconcileMaxSelectsPerCycle}) — ` +
        `deferred winner selection for ${deferredSelectionCount} expired active job(s)`
      );
    }
  }

  startStaleAuctionReconcileLoop() {
    if (!this.staleAuctionReconcileEnabled) return;
    if (this.staleAuctionReconcileTimer) return;

    this.reconcileExpiredActiveAuctions().catch((err) => {
      this.log.warn(
        `[Orchestrator] Initial stale auction reconcile failed: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    });

    this.staleAuctionReconcileTimer = setInterval(() => {
      this.reconcileExpiredActiveAuctions().catch((err) => {
        this.log.warn(
          `[Orchestrator] Stale auction reconcile iteration failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, this.staleAuctionReconcileIntervalMs);
    this.staleAuctionReconcileTimer.unref?.();
  }

  async selectWinnersOnChain(jobId, options = {}) {
    const key = this.normalizeJobId(jobId);
    const path = typeof options?.path === "string" && options.path ? options.path : "manual";
    const readiness = options?.readiness && typeof options.readiness === "object" ? options.readiness : null;
    const existingSelect = this.inflightSelectWinnerJobs.get(key);
    if (this.auctionCloseSingleflightEnabled && existingSelect) {
      this.log.info(`[Orchestrator] selectWinners single-flight skip for job ${key}`);
      await this.hcs.publishAuditLog({
        type: "WINNER_SELECTION_SKIPPED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId: key,
          reasonCode: "close_singleflight_skipped",
          path,
        },
      }).catch(() => { });
      return existingSelect;
    }

    const runSelect = async () => {
      this.clearWinnerSelectionTimer(key);
      let job = this.getJobByKey(key);
      if (!job) {
        job = await this.hydrateJobForSelection(key);
      }

      const selectStartedAt = Date.now();
      const scheduledAtRaw = Number(job?.winnerSelectionScheduledAt ?? 0);
      const scheduledAt = Number.isFinite(scheduledAtRaw) && scheduledAtRaw > 0 ? scheduledAtRaw : null;
      const deadlineSecRaw = Number(job?.auctionDeadlineSec ?? 0);
      const deadlineSec = Number.isFinite(deadlineSecRaw) && deadlineSecRaw > 0 ? Math.floor(deadlineSecRaw) : null;
      const graceMs = Number(CONFIG.timeouts?.bidFinalityGraceMs ?? 0);
      const deadlineReached =
        typeof readiness?.deadlineReached === "boolean"
          ? readiness.deadlineReached
          : (deadlineSec != null ? Math.floor(Date.now() / 1000) >= deadlineSec : null);
      let onChainBidCount =
        Number.isFinite(Number(readiness?.onChainBidCount))
          ? Math.max(0, Math.floor(Number(readiness.onChainBidCount)))
          : null;
      const priorityUsed =
        typeof options?.priorityUsed === "string"
          ? options.priorityUsed
          : this.resolveWinnerSelectionPriority({
            ...(readiness ?? {}),
            deadlineReached,
            onChainBidCount,
          });

      if (!job) {
        const reason = "missing_job_state";
        this.reconcileCloseCooldown.set(key, Date.now() + this.staleAuctionReconcileFailureCooldownMs);
        await this.hcs.publishAuditLog({
          type: "WINNER_SELECTION_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId: key,
            reasonCode: reason,
            path,
          },
        }).catch(() => { });
        await this.publishWinnerSelectionTiming(key, {
          deadlineSec,
          graceMs,
          scheduledAt,
          selectStartedAt,
          txSentAt: null,
          receiptAt: null,
          closeToReceiptMs: null,
          path,
          attempts: 0,
          result: "skipped",
          error: reason,
          priorityUsed,
          deadlineReached,
          onChainBidCount,
          suppressedReason: reason,
        });
        return;
      }

      const eligibleInvitedCount = Number(job.eligibleInvitedCount ?? 0);
      const bidsReceivedHcsCount = Number(job.hcsBidCount ?? (Array.isArray(job.bidders) ? job.bidders.length : 0));

      if (!Array.isArray(job.bidders)) {
        job.bidders = [];
      }
      const hasOnChainBidApi =
        typeof this.contracts.getBidsForJob === "function" ||
        typeof this.contracts.auction?.getBidsForJob === "function";
      if (hasOnChainBidApi) {
        const localBidCount = job.bidders.length;
        try {
          const onChainBids = await this.getOnChainBids(key);
          onChainBidCount = Array.isArray(onChainBids) ? onChainBids.length : 0;
          const hydratedBidders = this.mapOnChainBidsToLocal(onChainBids);
          if (localBidCount > 0 && hydratedBidders.length !== localBidCount) {
            this.log.warn(
              `[Orchestrator] Local/on-chain bid mismatch for job ${key}: ` +
              `local=${localBidCount}, on-chain=${hydratedBidders.length}; using on-chain snapshot`
            );
          } else if (hydratedBidders.length > 0) {
            this.log.info(
              `[Orchestrator] Hydrated ${hydratedBidders.length} bidder(s) from on-chain state for job ${key}`
            );
          }
          job.bidders = hydratedBidders;
          this.setJobByKey(key, job);
        } catch (err) {
          this.log.warn(
            `[Orchestrator] Failed to hydrate on-chain bids for job ${key}: ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else if (job.bidders.length === 0) {
        try {
          onChainBidCount = await this.getOnChainBidCount(key);
        } catch (err) {
          this.log.warn(
            `[Orchestrator] Failed to read on-chain bid count for job ${key}: ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const bidsObservedOnChainCount = onChainBidCount != null ? Number(onChainBidCount) : Number(job.bidders.length);
      await this.hcs.publishAuditLog({
        type: "WINNER_SELECTION_SUMMARY",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId: key,
          contractAddress: job.contractAddress,
          eligible_invited_count: eligibleInvitedCount,
          bids_received_hcs_count: bidsReceivedHcsCount,
          bids_observed_onchain_count: bidsObservedOnChainCount,
        },
      }).catch(() => { });

      if (!job.bidders || job.bidders.length === 0) {
        const effectiveOnChainBidCount =
          onChainBidCount != null
            ? onChainBidCount
            : await this.getOnChainBidCount(key).catch(() => 0);
          const reason = effectiveOnChainBidCount > 0
            ? "On-chain bids exist but local bidder hydration failed"
            : "No bids collected before winner deadline";
        this.log.warn(`Winner selection failed for job ${key}: ${reason}`);
        job.failed = true;
        job.failureReason = reason;
        this.setJobByKey(key, job);
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId: key,
            contractAddress: job.contractAddress,
            phase: "select_winners",
            error: reason,
          },
        });
        if (effectiveOnChainBidCount <= 0) {
          const closed = await this.closeExpiredAuction(key, "no_bids_before_deadline");
          if (!closed) {
            this.log.warn(`[Orchestrator] Expired job ${key} remains open on-chain after cancel attempts`);
          }
        }
        await this.publishWinnerSelectionTiming(key, {
          deadlineSec,
          graceMs,
          scheduledAt,
          selectStartedAt,
          txSentAt: null,
          receiptAt: null,
          closeToReceiptMs: null,
          path,
          attempts: 0,
          result: effectiveOnChainBidCount > 0 ? "failed" : "skipped",
          error: reason,
          priorityUsed,
          deadlineReached,
          onChainBidCount: effectiveOnChainBidCount,
          suppressedReason: effectiveOnChainBidCount > 0 ? null : "no_onchain_bids",
        });
        return;
      }

      const maxBid = Math.max(...job.bidders.map((b) => b.bidAmount || 1), 1);
      const maxTime = Math.max(...job.bidders.map((b) => b.estimatedTimeSec || 1), 1);

      const scored = job.bidders.map((b, bidIndex) => {
        const repScore = ((b.reputation ?? 0) / 100) * 0.55;
        const priceScore = (1 - (b.bidAmount ?? 0) / maxBid) * 0.25;
        const speedScore = (1 - (b.estimatedTimeSec ?? 0) / maxTime) * 0.20;
        return { ...b, bidIndex, score: repScore + priceScore + speedScore };
      });

      scored.sort((a, b) => b.score - a.score);

      const selectedWinners = [];
      const maxSelectedWinners = 1;
      const seenWinnerKeys = new Set();
      for (const bid of scored) {
        const dedupeKey = bid.evmAddress
          ? String(bid.evmAddress).toLowerCase()
          : `agent:${String(bid.agentId ?? "").toLowerCase()}`;
        if (!dedupeKey || seenWinnerKeys.has(dedupeKey)) continue;
        seenWinnerKeys.add(dedupeKey);
        selectedWinners.push(bid);
        if (selectedWinners.length >= maxSelectedWinners) break;
      }

      const winnerAddresses = selectedWinners.map((w) => w.evmAddress).filter(Boolean);
      this.log.info(
        `Bid-scored winners for job ${key} (${job.bidders.length} bids): ` +
        `${winnerAddresses.join(", ")}`
      );

      job.winners = winnerAddresses;

      const winningBidIndices = selectedWinners
        .map((w) => (Number.isInteger(w.onChainBidIndex) ? w.onChainBidIndex : w.bidIndex))
        .filter((idx) => Number.isInteger(idx) && idx >= 0);
      if (!winningBidIndices.length) {
        const error = "No valid winning bid indices";
        this.log.warn(`[Orchestrator] On-chain selectWinners failed for job ${key}: ${error}`);
        job.failed = true;
        job.failureReason = error;
        this.setJobByKey(key, job);
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "select_winners",
            strictLive: this.strictLive,
            contractAddress: job.contractAddress,
            jobId: key,
            error,
          },
        });
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId: key,
            contractAddress: job.contractAddress,
            phase: "select_winners",
            error,
          },
        });
        await this.publishWinnerSelectionTiming(key, {
          deadlineSec,
          graceMs,
          scheduledAt,
          selectStartedAt,
          txSentAt: null,
          receiptAt: null,
          closeToReceiptMs: null,
          path,
          attempts: 0,
          result: "failed",
          error,
          priorityUsed,
          deadlineReached,
          onChainBidCount,
          suppressedReason: null,
        });
        return;
      }

      let lastError = "";
      let lastTxSentAt = null;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.ensureOrchestratorOperationalHbar("select_winners", { force: true });
          lastTxSentAt = Date.now();
          const receipt = await this.contracts.selectWinners(Number(key), winningBidIndices, {
            priority: priorityUsed,
          });
          const receiptAt = Date.now();
          this.log.info(`[Orchestrator] On-chain selectWinners succeeded for job ${key}, tx: ${receipt.hash}`);
          await this.publishWinnerSelectedAuditLog(key, winnerAddresses, {
            txHash: receipt?.hash ?? null,
          });

          for (const winner of selectedWinners) {
            const entry = this.roster.get(winner.agentId);
            if (entry?.endpoint) {
              this.dispatchToUcpEndpoint(entry.endpoint, {
                type: "TASK_ASSIGNED",
                agentId: "orchestrator",
                timestamp: now(),
                payload: {
                  jobId: key,
                  contractAddress: job.contractAddress,
                  contractType: job.contractType,
                  winnerAddress: winner.evmAddress,
                },
              }).catch(() => { });
            }
          }

          job.winnerSource = "on-chain";
          this.setJobByKey(key, job);
          await this.publishWinnerSelectionTiming(key, {
            deadlineSec,
            graceMs,
            scheduledAt,
            selectStartedAt,
            txSentAt: lastTxSentAt,
            receiptAt,
            closeToReceiptMs: deadlineSec ? Math.max(0, receiptAt - (deadlineSec * 1000)) : null,
            path,
            attempts: attempt,
            result: "success",
            error: null,
            priorityUsed,
            deadlineReached,
            onChainBidCount,
            suppressedReason: null,
          });
          return;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          lastError = error;
          const nonceError = this.isNonceTooLowError(error);
          const lowFundsError = this.isInsufficientFundsError(error);
          const transientRpc = this.isTransientRpcError(error);
          const retriable = nonceError || lowFundsError || transientRpc;
          if (!retriable || attempt === maxAttempts) break;

          if (lowFundsError) {
            this.log.warn(
              `[Orchestrator] selectWinners low-funds precheck for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — forcing HBAR top-up and retry`
            );
            try {
              await this.ensureOrchestratorOperationalHbar("select_winners_retry", { force: true });
            } catch (topupErr) {
              this.log.warn(
                `[Orchestrator] selectWinners top-up retry failed for job ${key}: ` +
                `${topupErr instanceof Error ? topupErr.message : String(topupErr)}`
              );
            }
          } else if (nonceError) {
            this.log.warn(
              `[Orchestrator] selectWinners nonce race for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          } else {
            this.log.warn(
              `[Orchestrator] selectWinners transient RPC failure for job ${key} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }

      this.log.warn(`[Orchestrator] On-chain selectWinners failed for job ${key}: ${lastError}`);
      job.failed = true;
      job.failureReason = lastError;
      this.setJobByKey(key, job);
      await this.hcs.publishAuditLog({
        type: "ONCHAIN_TX_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          phase: "select_winners",
          strictLive: this.strictLive,
          contractAddress: job.contractAddress,
          jobId: key,
          error: lastError,
        },
      });
      await this.hcs.publishAuditLog({
        type: "JOB_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId: key,
          contractAddress: job.contractAddress,
          phase: "select_winners",
          error: lastError,
        },
      });
      await this.publishWinnerSelectionTiming(key, {
        deadlineSec,
        graceMs,
        scheduledAt,
        selectStartedAt,
        txSentAt: lastTxSentAt,
        receiptAt: null,
        closeToReceiptMs: null,
        path,
        attempts: maxAttempts,
        result: "failed",
        error: lastError,
        priorityUsed,
        deadlineReached,
        onChainBidCount,
        suppressedReason: null,
      });
      this.reconcileCloseCooldown.set(key, Date.now() + this.staleAuctionReconcileFailureCooldownMs);
      return;
    };

    if (!this.auctionCloseSingleflightEnabled) {
      return runSelect();
    }

    const inflight = runSelect().finally(() => {
      this.inflightSelectWinnerJobs.delete(key);
    });
    this.inflightSelectWinnerJobs.set(key, inflight);
    return inflight;
  }

  subscribeContractEvents() {
    try {
      if (!this.contracts.auction?.on) return;
      this.contracts.auction.on("WinnersSelected", (jobId, winners, totalEscrowed, platformFee, eventMeta) => {
        const key = this.normalizeJobId(jobId);
        this.clearWinnerSelectionTimer(key);
        const job = this.getJobByKey(key);
        if (!job) return;

        const winnerAddrs = this.normalizeWinnerAddresses(winners);
        job.winners = winnerAddrs;
        this.log.info(`On-chain WinnersSelected for job ${key}: ${winnerAddrs.join(", ")}`);
        const txHash = eventMeta?.log?.transactionHash ?? eventMeta?.transactionHash ?? null;
        this.publishWinnerSelectedAuditLog(key, winnerAddrs, {
          totalEscrowed,
          platformFee,
          txHash,
        }).catch(() => {});
      });

      this.contracts.auction.on("JobCancelled", (jobId, reason) => {
        const key = this.normalizeJobId(jobId);
        this.clearWinnerSelectionTimer(key);
        const job = this.getJobByKey(key);
        if (!job) return;

        const reasonCode = reason ? String(reason) : "cancelled_event";
        job.cancelledOnChain = true;
        job.cancelledReason = reasonCode;
        job.terminalOnChain = true;
        job.terminalReason = "cancelled";
        job.terminalAt = Date.now();
        this.setJobByKey(key, job);
        this.log.info(`[Orchestrator] On-chain JobCancelled event for job ${key}, reason: ${reasonCode}`);

        this.hcs.publishAuditLog({
          type: "JOB_CANCELLED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { jobId: key, contractAddress: job.contractAddress, phase: "event", reasonCode },
        }).catch(() => {});
      });

      this.log.info("Listening for on-chain WinnersSelected and JobCancelled events");
    } catch (err) {
      this.log.warn(`Contract event subscription failed: ${err.message}`);
    }
  }

  scheduledEnrichmentQueueKey(contractAddress, scheduleAddress) {
    return `${String(contractAddress || "").toLowerCase()}::${String(scheduleAddress || "").toLowerCase()}`;
  }

  async runScheduledEnrichment(contractAddress) {
    let lastError = null;
    const maxAttempts = Math.max(1, this.scheduledEnrichmentMaxAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.scheduledEnrichmentClient(contractAddress, {
          timeoutMs: this.scheduledEnrichmentTimeoutMs,
        });
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async publishScheduledDiscoveryWithEnrichment(payload) {
    const addr = String(payload.contractAddress);
    try {
      const enrichment = await this.runScheduledEnrichment(addr);
      const classifierMetadata = this.extractClassifierMetadata({
        ...(enrichment?.classifier || {}),
      });
      const discoveryMsg = {
        type: "CONTRACT_DISCOVERED",
        agentId: "audit-scheduler",
        timestamp: now(),
        payload: {
          contractAddress: addr,
          contractType: enrichment?.contractType ?? "unknown",
          budget: CONFIG.payments.totalGuard,
          riskScore: Number(enrichment?.riskScore ?? 0),
          estimatedLOC: Number(enrichment?.estimatedLOC ?? 0),
          triggeredByHSS: true,
          scheduleAddress: String(payload.scheduleAddress),
          deployerAddress: "HSS_SCHEDULE",
          ...(classifierMetadata ? { classifier: classifierMetadata } : {}),
        },
      };
      await this.hcs.publishDiscovery(discoveryMsg);
      this.log.info(
        `Published enriched HSS discovery for ${addr.slice(0, 12)}… ` +
        `(type=${discoveryMsg.payload.contractType}, risk=${discoveryMsg.payload.riskScore})`
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `Scheduled enrichment failed for ${addr.slice(0, 12)}… ` +
        `(attempt=${payload.retryCount ?? 0}): ${message}`
      );
      await this.hcs.publishAuditLog({
        type: "DISCOVERY_ENRICHMENT_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          contractAddress: addr,
          scheduleAddress: String(payload.scheduleAddress),
          triggeredAt: Number(payload.triggeredAt),
          timesTriggered: Number(payload.timesTriggered),
          retryCount: Number(payload.retryCount ?? 0),
          error: message,
        },
      });
      return false;
    }
  }

  queueScheduledEnrichment(payload) {
    const key = this.scheduledEnrichmentQueueKey(payload.contractAddress, payload.scheduleAddress);
    const existing = this.scheduledEnrichmentQueue.get(key);
    const retryCount = Math.max(Number(payload.retryCount ?? 0), Number(existing?.retryCount ?? 0));
    const queued = {
      ...payload,
      retryCount,
      nextAttemptAt: Date.now() + this.scheduledEnrichmentRetryIntervalMs,
    };
    this.scheduledEnrichmentQueue.set(key, queued);
    this.log.info(
      `Scheduled enrichment queued for ${String(payload.contractAddress).slice(0, 12)}… ` +
      `(retryCount=${queued.retryCount}, queueSize=${this.scheduledEnrichmentQueue.size})`
    );
  }

  async processScheduledEnrichmentQueue() {
    if (this.scheduledEnrichmentInFlight || this.scheduledEnrichmentQueue.size === 0) return;
    this.scheduledEnrichmentInFlight = true;
    try {
      const nowMs = Date.now();
      const entries = Array.from(this.scheduledEnrichmentQueue.entries());
      for (const [key, payload] of entries) {
        if (Number(payload.nextAttemptAt ?? 0) > nowMs) continue;
        const success = await this.publishScheduledDiscoveryWithEnrichment(payload);
        if (success) {
          this.scheduledEnrichmentQueue.delete(key);
          continue;
        }
        this.scheduledEnrichmentQueue.set(key, {
          ...payload,
          retryCount: Number(payload.retryCount ?? 0) + 1,
          nextAttemptAt: Date.now() + this.scheduledEnrichmentRetryIntervalMs,
        });
      }
    } finally {
      this.scheduledEnrichmentInFlight = false;
    }
  }

  startScheduledEnrichmentRetryLoop() {
    if (this.scheduledEnrichmentTimer) return;
    this.scheduledEnrichmentTimer = setInterval(() => {
      this.processScheduledEnrichmentQueue().catch((err) => {
        this.log.warn(
          `Scheduled enrichment retry loop error: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, this.scheduledEnrichmentRetryIntervalMs);
    this.scheduledEnrichmentTimer.unref?.();
  }

  /**
   * Subscribe to AuditScheduler.AuditTriggered events.
   * This is where HSS integration closes the loop:
   *   1. Vault owner calls AuditScheduler.scheduleAudit()
   *   2. HSS fires triggerAudit() at the specified interval
   *   3. AuditScheduler emits AuditTriggered
   *   4. Orchestrator opens a new AuditAuction job here
   *   5. Full pipeline (bidding → auditing → reporting) runs autonomously
   */
  subscribeSchedulerEvents() {
    try {
      if (!this.contracts.auditScheduler?.on) {
        this.log.info("AuditScheduler not configured — scheduled audits disabled");
        return;
      }

      this.contracts.auditScheduler.on(
        "AuditTriggered",
        async (contractAddress, scheduleAddress, triggeredAt, timesTriggered) => {
          const addr = String(contractAddress);
          this.log.info(
            `HSS AuditTriggered for ${addr.slice(0, 12)}… ` +
            `(schedule=${String(scheduleAddress).slice(0, 12)}…, #${timesTriggered})`
          );

          // Publish to HCS audit log so dashboard picks it up
          await this.hcs.publishAuditLog({
            type: "HSS_AUDIT_TRIGGERED",
            agentId: "orchestrator",
            timestamp: now(),
            payload: {
              contractAddress: addr,
              scheduleAddress: String(scheduleAddress),
              triggeredAt: Number(triggeredAt),
              timesTriggered: Number(timesTriggered),
            },
          });

          const enrichmentPayload = {
            contractAddress: addr,
            scheduleAddress: String(scheduleAddress),
            triggeredAt: Number(triggeredAt),
            timesTriggered: Number(timesTriggered),
            retryCount: 0,
          };
          const published = await this.publishScheduledDiscoveryWithEnrichment(enrichmentPayload);
          if (!published) {
            this.queueScheduledEnrichment({
              ...enrichmentPayload,
              retryCount: 1,
            });
          }
        }
      );

      this.contracts.auditScheduler.on(
        "AuditScheduleCancelled",
        (contractAddress, cancelledBy, reason) => {
          this.log.info(
            `AuditSchedule cancelled for ${String(contractAddress).slice(0, 12)}… ` +
            `by ${String(cancelledBy).slice(0, 12)}… reason=${reason}`
          );
          this.hcs.publishAuditLog({
            type: "HSS_SCHEDULE_CANCELLED",
            agentId: "orchestrator",
            timestamp: now(),
            payload: { contractAddress, cancelledBy, reason },
          }).catch(() => {});
        }
      );

      this.contracts.auditScheduler.on(
        "ScheduleFailed",
        (contractAddress, responseCode, context) => {
          this.log.warn(
            `HSS ScheduleFailed for ${String(contractAddress).slice(0, 12)}… ` +
            `rc=${responseCode} ctx=${context}`
          );
        }
      );

      this.log.info("Listening for on-chain AuditTriggered events (HSS)");
    } catch (err) {
      this.log.warn(`AuditScheduler event subscription failed: ${err.message}`);
    }
  }

  startPingLoop() {
    const sendPing = () => {
      this.hcs.publishAgentComms({
        type: MessageType.PING,
        agentId: "orchestrator",
        timestamp: now(),
        payload: {},
      }).catch(() => {});
      const pingTimer = setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
      pingTimer.unref?.();
    };
    const firstPingTimer = setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
    firstPingTimer.unref?.();
  }
}
