/**
 * EventListenerService
 *
 * Unified event ingestion — manages Cloudflare events API polling
 * and ethers.js contract-event polling, routing everything into
 * the Zustand store.
 */

const EVENTS_API_BASE_URL = (
  import.meta.env.VITE_EVENTS_API_BASE_URL || '/api'
).replace(/\/$/, '');

const HCS_POLL_MS = 4_000;       // 4 s for HCS topics
const CONTRACT_POLL_MS = 5_000;  // 5 s for on-chain events
const EVENT_FETCH_LIMIT = 500;

// ── DataMarketplace enum mappings ───────────────────────────
const DATA_CATEGORIES = [
  'SCAN_REPORT', 'DEPENDENCY_ANALYSIS', 'EXPLOIT_DATABASE',
  'HOT_LEAD', 'FUZZING_SEEDS', 'THREAT_INTEL',
];
const LISTING_TYPES = ['ONE_TIME', 'SUBSCRIPTION', 'TIP'];

// ── Helpers ────────────────────────────────────────────────

/** Convert raw 8-decimal BigInt to human-readable "15.00 GUARD" */
export function parseGuardAmount(raw) {
  const n = typeof raw === 'bigint' ? raw : BigInt(raw);
  const whole = n / 100_000_000n;
  const frac  = n % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').slice(0, 2);
  return `${whole}.${fracStr} GUARD`;
}

