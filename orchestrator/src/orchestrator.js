import { ethers } from "ethers";
import { CONFIG, getOperatorKeys } from "./config.js";
import { HCSClient } from "./hcs-client.js";
import { ContractClient } from "./contract-client.js";
import { Roster } from "./roster.js";
import { createLogger } from "./logger.js";
import { InftBridge } from "./inft-bridge.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { parseUnits } from "ethers";

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
    this.staleAuctionReconcileEnabled = (process.env.ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS ?? "true") !== "false";
    this.staleAuctionReconcileIntervalMs = Number(
      process.env.ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS_INTERVAL_MS ?? "30000"
    );
    this.staleAuctionReconcileMaxPerCycle = Number(
      process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE ?? "3"
    );
    this.staleAuctionReconcileFailureCooldownMs = Number(
      process.env.ORCHESTRATOR_RECONCILE_FAILURE_COOLDOWN_MS ?? "15000"
    );
    this.staleAuctionReconcileTimer = null;
    this.rosterBootstrapOnchain = (process.env.ORCHESTRATOR_ROSTER_BOOTSTRAP_ONCHAIN ?? "true") !== "false";
    this.filterInvitesOnchainActive = (process.env.ORCHESTRATOR_FILTER_INVITES_ONCHAIN_ACTIVE ?? "true") !== "false";
    this.onchainActiveCacheTtlMs = Number(process.env.ORCHESTRATOR_ACTIVE_CACHE_TTL_MS ?? "15000");
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
    this.reconcileCloseCooldown = new Map();
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
      if (typeof client.dataMarketplace?.purchaseData !== "function") missing.push("dataMarketplace.purchaseData");
      if (typeof client.paymentSettlement?.settleJob !== "function") missing.push("paymentSettlement.settleJob");
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
    this.startStaleAuctionReconcileLoop();
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
    const { contractAddress, bidAmount, collateral, estimatedTimeSec, reputation, evmAddress } = msg.payload || {};

    // Find the job this bid belongs to (match by contractAddress across open jobs)
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.contractAddress === contractAddress) {
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

        job.bidders.push({
          agentId: msg.agentId,
          evmAddress: evmAddress ?? agent?.evmAddress,
          bidAmount: bidAmount ?? 0,
          collateral: collateral ?? 0,
          estimatedTimeSec: estimatedTimeSec ?? 0,
          reputation: reputation ?? agent?.reputation ?? 0,
          timestamp: msg.timestamp ?? now(),
        });

        this.log.info(
          `Bid recorded: ${msg.agentId} bid ${bidAmount} GUARD for job ${jobId} ` +
          `(total bids: ${job.bidders.length})`
        );
        return;
      }
    }

    this.log.warn(`Bid from ${msg.agentId} — no matching open job for ${contractAddress?.slice(0, 12)}`);
  }

  async handleDiscovery(msg) {
    await this.rosterBootstrapPromise.catch(() => { });
    const { contractAddress, contractType, budget, riskScore, estimatedLOC } = msg.payload;
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

    let jobId = this.normalizeJobId(Date.now()); // provisional until chain jobId is resolved
    let auctionOpenedOnChain = false;
    const budgetGuardRaw = Number(budget ?? CONFIG.payments.totalGuard ?? 0);
    const budgetGuard = Number.isFinite(budgetGuardRaw) && budgetGuardRaw > 0
      ? budgetGuardRaw
      : Number(CONFIG.payments.totalGuard);
    this.log.info(`New discovery ${contractAddress.slice(0, 12)}… type=${contractType}`);

    // Store job FIRST so incoming bids can be matched immediately
    this.setJobByKey(jobId, {
      contractAddress,
      contractType,
      bidders: [],
      openedAt: now(),
      winners: [],
      findings: [],
      reportPublished: false,
    });

    // Open auction on-chain (async — bids can arrive while this runs)
    try {
      await this.withCreateAuditJobLock(async () => {
        await this.ensureOrchestratorOperationalHbar("create_audit_job", { force: true });
        const auctionDurationSec = CONFIG.timeouts.winnerWaitMs / 1000;
        const budgetWei = parseUnits(String(budgetGuard), CONFIG.guardToken.decimals);
        const expectedJobIdRaw = await this.contracts.auction.nextJobId?.();
        const expectedOnChainJobId = expectedJobIdRaw != null ? Number(expectedJobIdRaw) : null;

        let tx = null;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const createAuditJob =
              this.contracts.createAuditJob?.bind(this.contracts) ??
              this.contracts.auction?.createAuditJob?.bind(this.contracts.auction);
            if (typeof createAuditJob !== "function") {
              throw new Error("createAuditJob unavailable on contract client");
            }
            tx = await createAuditJob(
              contractAddress,
              "hedera-testnet",
              contractType ?? "unknown",
              riskScore ?? 0,
              budgetWei,
              estimatedLOC ?? 0,
              auctionDurationSec
            );
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const nonceError = this.isNonceTooLowError(message);
            const lowFundsError = this.isInsufficientFundsError(message);
            const transientRpc = this.isTransientRpcError(message);
            const retriable = nonceError || lowFundsError || transientRpc;

            if (!retriable || attempt === maxAttempts) throw err;

            if (lowFundsError) {
              this.log.warn(
                `createAuditJob low-funds precheck (attempt ${attempt}/${maxAttempts}) — forcing HBAR top-up and retry`
              );
              try {
                await this.ensureOrchestratorOperationalHbar("create_audit_job_retry", { force: true });
              } catch (topupErr) {
                this.log.warn(`createAuditJob top-up retry failed: ${topupErr instanceof Error ? topupErr.message : String(topupErr)}`);
              }
            } else if (nonceError) {
              this.log.warn(
                `createAuditJob nonce race (attempt ${attempt}/${maxAttempts}) — retrying`
              );
            } else {
              this.log.warn(
                `createAuditJob transient RPC failure (attempt ${attempt}/${maxAttempts}) — retrying`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          }
        }

        const receipt = await tx.wait();
        if (!receipt || (receipt.status != null && receipt.status !== 1)) {
          throw new Error(`createAuditJob tx failed: ${tx.hash}`);
        }

        let onChainJobId = Number.isFinite(expectedOnChainJobId) ? expectedOnChainJobId : null;
        if (receipt?.logs) {
          for (const log of receipt.logs) {
            try {
              const parsed = this.contracts.auction.interface.parseLog(log);
              if (parsed?.name === "JobPosted") {
                const parsedJobId = Number(this.normalizeJobId(parsed.args.jobId));
                if (Number.isFinite(parsedJobId)) onChainJobId = parsedJobId;
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

        if (onChainJobId != null && onChainJobId !== jobId) {
          const existing = this.getJobByKey(jobId);
          this.jobs.delete(this.normalizeJobId(jobId));
          this.jobs.delete(jobId);
          if (existing) {
            existing.onChainJobId = onChainJobId;
            this.setJobByKey(onChainJobId, existing);
          }
          jobId = onChainJobId;
        }
        auctionOpenedOnChain = true;
        this.log.info(`Auction opened on-chain for job ${jobId} (tx: ${tx.hash})`);
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
          jobId,
          error: message,
        },
      });
      if (this.strictLive) {
        this.log.warn(`Strict live mode: halting job ${jobId} after createAuditJob failure`);
        const failed = this.getJobByKey(jobId);
        if (failed) {
          failed.failed = true;
          failed.failureReason = message;
          this.setJobByKey(jobId, failed);
        }
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId,
            contractAddress,
            phase: "create_audit_job",
            error: message,
          },
        });
        return;
      }
    }

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
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish JOB_CREATED for ${contractAddress?.slice(0, 12)}: ${err}`);
    }

    const eligibility = typeof this.roster.evaluateEligibility === "function"
      ? this.roster.evaluateEligibility(contractType)
      : { eligible: this.roster.eligibleFor(contractType), excluded: [] };
    let eligible = Array.isArray(eligibility.eligible) ? eligibility.eligible : [];
    const excludedAgents = Array.isArray(eligibility.excluded) ? [...eligibility.excluded] : [];
    const onchainFiltered = await this.filterEligibleAgentsOnChain(eligible);
    eligible = onchainFiltered.eligible;
    excludedAgents.push(...onchainFiltered.excluded);
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
          excludedAgents,
          excludedByReason,
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish AUCTION_INVITE_SUMMARY for job ${jobId}: ${err}`);
    }
    try {
      await this.inviteAgents(jobId, eligible, msg.payload);
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
      const winnerTimer = setTimeout(() => this.selectWinnersOnChain(jobId), CONFIG.timeouts.winnerWaitMs);
      winnerTimer.unref?.();
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
      this.selectWinnersOnChain(key);
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
      await this.contracts.dataMarketplace.purchaseData(listingKey);
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
      await this.contracts.subAuction.createSubAuction(
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
      await this.contracts.subAuction.acceptResult(subId);
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
      await this.contracts.paymentSettlement.settleJob(
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

  async inviteAgents(jobId, agents, payload) {
    if (!Array.isArray(agents) || agents.length === 0) {
      this.log.info(`No eligible agents to invite for job ${jobId}`);
      return;
    }

    const invitePayload = {
      jobId,
      contractAddress: payload.contractAddress,
      contractType: payload.contractType,
      budget: payload.budget ?? CONFIG.payments.totalGuard,
      riskScore: payload.riskScore ?? payload.initialRiskScore ?? 0,
      estimatedLOC: payload.estimatedLOC ?? payload.estimatedLineCount ?? 0,
      estimatedLineCount: payload.estimatedLineCount ?? payload.estimatedLOC ?? 0,
    };
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
    let closeAttempts = 0;
    for (const rawId of activeJobIds || []) {
      if (closeAttempts >= this.staleAuctionReconcileMaxPerCycle) break;
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

  async selectWinnersOnChain(jobId) {
    const key = this.normalizeJobId(jobId);
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
        },
      }).catch(() => { });
      return existingSelect;
    }

    const runSelect = async () => {
      const job = this.getJobByKey(key);
      if (!job) return;

      if (!job.bidders || job.bidders.length === 0) {
        const reason = "No bids collected before winner deadline";
        this.log.warn(`Winner selection failed for job ${jobId}: ${reason}`);
        job.failed = true;
        job.failureReason = reason;
        this.setJobByKey(key, job);
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId,
            contractAddress: job.contractAddress,
            phase: "select_winners",
            error: reason,
          },
        });
        const closed = await this.closeExpiredAuction(key, "no_bids_before_deadline");
        if (!closed) {
          this.log.warn(`[Orchestrator] Expired job ${key} remains open on-chain after cancel attempts`);
        }
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
      const seenWinnerKeys = new Set();
      for (const bid of scored) {
        const dedupeKey = bid.evmAddress
          ? String(bid.evmAddress).toLowerCase()
          : `agent:${String(bid.agentId ?? "").toLowerCase()}`;
        if (!dedupeKey || seenWinnerKeys.has(dedupeKey)) continue;
        seenWinnerKeys.add(dedupeKey);
        selectedWinners.push(bid);
        if (selectedWinners.length >= 3) break;
      }

      const winnerAddresses = selectedWinners.map((w) => w.evmAddress).filter(Boolean);
      this.log.info(
        `Bid-scored winners for job ${jobId} (${job.bidders.length} bids): ` +
        `${winnerAddresses.join(", ")}`
      );

      job.winners = winnerAddresses;

      const winningBidIndices = selectedWinners
        .map((w) => w.bidIndex)
        .filter((idx) => Number.isInteger(idx));
      if (!winningBidIndices.length) {
        const error = "No valid winning bid indices";
        this.log.warn(`[Orchestrator] On-chain selectWinners failed for job ${jobId}: ${error}`);
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
            jobId,
            error,
          },
        });
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId,
            contractAddress: job.contractAddress,
            phase: "select_winners",
            error,
          },
        });
        return;
      }

      let lastError = "";
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.ensureOrchestratorOperationalHbar("select_winners", { force: true });
          const receipt = await this.contracts.selectWinners(Number(jobId), winningBidIndices);
          this.log.info(`[Orchestrator] On-chain selectWinners succeeded for job ${jobId}, tx: ${receipt.hash}`);

          for (const winner of selectedWinners) {
            const entry = this.roster.get(winner.agentId);
            if (entry?.endpoint) {
              this.dispatchToUcpEndpoint(entry.endpoint, {
                type: "TASK_ASSIGNED",
                agentId: "orchestrator",
                timestamp: now(),
                payload: {
                  jobId,
                  contractAddress: job.contractAddress,
                  contractType: job.contractType,
                  winnerAddress: winner.evmAddress,
                },
              }).catch(() => { });
            }
          }

          job.winnerSource = "on-chain";
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
              `[Orchestrator] selectWinners low-funds precheck for job ${jobId} ` +
              `(attempt ${attempt}/${maxAttempts}) — forcing HBAR top-up and retry`
            );
            try {
              await this.ensureOrchestratorOperationalHbar("select_winners_retry", { force: true });
            } catch (topupErr) {
              this.log.warn(
                `[Orchestrator] selectWinners top-up retry failed for job ${jobId}: ` +
                `${topupErr instanceof Error ? topupErr.message : String(topupErr)}`
              );
            }
          } else if (nonceError) {
            this.log.warn(
              `[Orchestrator] selectWinners nonce race for job ${jobId} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          } else {
            this.log.warn(
              `[Orchestrator] selectWinners transient RPC failure for job ${jobId} ` +
              `(attempt ${attempt}/${maxAttempts}) — retrying`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
      }

      this.log.warn(`[Orchestrator] On-chain selectWinners failed for job ${jobId}: ${lastError}`);
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
          jobId,
          error: lastError,
        },
      });
      await this.hcs.publishAuditLog({
        type: "JOB_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractAddress: job.contractAddress,
          phase: "select_winners",
          error: lastError,
        },
      });
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
      this.contracts.auction.on("WinnersSelected", (jobId, winners, totalEscrowed, platformFee) => {
        const key = this.normalizeJobId(jobId);
        const job = this.getJobByKey(key);
        if (!job) return;

        const winnerAddrs = Array.isArray(winners) ? winners.map(String) : [];
        job.winners = winnerAddrs;
        this.log.info(`On-chain WinnersSelected for job ${key}: ${winnerAddrs.join(", ")}`);

        this.hcs.publishAuditLog({
          type: "WINNER_SELECTED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { jobId: key, winners: winnerAddrs, totalEscrowed: totalEscrowed?.toString(), platformFee: platformFee?.toString() },
        }).catch(() => {});
      });
      this.log.info("Listening for on-chain WinnersSelected events");
    } catch (err) {
      this.log.warn(`Contract event subscription failed: ${err.message}`);
    }
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

          // Publish discovery event to HCS so all components (including iNFT listener) see it
          // This triggers the standard pipeline: iNFT minting -> Orchestrator handleDiscovery -> Auction
          const discoveryMsg = {
            type: "CONTRACT_DISCOVERED",
            agentId: "audit-scheduler",
            timestamp: now(),
            payload: {
              contractAddress: addr,
              contractType: "scheduled_audit",
              budget: CONFIG.payments.totalGuard,
              riskScore: 50,
              estimatedLOC: 0,
              triggeredByHSS: true,
              scheduleAddress: String(scheduleAddress),
              deployerAddress: "HSS_SCHEDULE",
            },
          };

          await this.hcs.publishDiscovery(discoveryMsg);
          this.log.info("Published HSS discovery event to HCS (triggers iNFT minting + auction)");
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