/** "0x1234...abcd" */
export function shortenAddress(addr) {
  if (!addr || addr.length < 10) return addr || '???';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Check seededAgents map for a friendly name, else shorten */
export function resolveAgentName(evmAddress, config) {
  if (!evmAddress) return 'Unknown';
  const agents = config?.seededAgents || {};
  for (const [name, info] of Object.entries(agents)) {
    if (info.evmAddress?.toLowerCase() === evmAddress.toLowerCase()) return name;
  }
  return shortenAddress(evmAddress);
}

// ── Service class ──────────────────────────────────────────

export class EventListenerService {
  /** @param {object} config  SDK config.json contents
   *  @param {object} contracts  { agentRegistryContract, auctionContract, budgetVaultContract,
   *                               subAuctionContract, dataMarketplaceContract, paymentSettlementContract }
   *  @param {object} store  Zustand store actions (bound via getState)
   *  @param {import('ethers').JsonRpcProvider} provider */
  constructor(config, contracts, store, provider) {
    this.config    = config;
    this.contracts = contracts;
    this.store     = store;
    this.provider  = provider;

    this.onlyTestDiscoveries = import.meta.env.VITE_TEST_MODE === 'true';
    const testContracts = Array.isArray(config?.testContracts) ? config.testContracts : [];
    this.allowedDiscoveryContracts = new Set(
      testContracts
        .map((tc) => String(tc?.address || '').toLowerCase())
        .filter(Boolean)
    );
    this.seenTestDiscoveries = new Set();
    this.seenEventIds = new Set();
    this.maxSeenEventIds = 5_000;
    this.syntheticSequence = 0;
    this.eventsBacklogSkipped = false;

    // Contract event state
    this.lastProcessedBlock = null;

    this._intervals = [];

    if (this.onlyTestDiscoveries) {
      console.log(
        `[EventListener] TEST_MODE discovery filter enabled ` +
        `(${this.allowedDiscoveryContracts.size} configured test contracts)`
      );
    }
  }

  // ── public ───────────────────────────────────────────────

  startAll() {
    this.startHCSPolling();
    this.startContractEventPolling();
    // Sync historical agents (fire-and-forget)
    this._syncHistoricalAgents().catch(err => 
      console.warn('[EventListener] Agent history sync failed:', err)
    );
    console.log('[EventListener] All polling loops started');
    return () => this.stopAll();
  }

  async _syncHistoricalAgents() {
    if (!this.contracts?.agentRegistryContract) return;
    
    console.log('[EventListener] Syncing historical agents...');
    const agents = await this.contracts.agentRegistryContract.queryFilter('AgentRegistered', 0, 'latest');
    
    for (const ev of agents) {
      const a = ev.args;
      this.store.setAgent(a.agent, {
        address: a.agent,
        agentId: a.agentId,
        ucpEndpoint: a.ucpEndpoint,
        stakedAmount: a.stakedAmount,
        stakedFormatted: parseGuardAmount(a.stakedAmount),
      });
    }
    console.log(`[EventListener] Synced ${agents.length} historical agents`);
  }

  stopAll() {
    this._intervals.forEach(clearInterval);
    this._intervals = [];
    console.log('[EventListener] All polling loops stopped');
  }

  // ── HCS polling ──────────────────────────────────────────

  startHCSPolling() {
    if (!this.config?.hcsTopics) {
      console.warn('[EventListener] No HCS topics in config — skipping event polling');
      return;
    }

    // Initial poll to reduce startup latency.
    this._pollCloudflareEvents().catch((err) => {
      console.warn('[EventListener] Initial Cloudflare event poll failed:', err.message);
    });

    this._intervals.push(setInterval(() => {
      this._pollCloudflareEvents();
    }, HCS_POLL_MS));
  }

  async _pollCloudflareEvents() {
    try {
      const messages = await this.fetchCloudflareEvents();

      if (this.onlyTestDiscoveries && !this.eventsBacklogSkipped) {
        for (const msg of messages) {
          this.seenEventIds.add(msg.eventId);
        }
        this.eventsBacklogSkipped = true;
        return;
      }

      if (messages.length === 0) return;

      for (const msg of messages) {
        if (this.seenEventIds.has(msg.eventId)) continue;
        this._rememberEventId(msg.eventId);
        this._routeHCSMessage(msg.topicKey, msg);
      }
    } catch (err) {
      console.warn('[EventListener] Cloudflare events poll error:', err.message);
    }
  }

  _rememberEventId(eventId) {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size <= this.maxSeenEventIds) return;

    const oldest = this.seenEventIds.values().next().value;
    if (oldest) {
      this.seenEventIds.delete(oldest);
    }
  }

  async fetchCloudflareEvents() {
    const url = `${EVENTS_API_BASE_URL}/events?limit=${EVENT_FETCH_LIMIT}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Events API responded ${res.status}`);
    }

    const json = await res.json();
    const events = Array.isArray(json?.data?.events) ? json.data.events : [];

    return events
      .filter((event) => typeof event?.id === 'string' && event.id.length > 0)
      .map((event) => {
        const rawMessage = event?.rawMessage && typeof event.rawMessage === 'object'
          ? event.rawMessage
          : null;
        const parsedData = rawMessage || {
          type: event?.messageType || 'UNKNOWN',
          agentId: event?.agentId || 'unknown',
          timestamp: event?.messageTimestamp || Date.now(),
          payload: event?.payload && typeof event.payload === 'object' ? event.payload : {},
        };
        const topicKey = this._topicKeyFromTopicId(event?.topicId);
        this.syntheticSequence += 1;

        return {
          eventId: event.id,
          topicKey,
          sequenceNumber: this.syntheticSequence,
          timestamp: event?.receivedAt || String(Date.now()),
          parsedData,
        };
      })
      .filter((event) => event.topicKey !== null)
      .sort((a, b) => {
        const aTs = Number(new Date(a.timestamp).getTime()) || 0;
        const bTs = Number(new Date(b.timestamp).getTime()) || 0;
        return aTs - bTs;
      });
  }

  _topicKeyFromTopicId(topicId) {
    const normalized = String(topicId || '');
    const topics = this.config?.hcsTopics || {};
    if (normalized === topics.discovery) return 'discovery';
    if (normalized === topics.auditLog) return 'auditLog';
    if (normalized === topics.agentComms) return 'agentComms';
    return null;
  }

  /**
   * Compatibility shim for older tests/imports.
   * Returns the same shape as `fetchCloudflareEvents()`.
   */
  async fetchHCSMessages() {
    return this.fetchCloudflareEvents().map((event) => {
      return {
        sequenceNumber: event.sequenceNumber,
        timestamp: event.timestamp,
        parsedData: event.parsedData,
      };
    });
  }

  /** Build a lightweight tx-metadata object from an ethers event. */
  _mkTx(ev, blockTs) {
    return {
      hash:        ev.transactionHash,
      blockNumber: ev.blockNumber,
      receivedAt:  Date.now(),
      finalityMs:  blockTs ? Math.max(0, Date.now() - blockTs * 1000) : null,
    };
  }

  /** Route a parsed HCS message to the right store action. */
  _routeHCSMessage(topicKey, msg) {
    const { parsedData, timestamp, sequenceNumber } = msg;
    const topicId = this.config?.hcsTopics?.[topicKey] || topicKey;
    const payload = parsedData?.payload && typeof parsedData.payload === "object"
      ? parsedData.payload
      : {};
    const entry = {
      ...payload,
      ...parsedData,
      _hcsTimestamp:  timestamp,
      _hcsSequence:   sequenceNumber,
      _hcsTopic:      topicId,
    };

    if (topicKey === 'discovery') {
      if (this.onlyTestDiscoveries) {
        const contractAddress = String(entry.contractAddress ?? payload.contractAddress ?? '').toLowerCase();
        if (!contractAddress) return;
        if (
          this.allowedDiscoveryContracts.size > 0 &&
          !this.allowedDiscoveryContracts.has(contractAddress)
        ) {
          return;
        }
        if (this.seenTestDiscoveries.has(contractAddress)) return;
        this.seenTestDiscoveries.add(contractAddress);
      }

      this.store.addDiscovery(entry);
      this.store.incrementStat('totalDiscoveries');
      this.store.addLogEntry({ ...entry, source: 'discovery' });
    } else if (topicKey === 'auditLog') {
      // Normalize HCS snake_case bid type to match the contract event name so the
      // TX explorer displays it with the correct BID badge and AUCTIONS filter.
      let displayEntry = entry;
      if (parsedData.type === 'BID_SUBMITTED') {
        const agentName = payload.agentId ?? 'unknown';
        const bidAmount = payload.bidAmount ?? 0;
        displayEntry = {
          ...entry,
          type: 'BidSubmitted',
          agentName,
          bidFormatted: parseGuardAmount(bidAmount),
          jobId: String(payload.jobId ?? sequenceNumber),
        };
      } else if (parsedData.type === 'BID_SKIPPED') {
        displayEntry = {
          ...entry,
          type: 'BID_SKIPPED',
          jobId: String(payload.jobId ?? payload.contractAddress ?? sequenceNumber),
          reason: payload.reason ?? payload.reasonCode ?? 'Bid skipped',
        };
      } else if (parsedData.type === 'BID_SUBMISSION_FAILED') {
        displayEntry = {
          ...entry,
          type: 'BID_SUBMISSION_FAILED',
          jobId: String(payload.jobId ?? payload.contractAddress ?? sequenceNumber),
          reason: payload.error ?? payload.reasonCode ?? 'Bid failed',
        };
      } else if (parsedData.type === 'LLM_PROVIDER_READY') {
        displayEntry = {
          ...entry,
          type: 'LLM_PROVIDER_READY',
          reason: `Provider ${payload.providerAddress ?? 'unknown'} ready`,
        };
      } else if (parsedData.type === 'LLM_PROVIDER_UNHEALTHY') {
        displayEntry = {
          ...entry,
          type: 'LLM_PROVIDER_UNHEALTHY',
          reason: payload.reason ?? payload.reasonCode ?? 'Provider unhealthy',
        };
      } else if (parsedData.type === 'LLM_INFERENCE_STARTED') {
        displayEntry = {
          ...entry,
          type: 'LLM_INFERENCE_STARTED',
          jobId: String(payload.jobId ?? sequenceNumber),
          reason: `Inference started (${payload.model ?? 'unknown model'})`,
        };
      } else if (parsedData.type === 'LLM_INFERENCE_SUCCEEDED') {
        displayEntry = {
          ...entry,
          type: 'LLM_INFERENCE_SUCCEEDED',
          jobId: String(payload.jobId ?? sequenceNumber),
          reason: `Inference ok (${payload.findingsCount ?? 0} findings)`,
        };
      } else if (parsedData.type === 'LLM_INFERENCE_FAILED') {
        displayEntry = {
          ...entry,
          type: 'LLM_INFERENCE_FAILED',
          jobId: String(payload.jobId ?? sequenceNumber),
          reason: payload.reason ?? payload.reasonCode ?? 'Inference failed',
        };
      }
      if (parsedData.type !== 'REPORT_METADATA') {
        this.store.addLogEntry({ ...displayEntry, source: 'auditLog' });
      }
      // Also update specific slices based on type
      if (parsedData.type === 'REPORT_METADATA') {
        const jobId = String(payload.jobId ?? sequenceNumber);
        this.store.addReportMetadata?.(jobId, {
          cid: payload.cid,
          listingId: payload.listingId,
          contentHash: payload.contentHash,
          deployer: payload.deployer,
          agentCount: payload.agentCount,
          findingCount: payload.findingCount,
        });
        this.store.addLogEntry({
          type: 'REPORT_PUBLISHED',
          jobId,
          timestamp: Math.floor(Date.now() / 1000),
          data: { cid: payload.cid, findingCount: payload.findingCount },
          source: 'auditLog',
        });
        console.log(`[EventListener] REPORT_METADATA for job ${jobId}, CID: ${payload.cid}`);
      } else if (parsedData.type === 'JOB_CREATED') {
        const contractAddress = String(payload.contractAddress ?? '').toLowerCase();
        if (
          this.onlyTestDiscoveries &&
          this.allowedDiscoveryContracts.size > 0 &&
          !this.allowedDiscoveryContracts.has(contractAddress)
        ) {
          return;
        }

        const jobId = String(payload.jobId ?? sequenceNumber);
        this.store.setJob(jobId, {
          jobId,
          contractAddress: payload.contractAddress,
          contractChain: payload.chain ?? 'hedera',
          contractType: payload.contractType ?? 'unknown',
          budgetAvailable: payload.budget ?? 0,
          budgetFormatted: parseGuardAmount(payload.budget ?? 0),
          initialRiskScore: Number(payload.riskScore ?? 0),
          lineCount: Number(payload.estimatedLOC ?? payload.estimatedLineCount ?? 0),
          postedAt: Date.now(),
        });
        this.store.incrementStat('totalAuctions');
      } else if (parsedData.type === 'BID_SUBMITTED') {
        const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
        this.store.addBid(jobId, {
          agent: payload.evmAddress ?? payload.agentAddress ?? payload.agentId,
          agentName: payload.agentId ?? 'unknown',
          bidAmount: payload.bidAmount ?? 0,
          bidFormatted: parseGuardAmount(payload.bidAmount ?? 0),
          collateralLocked: payload.collateral ?? 0,
          reputationAtBid: Number(payload.reputation ?? 0),
          specialization: payload.specialization ?? 'unknown',
          estimatedCompletionTime: Number(payload.estimatedTimeSec ?? 0),
          timestamp: parsedData.timestamp ?? Date.now(),
        });
        this.store.addJobBidStatus?.(jobId, {
          status: 'submitted',
          agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
          evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
          reason: null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
        this.store.incrementStat('totalBids');
      } else if (parsedData.type === 'BID_SKIPPED') {
        const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
        this.store.addJobBidStatus?.(jobId, {
          status: 'skipped',
          agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
          evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
          reason: payload.reason ?? payload.reasonCode ?? 'Bid skipped',
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'BID_SUBMISSION_FAILED') {
        const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
        this.store.addJobBidStatus?.(jobId, {
          status: 'failed',
          agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
          evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
          reason: payload.error ?? payload.reasonCode ?? 'Bid failed',
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'AUCTION_INVITE_SUMMARY') {
        const jobId = String(payload.jobId ?? sequenceNumber);
        const invites = Array.isArray(payload.eligibleAgents) ? payload.eligibleAgents : [];
        for (const invite of invites) {
          this.store.addJobBidStatus?.(jobId, {
            status: 'invite_sent',
            agentId: invite?.agentId ?? 'unknown',
            evmAddress: invite?.evmAddress ?? null,
            reason: null,
            timestamp: parsedData.timestamp ?? Date.now(),
          });
        }
      } else if (parsedData.type === 'AGENT_REGISTERED') {
        const addr = payload.evmAddress ?? payload.agentAddress ?? parsedData.address;
        if (!addr) return;

        const rep = Number(payload.reputation ?? payload.reputationScore ?? 0);
        const reputationScore = rep <= 100 ? Math.round(rep * 100) : Math.round(rep);
        const stakedAmountRaw =
          payload.stakedAmount != null
            ? BigInt(payload.stakedAmount)
            : BigInt(Math.max(0, Math.floor(Number(payload.stake ?? 0) * 1e8)));

        this.store.setAgent(addr, {
          ...(this.store.agents?.[addr] || {}),
          address: addr,
          agentId: parsedData.agentId ?? payload.agentId ?? 'unknown-agent',
          specializations: payload.specializations ?? [],
          ucpEndpoint: payload.ucpEndpoint ?? payload.endpoint ?? '',
          stakedAmount: stakedAmountRaw,
          stakedFormatted: parseGuardAmount(stakedAmountRaw),
          reputation: rep,
          reputationScore,
          status: 'ACTIVE',
          source: 'hcs_auditlog',
          lastSeenAt: Date.now(),
        });
      } else if (parsedData.type === 'LLM_PROVIDER_READY') {
        this.store.setLlmProviderStatus?.(parsedData.agentId ?? 'llm-contextual-003', {
          status: 'ready',
          providerAddress: payload.providerAddress ?? null,
          model: payload.model ?? null,
          endpoint: payload.endpoint ?? null,
          reason: null,
          reasonCode: null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'LLM_PROVIDER_UNHEALTHY') {
        this.store.setLlmProviderStatus?.(parsedData.agentId ?? 'llm-contextual-003', {
          status: 'unhealthy',
          providerAddress: payload.providerAddress ?? null,
          model: payload.model ?? null,
          endpoint: payload.endpoint ?? null,
          reason: payload.reason ?? null,
          reasonCode: payload.reasonCode ?? null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'LLM_INFERENCE_STARTED') {
        const jobId = String(payload.jobId ?? sequenceNumber);
        this.store.addLlmInferenceStatus?.(jobId, {
          status: 'started',
          agentId: parsedData.agentId ?? 'llm-contextual-003',
          providerAddress: payload.providerAddress ?? null,
          model: payload.model ?? null,
          reason: null,
          reasonCode: null,
          findingsCount: null,
          usedFallback: null,
          requestId: payload.requestId ?? null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'LLM_INFERENCE_SUCCEEDED') {
        const jobId = String(payload.jobId ?? sequenceNumber);
        this.store.addLlmInferenceStatus?.(jobId, {
          status: 'succeeded',
          agentId: parsedData.agentId ?? 'llm-contextual-003',
          providerAddress: payload.providerAddress ?? null,
          model: payload.model ?? null,
          reason: null,
          reasonCode: null,
          findingsCount: Number(payload.findingsCount ?? 0),
          usedFallback: Boolean(payload.usedFallback),
          requestId: payload.requestId ?? null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      } else if (parsedData.type === 'LLM_INFERENCE_FAILED') {
        const jobId = String(payload.jobId ?? sequenceNumber);
        this.store.addLlmInferenceStatus?.(jobId, {
          status: 'failed',
          agentId: parsedData.agentId ?? 'llm-contextual-003',
          providerAddress: payload.providerAddress ?? null,
          model: payload.model ?? null,
          reason: payload.reason ?? null,
          reasonCode: payload.reasonCode ?? null,
          findingsCount: null,
          usedFallback: null,
          requestId: payload.requestId ?? null,
          timestamp: parsedData.timestamp ?? Date.now(),
        });
      }
    } else if (topicKey === 'agentComms') {
      this.store.addLogEntry({ ...entry, source: 'agentComms' });
    }
  }

  // ── Contract event polling ───────────────────────────────

  startContractEventPolling() {
    if (!this.provider || !this.contracts) {
      console.warn('[EventListener] No provider/contracts — skipping contract polling');
      return;
    }

    this._intervals.push(setInterval(() => {
      this._pollContractEvents();
    }, CONTRACT_POLL_MS));
  }

  async _pollContractEvents() {
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (this.lastProcessedBlock === null) {
        // In test mode, skip historical backfill to avoid stale jobs on page load.
        this.lastProcessedBlock = this.onlyTestDiscoveries
          ? currentBlock
          : Math.max(0, currentBlock - 100);
      }

      if (currentBlock <= this.lastProcessedBlock) return; // no new blocks

      const from = this.lastProcessedBlock + 1;
      const to   = currentBlock;

      // Fetch latest block timestamp once for finality calculation
      let blockTs = null;
      try {
        const block = await this.provider.getBlock(to);
        blockTs = block?.timestamp || null;
      } catch { /* non-critical */ }

      // Run all queries in parallel
      const {
        auctionContract, agentRegistryContract,
        subAuctionContract, dataMarketplaceContract, paymentSettlementContract,
        vaultFactoryContract, stakingManagerContract, treasuryContract,
      } = this.contracts;

      // Helper: safely query a contract that may not be deployed yet
      const q = (contract, event) =>
        contract ? contract.queryFilter(event, from, to).catch(() => []) : Promise.resolve([]);

      const [
        jobPosted, bidSubmitted, winnersSelected, bidRefunded,
        agentRegistered, reputationUpdated, agentPromoted,
        subAuctionCreated, subBidSubmitted, subContractorSelected,
        resultDelivered, resultAccepted,
        dataListed, dataPurchased, dataRated,
        jobSettled, subJobSettled,
        // Day 3
        vaultCreated, autoAuditTriggered,
        staked, stakeLocked, stakeUnlocked,
        slashInitiated, appealFiled, appealApproved, appealDenied,
        feeReceived, feeDistributed,
      ] = await Promise.all([
        q(auctionContract, 'JobPosted'),
        q(auctionContract, 'BidSubmitted'),
        q(auctionContract, 'WinnersSelected'),
        q(auctionContract, 'BidRefunded'),
        q(agentRegistryContract, 'AgentRegistered'),
        q(agentRegistryContract, 'ReputationUpdated'),
        q(agentRegistryContract, 'AgentPromoted'),
        q(subAuctionContract, 'SubAuctionCreated'),
        q(subAuctionContract, 'SubBidSubmitted'),
        q(subAuctionContract, 'SubContractorSelected'),
        q(subAuctionContract, 'ResultDelivered'),
        q(subAuctionContract, 'ResultAccepted'),
        q(dataMarketplaceContract, 'DataListed'),
        q(dataMarketplaceContract, 'DataPurchased'),
        q(dataMarketplaceContract, 'DataRated'),
        q(paymentSettlementContract, 'JobSettled'),
        q(paymentSettlementContract, 'SubJobSettled'),
        // Day 3
        q(vaultFactoryContract, 'VaultCreated'),
        q(vaultFactoryContract, 'AutoAuditTriggered'),
        q(stakingManagerContract, 'Staked'),
        q(stakingManagerContract, 'StakeLocked'),
        q(stakingManagerContract, 'StakeUnlocked'),
        q(stakingManagerContract, 'SlashInitiated'),
        q(stakingManagerContract, 'AppealFiled'),
        q(stakingManagerContract, 'AppealApproved'),
        q(stakingManagerContract, 'AppealDenied'),
        q(treasuryContract, 'FeeReceived'),
        q(treasuryContract, 'FeeDistributed'),
      ]);

      // ── Process AuditAuction events ──

      for (const ev of jobPosted) {
        const a = ev.args;
        const contractAddress = String(a.contractAddress ?? '').toLowerCase();
        if (
          this.onlyTestDiscoveries &&
          this.allowedDiscoveryContracts.size > 0 &&
          !this.allowedDiscoveryContracts.has(contractAddress)
        ) {
          continue;
        }

        this.store.setJob(a.jobId.toString(), {
          jobId: a.jobId.toString(),
          contractAddress: a.contractAddress,
          contractChain: a.contractChain,
          contractType: a.contractType,
          budgetAvailable: a.budgetAvailable,
          budgetFormatted: parseGuardAmount(a.budgetAvailable),
          auctionDeadline: a.auctionDeadline,
          initialRiskScore: Number(a.initialRiskScore),
          lineCount: Number(a.lineCount),
          blockNumber: ev.blockNumber,
        });
        this.store.incrementStat('totalAuctions');
        this.store.addLogEntry({
          type: 'JobPosted',
          source: 'contract',
          jobId: a.jobId.toString(),
          contractAddress: a.contractAddress,
          budgetFormatted: parseGuardAmount(a.budgetAvailable),
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of bidSubmitted) {
        const a = ev.args;
        const bid = {
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          bidAmount: a.bidAmount,
          bidFormatted: parseGuardAmount(a.bidAmount),
          collateralLocked: a.collateralLocked,
          reputationAtBid: Number(a.reputationAtBid),
          specialization: a.specialization,
          estimatedCompletionTime: Number(a.estimatedCompletionTime),
          blockNumber: ev.blockNumber,
        };
        this.store.addBid(a.jobId.toString(), bid);
        this.store.incrementStat('totalBids');
        this.store.addLogEntry({
          type: 'BidSubmitted',
          source: 'contract',
          jobId: a.jobId.toString(),
          agentName: bid.agentName,
          bidFormatted: bid.bidFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of winnersSelected) {
        const a = ev.args;
        this.store.setWinners(a.jobId.toString(), {
          agents: Array.from(a.winners),
          totalEscrowed: a.totalEscrowed,
          totalEscrowedFormatted: parseGuardAmount(a.totalEscrowed),
          platformFee: a.platformFee,
          platformFeeFormatted: parseGuardAmount(a.platformFee),
        });
        this.store.addLogEntry({
          type: 'WinnersSelected',
          source: 'contract',
          jobId: a.jobId.toString(),
          winnerCount: a.winners.length,
          timestamp: Date.now(),
        });
      }

      for (const ev of bidRefunded) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'BidRefunded',
          source: 'contract',
          jobId: a.jobId.toString(),
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          refunded: parseGuardAmount(a.refundedCollateral),
          timestamp: Date.now(),
        });
      }

      // ── Process AgentRegistry events ──

      for (const ev of agentRegistered) {
        const a = ev.args;
        this.store.setAgent(a.agent, {
          address: a.agent,
          agentId: a.agentId,
          ucpEndpoint: a.ucpEndpoint,
          stakedAmount: a.stakedAmount,
          stakedFormatted: parseGuardAmount(a.stakedAmount),
        });
        this.store.addLogEntry({
          type: 'AgentRegistered',
          source: 'contract',
          agentId: a.agentId,
          address: a.agent,
          timestamp: Date.now(),
        });
      }

      for (const ev of reputationUpdated) {
        const a = ev.args;
        this.store.setAgent(a.agent, {
          ...(this.store.agents?.[a.agent] || {}),
          address: a.agent,
          reputation: Number(a.newReputation),
          lastReputationDelta: Number(a.delta),
        });
        this.store.addLogEntry({
          type: 'ReputationUpdated',
          source: 'contract',
          address: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          delta: Number(a.delta),
          newReputation: Number(a.newReputation),
          timestamp: Date.now(),
        });
      }

      for (const ev of agentPromoted) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'AgentPromoted',
          source: 'contract',
          address: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          fromTier: Number(a.from),
          toTier: Number(a.to),
          timestamp: Date.now(),
        });
      }

      // ── Process SubAuction events ──

      for (const ev of subAuctionCreated) {
        const a = ev.args;
        const subJobId = a.subJobId.toString();
        const parentJobId = a.parentJobId.toString();
        const paymentFormatted = parseGuardAmount(a.paymentAmount);
        this.store.addSubJob({
          subJobId,
          parentJobId,
          requester: a.requester,
          requesterName: resolveAgentName(a.requester, this.config),
          taskDescription: a.taskDescription,
          requiredSpecialization: a.requiredSpecialization,
          paymentAmount: a.paymentAmount,
          paymentFormatted,
          slaDeadline: a.slaDeadline,
          auctionDeadline: a.auctionDeadline,
          status: 'OPEN',
          blockNumber: ev.blockNumber,
        });
        this.store.incrementStat('totalSubAuctions');
        this.store.addLogEntry({
          type: 'SUB_AUCTION_CREATED',
          source: 'contract',
          subJobId,
          parentJobId,
          requesterName: resolveAgentName(a.requester, this.config),
          taskDescription: a.taskDescription,
          requiredSpecialization: a.requiredSpecialization,
          paymentFormatted,
          timestamp: Date.now(),
        });
      }

      for (const ev of subBidSubmitted) {
        const a = ev.args;
        const subJobId = a.subJobId.toString();
        const bid = {
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          proposedPrice: a.proposedPrice,
          proposedPriceFormatted: parseGuardAmount(a.proposedPrice),
          collateralLocked: a.collateralLocked,
          estimatedTime: Number(a.estimatedTime),
          blockNumber: ev.blockNumber,
        };
        this.store.addSubBid(subJobId, bid);
        this.store.addLogEntry({
          type: 'SUB_BID',
          source: 'contract',
          subJobId,
          agentName: bid.agentName,
          bidFormatted: bid.proposedPriceFormatted,
          timestamp: Date.now(),
        });
      }

      for (const ev of subContractorSelected) {
        const a = ev.args;
        const subJobId = a.subJobId.toString();
        const agentName = resolveAgentName(a.agent, this.config);
        const agreedPriceFormatted = parseGuardAmount(a.agreedPrice);
        this.store.updateSubJobStatus(subJobId, {
          selectedAgent: a.agent,
          selectedAgentName: agentName,
          agreedPrice: a.agreedPrice,
          agreedPriceFormatted,
          status: 'IN_PROGRESS',
        });
        this.store.addLogEntry({
          type: 'SUB_SELECTED',
          source: 'contract',
          subJobId,
          agentName,
          agreedPriceFormatted,
          timestamp: Date.now(),
        });
      }

      for (const ev of resultDelivered) {
        const a = ev.args;
        const subJobId = a.subJobId.toString();
        this.store.updateSubJobStatus(subJobId, {
          resultHash: a.resultHash,
          deliveredBy: a.agent,
          status: 'DELIVERED',
        });
        this.store.addLogEntry({
          type: 'RESULT_DELIVERED',
          source: 'contract',
          subJobId,
          agentName: resolveAgentName(a.agent, this.config),
          timestamp: Date.now(),
        });
      }

      for (const ev of resultAccepted) {
        const a = ev.args;
        const subJobId = a.subJobId.toString();
        this.store.updateSubJobStatus(subJobId, {
          status: 'ACCEPTED',
          completedAt: Date.now(),
        });
        // Create GUARD flow — look up stored sub-job for requester/agent addresses
        const subJob = this.store.subJobs?.[subJobId];
        if (subJob?.selectedAgent) {
          this.store.addGuardFlow({
            from: subJob.requester,
            to: subJob.selectedAgent,
            toName: subJob.selectedAgentName,
            amount: a.paymentAmount,
            amountFormatted: parseGuardAmount(a.paymentAmount),
            type: 'SUB_CONTRACT',
            jobId: subJob.parentJobId,
            timestamp: Date.now(),
          });
        }
        this.store.addLogEntry({
          type: 'RESULT_ACCEPTED',
          source: 'contract',
          subJobId,
          paymentFormatted: parseGuardAmount(a.paymentAmount),
          timestamp: Date.now(),
        });
      }

      // ── Process DataMarketplace events ──

      for (const ev of dataListed) {
        const a = ev.args;
        const listingId = a.listingId.toString();
        const parentJobId = a.parentJobId ? a.parentJobId.toString() : null;
        const categoryStr = DATA_CATEGORIES[Number(a.category)] || `CAT_${a.category}`;
        const listingTypeStr = LISTING_TYPES[Number(a.listingType)] || `TYPE_${a.listingType}`;
        const priceFormatted = parseGuardAmount(a.price);
        this.store.addDataListing({
          listingId,
          parentJobId,
          seller: a.seller,
          sellerName: resolveAgentName(a.seller, this.config),
          title: a.title,
          category: Number(a.category),
          categoryStr,
          listingType: Number(a.listingType),
          listingTypeStr,
          price: a.price,
          priceFormatted,
          contentHash: a.contentHash,
          blockNumber: ev.blockNumber,
          active: true,
          _tx: this._mkTx(ev, blockTs),
        });
        this.store.addLogEntry({
          type: 'DATA_LISTED',
          source: 'contract',
          listingId,
          parentJobId,
          sellerName: resolveAgentName(a.seller, this.config),
          title: a.title,
          priceFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of dataPurchased) {
        const a = ev.args;
        const listingId = a.listingId.toString();
        const pricePaidFormatted = parseGuardAmount(a.pricePaid);
        const purchase = {
          listingId,
          buyer: a.buyer,
          buyerName: resolveAgentName(a.buyer, this.config),
          seller: a.seller,
          sellerName: resolveAgentName(a.seller, this.config),
          pricePaid: a.pricePaid,
          pricePaidFormatted,
          platformFee: a.platformFee,
          timestamp: Date.now(),
        };
        this.store.addDataPurchase(purchase);
        this.store.addGuardFlow({
          from: a.buyer,
          fromName: resolveAgentName(a.buyer, this.config),
          to: a.seller,
          toName: resolveAgentName(a.seller, this.config),
          amount: a.pricePaid,
          amountFormatted: pricePaidFormatted,
          type: 'DATA_PURCHASE',
          listingId,
          timestamp: Date.now(),
        });
        this.store.incrementStat('totalDataSales');
        this.store.addLogEntry({
          type: 'DATA_PURCHASED',
          source: 'contract',
          listingId,
          buyerName: purchase.buyerName,
          sellerName: purchase.sellerName,
          pricePaidFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of dataRated) {
        const a = ev.args;
        const listingId = a.listingId.toString();
        const rating = Number(a.rating);
        this.store.updateDataPurchaseRating(listingId, a.buyer, rating);
        this.store.addLogEntry({
          type: 'DATA_RATED',
          source: 'contract',
          listingId,
          buyerName: resolveAgentName(a.buyer, this.config),
          rating,
          timestamp: Date.now(),
        });
      }

      // ── Process PaymentSettlement events ──

      for (const ev of jobSettled) {
        const a = ev.args;
        const settlementId = a.settlementId.toString();
        const jobId = a.jobId.toString();
        const totalDisbursed = a.totalDisbursed;
        const totalDisbursedFormatted = parseGuardAmount(totalDisbursed);
        this.store.addSettlement({
          settlementId,
          jobId,
          totalDisbursed,
          totalDisbursedFormatted,
          platformFee: a.platformFee,
          reportFees: a.reportFees,
          recipientCount: Number(a.recipientCount),
          blockNumber: ev.blockNumber,
          timestamp: Date.now(),
        });
        this.store.incrementStat('totalSettlements');
        this.store.incrementStat('totalGuardTransacted', Number(totalDisbursed) / 100_000_000);
        this.store.addLogEntry({
          type: 'JOB_SETTLED',
          source: 'contract',
          settlementId,
          jobId,
          totalDisbursedFormatted,
          recipientCount: Number(a.recipientCount),
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
        // Fetch per-recipient breakdown and emit individual GUARD flows
        if (paymentSettlementContract) {
          try {
            const payments = await paymentSettlementContract.getSettlementPayments(a.settlementId);
            for (const payment of payments) {
              const total = payment.basePayment + payment.bonus;
              this.store.addGuardFlow({
                from: 'vault',
                to: payment.recipient,
                toName: resolveAgentName(payment.recipient, this.config),
                amount: total,
                amountFormatted: parseGuardAmount(total),
                type: payment.description || 'SETTLEMENT',
                jobId,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            console.warn('[EventListener] Could not fetch settlement payments:', err.message);
          }
        }
      }

      for (const ev of subJobSettled) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'SUB_JOB_SETTLED',
          source: 'contract',
          settlementId: a.settlementId.toString(),
          subJobId: a.subJobId.toString(),
          agentName: resolveAgentName(a.agent, this.config),
          amountFormatted: parseGuardAmount(a.amount),
          timestamp: Date.now(),
        });
      }

      // ── Process VaultFactory events ──

      for (const ev of vaultCreated) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'VAULT_CREATED',
          source: 'contract',
          contractAddress: a.contractAddress,
          vault: a.vault,
          creator: a.creator,
          contractChain: a.contractChain,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of autoAuditTriggered) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'AUTO_AUDIT_TRIGGERED',
          source: 'contract',
          contractAddress: a.contractAddress,
          vault: a.vault,
          reason: a.reason,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        });
      }

      // ── Process StakingManager events ──

      for (const ev of staked) {
        const a = ev.args;
        const agentName = resolveAgentName(a.agent, this.config);
        this.store.updateAgentStake(a.agent, a.newTotal);
        this.store.addLogEntry({
          type: 'STAKE_LOCKED',
          source: 'contract',
          agent: a.agent,
          agentName,
          amount: parseGuardAmount(a.amount),
          newTotal: parseGuardAmount(a.newTotal),
          timestamp: Date.now(),
        });
      }

      for (const ev of stakeLocked) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'STAKE_LOCKED',
          source: 'contract',
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          amount: parseGuardAmount(a.amount),
          jobId: a.jobId.toString(),
          timestamp: Date.now(),
        });
      }

      for (const ev of stakeUnlocked) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'STAKE_UNLOCKED',
          source: 'contract',
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          amount: parseGuardAmount(a.amount),
          jobId: a.jobId.toString(),
          timestamp: Date.now(),
        });
      }

      const SLASH_REASONS = [
        'FALSE_POSITIVE', 'FALSE_NEGATIVE', 'MALICIOUS_REPORT',
        'SLA_VIOLATION', 'COLLUSION', 'PLAGIARISM',
      ];

      for (const ev of slashInitiated) {
        const a = ev.args;
        const slashId = a.slashId.toString();
        const reasonStr = SLASH_REASONS[Number(a.reason)] || `REASON_${a.reason}`;
        const slash = {
          slashId,
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          reason: Number(a.reason),
          reasonStr,
          slashedAmount: a.slashedAmount,
          slashedAmountFormatted: parseGuardAmount(a.slashedAmount),
          slashBasisPoints: Number(a.slashBasisPoints),
          jobId: a.jobId.toString(),
          timestamp: Date.now(),
          appealStatus: 'NONE',
        };
        this.store.addSlashEvent(slash);
        this.store.addLogEntry({
          type: 'SLASH_INITIATED',
          source: 'contract',
          ...slash,
          _tx: this._mkTx(ev, blockTs),
        });
      }

      for (const ev of appealFiled) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'APPEAL_FILED',
          source: 'contract',
          slashId: a.slashId.toString(),
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          reason: a.reason,
          timestamp: Date.now(),
        });
      }

      for (const ev of appealApproved) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'APPEAL_APPROVED',
          source: 'contract',
          slashId: a.slashId.toString(),
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          restoredAmount: parseGuardAmount(a.restoredAmount),
          timestamp: Date.now(),
        });
      }

      for (const ev of appealDenied) {
        const a = ev.args;
        this.store.addLogEntry({
          type: 'APPEAL_DENIED',
          source: 'contract',
          slashId: a.slashId.toString(),
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          finalizedAmount: parseGuardAmount(a.finalizedAmount),
          timestamp: Date.now(),
        });
      }

      // ── Process Treasury events ──

      for (const ev of feeReceived) {
        const a = ev.args;
        this.store.addTreasuryRevenue(Number(a.source), a.amount);
        this.store.addLogEntry({
          type: 'FEE_RECEIVED',
          source: 'contract',
          feeSource: Number(a.source),
          amount: parseGuardAmount(a.amount),
          jobId: a.jobId.toString(),
          fromContract: a.fromContract,
          timestamp: Date.now(),
        });
      }

      for (const ev of feeDistributed) {
        const a = ev.args;
        const dist = {
          distributionId: a.distributionId.toString(),
          totalDistributed: parseGuardAmount(a.totalDistributed),
          ucpAmount: parseGuardAmount(a.ucpAmount),
          reserveAmount: parseGuardAmount(a.reserveAmount),
          burnAmount: parseGuardAmount(a.burnAmount),
          timestamp: Date.now(),
        };
        this.store.addTreasuryDistribution(dist);
        this.store.addLogEntry({
          type: 'FEE_DISTRIBUTED',
          source: 'contract',
          ...dist,
        });
      }

      this.lastProcessedBlock = to;
    } catch (err) {
      console.warn('[EventListener] Contract poll error:', err.message);
    }
  }
}
