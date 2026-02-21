/**
 * EventListenerService
 *
 * Unified event ingestion — manages Cloudflare events API polling
 * and ethers.js contract-event polling, routing everything into
 * the Zustand store.
 */
import { normalizeAuctionType } from '../utils/auction-type';

const EVENTS_API_BASE_URL = (
  import.meta.env.VITE_EVENTS_API_BASE_URL || '/api'
).replace(/\/$/, '');

const HCS_POLL_MS = 2_000;       // balanced-fast default for HCS topics
const CONTRACT_POLL_MS = 2_000;  // balanced-fast default for on-chain events
const MIN_POLL_MS = 500;
const DEFAULT_SOURCE_MODE = 'onchain_strict';
const DEFAULT_HCS_REPLAY_MODE = 'from_now';
const EVENT_FETCH_LIMIT = 500;

// ── DataMarketplace enum mappings ───────────────────────────
const DATA_CATEGORIES = [
  'SCAN_REPORT', 'DEPENDENCY_ANALYSIS', 'EXPLOIT_DATABASE',
  'HOT_LEAD', 'FUZZING_SEEDS', 'THREAT_INTEL',
];
const LISTING_TYPES = ['ONE_TIME', 'SUBSCRIPTION', 'TIP'];
const SETTLEMENT_PAYMENT_TYPE = {
  AUDIT: 0,
  REPORT: 1,
  SUB_AUCTION: 2,
  BOUNTY: 3,
};

function resolveTreasuryAddress(config) {
  return (
    config?.contracts?.treasury?.evmAddress ||
    config?.contracts?.treasury?.address ||
    'treasury'
  );
}

function resolveSettlementFlowType(paymentType, description = '') {
  const kind = Number(paymentType);
  const normalized = String(description || '').toLowerCase();
  if (kind === SETTLEMENT_PAYMENT_TYPE.SUB_AUCTION) return 'SUB_CONTRACT';
  if (kind === SETTLEMENT_PAYMENT_TYPE.REPORT) return 'REPORT_FEE';
  if (normalized.includes('speed')) return 'BONUS_SPEED';
  if (normalized.includes('unique')) return 'BONUS_UNIQUE_FINDING';
  return 'MAIN_AUDIT';
}

function parsePollIntervalMs(value, fallbackMs) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < MIN_POLL_MS) return fallbackMs;
  return Math.floor(raw);
}

// ── Helpers ────────────────────────────────────────────────

/** Convert raw 8-decimal BigInt to human-readable "15.00 GUARD" */
export function parseGuardAmount(raw) {
  const n = typeof raw === 'bigint' ? raw : BigInt(raw);
  const whole = n / 100_000_000n;
  const frac  = n % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').slice(0, 2);
  return `${whole}.${fracStr} GUARD`;
}

function parseDisplayBidAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return {
    value: numeric,
    formatted: `${numeric.toFixed(2)} GUARD`,
  };
}

function normalizeGuardRaw(value) {
  try {
    const raw = typeof value === 'bigint' ? value : BigInt(value ?? 0);
    return { raw, formatted: parseGuardAmount(raw) };
  } catch {
    return { raw: 0n, formatted: parseGuardAmount(0n) };
  }
}

function isWinnerSelectedType(type) {
  return type === 'WINNER_SELECTED' || type === 'WINNERS_SELECTED';
}

const BID_FAILURE_REASON_LABELS = {
  insufficient_payer_hbar: "Insufficient payer HBAR for transaction fees",
  insufficient_payer_hbar_after_topup: "Insufficient payer HBAR after auto top-up",
  insufficient_funds: "Insufficient funds for bid submission",
  collateral_below_minimum: "Bid collateral below minimum",
  inactive_agent: "Agent is not active on-chain",
  bid_exceeds_budget: "Bid exceeds auction budget",
  auction_expired: "Auction already expired",
  job_not_found: "Auction job not found",
  nonce_conflict: "Nonce conflict while submitting bid",
  network_error: "Network error while submitting bid",
  network_timeout: "Bid submission timed out",
  contract_revert: "Bid submission reverted by contract",
};

function isPayerFundingFailureReason(reasonCode) {
  return (
    reasonCode === 'insufficient_payer_hbar' ||
    reasonCode === 'insufficient_payer_hbar_after_topup'
  );
}

function extractCompactRpcMessage(rawError) {
  if (typeof rawError !== 'string') return '';
  if (!rawError) return '';

  const mirrorMessageMatch = rawError.match(/\"message\":\"([^\"]+)\"/i);
  if (mirrorMessageMatch?.[1]) {
    return mirrorMessageMatch[1];
  }

  if (rawError.length <= 220) return rawError;
  return `${rawError.slice(0, 220)}...`;
}

function normalizeBidFailureReason(payload) {
  const reasonCode = typeof payload?.reasonCode === 'string' ? payload.reasonCode : '';
  const mapped = BID_FAILURE_REASON_LABELS[reasonCode] || '';
  if (mapped) return mapped;

  if (typeof payload?.reason === 'string' && payload.reason.trim()) {
    return payload.reason.trim();
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return extractCompactRpcMessage(payload.error.trim());
  }

  return reasonCode || 'Bid failed';
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
    this.sourceMode = String(
      config?.dashboard?.sourceMode
      || import.meta.env.DASHBOARD_SOURCE_MODE
      || import.meta.env.VITE_DASHBOARD_SOURCE_MODE
      || DEFAULT_SOURCE_MODE
    ).toLowerCase();
    this.hcsReplayMode = String(
      config?.dashboard?.hcsReplayMode
      || import.meta.env.DASHBOARD_HCS_REPLAY_MODE
      || import.meta.env.VITE_DASHBOARD_HCS_REPLAY_MODE
      || DEFAULT_HCS_REPLAY_MODE
    ).toLowerCase();
    this.hcsPollMs = parsePollIntervalMs(
      config?.dashboard?.hcsPollMs
      || import.meta.env.DASHBOARD_HCS_POLL_MS
      || import.meta.env.VITE_DASHBOARD_HCS_POLL_MS
      || HCS_POLL_MS,
      HCS_POLL_MS
    );
    this.contractPollMs = parsePollIntervalMs(
      config?.dashboard?.contractPollMs
      || import.meta.env.DASHBOARD_CONTRACT_POLL_MS
      || import.meta.env.VITE_DASHBOARD_CONTRACT_POLL_MS
      || CONTRACT_POLL_MS,
      CONTRACT_POLL_MS
    );
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
    this.decodeFailures = 0;
    this.pendingSettlementBreakdowns = 0;
    this.hcsEventsSeen = 0;
    this.contractEventsSeen = 0;
    this._contractPollInFlight = false;

    this._intervals = [];
    this._running = false;

    if (this.onlyTestDiscoveries) {
      console.log(
        `[EventListener] TEST_MODE discovery filter enabled ` +
        `(${this.allowedDiscoveryContracts.size} configured test contracts)`
      );
    }
    this.store.setIngestionHealth?.({
      sourceMode: this.sourceMode,
      replayMode: this.hcsReplayMode,
      hcsPollMs: this.hcsPollMs,
      contractPollMs: this.contractPollMs,
    });
  }

  // ── public ───────────────────────────────────────────────

  startAll() {
    if (this._running) {
      console.warn('[EventListener] startAll called while already running on same instance; ignoring');
      return () => this.stopAll();
    }
    if (EventListenerService._activeService && EventListenerService._activeService !== this) {
      console.warn('[EventListener] startAll ignored because another EventListenerService instance is active');
      return () => {};
    }
    EventListenerService._activeService = this;
    this._running = true;
    this.startHCSPolling();
    this.startContractEventPolling();
    // Sync historical agents (fire-and-forget)
    this._syncHistoricalAgents().catch((err) => {
      console.warn('[EventListener] Agent history sync failed:', err);
    });
    console.log('[EventListener] All polling loops started');
    return () => this.stopAll();
  }

  _setAgentHydrationHealth(status, error = null) {
    this.store.setIngestionHealth?.({
      agentHydrationStatus: status,
      agentHydrationError: error,
      agentHydrationLastAt: Date.now(),
    });
  }

  _normalizeAgentStatus(statusValue) {
    const numeric = Number(statusValue ?? 0);
    const statuses = ['ACTIVE', 'INACTIVE', 'SLASHED', 'SUSPENDED'];
    return statuses[numeric] || 'UNKNOWN';
  }

  async _syncAgentsFromRegistryEvents() {
    if (!this.contracts?.agentRegistryContract) return 0;

    const MAX_BLOCK_RANGE = 10000;
    const latestBlock = await this.provider.getBlockNumber();
    let allEvents = [];

    for (let fromBlock = 0; fromBlock <= latestBlock; fromBlock += MAX_BLOCK_RANGE) {
      const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);
      try {
        const events = await this.contracts.agentRegistryContract.queryFilter('AgentRegistered', fromBlock, toBlock);
        allEvents = allEvents.concat(events);
      } catch (err) {
        console.warn(`[EventListener] Failed to fetch AgentRegistered events from ${fromBlock} to ${toBlock}:`, err.message);
      }
    }

    for (const ev of allEvents) {
      const a = ev.args;
      this.store.setAgent(a.agent, {
        address: a.agent,
        agentId: a.agentId,
        ucpEndpoint: a.ucpEndpoint,
        stakedAmount: a.stakedAmount,
        stakedFormatted: parseGuardAmount(a.stakedAmount),
        source: 'onchain_event',
      });
    }
    return allEvents.length;
  }

  async _syncAgentsFromRegistryViews() {
    if (!this.contracts?.agentRegistryContract) return 0;
    const allAgents = await this.contracts.agentRegistryContract.getAllAgents();
    const agentAddresses = Array.isArray(allAgents) ? allAgents : [];
    let synced = 0;
    for (const address of agentAddresses) {
      try {
        const profile = await this.contracts.agentRegistryContract.getAgent(address);
        const normalizedAddress = String(profile.agentAddress || address);
        this.store.setAgent(normalizedAddress, {
          address: normalizedAddress,
          agentId: profile.agentId,
          ucpEndpoint: profile.ucpEndpoint,
          specializations: Array.isArray(profile.specializations) ? profile.specializations : [],
          tier: Number(profile.tier ?? 0),
          status: this._normalizeAgentStatus(profile.status),
          stakedAmount: profile.stakedAmount ?? 0n,
          stakedFormatted: parseGuardAmount(profile.stakedAmount ?? 0n),
          reputationScore: Number(profile.reputationScore ?? 0),
          completedJobs: Number(profile.completedJobs ?? 0),
          successfulFindings: Number(profile.successfulFindings ?? 0),
          falsePositives: Number(profile.falsePositives ?? 0),
          falseNegatives: Number(profile.falseNegatives ?? 0),
          registeredAt: Number(profile.registeredAt ?? 0),
          lastActiveAt: Number(profile.lastActiveAt ?? 0),
          source: 'onchain_view',
        });
        synced += 1;
      } catch (err) {
        console.warn(`[EventListener] getAgent failed for ${address}:`, err.message || err);
      }
    }
    return synced;
  }

  async _syncHistoricalAgents() {
    if (!this.contracts?.agentRegistryContract) return;
    this._setAgentHydrationHealth('degraded', null);
    console.log('[EventListener] Syncing historical agents...');
    try {
      // Try view function first (fast, reliable, doesn't hit rate limits)
      const viewCount = await this._syncAgentsFromRegistryViews();
      if (viewCount > 0) {
        this._setAgentHydrationHealth('ok', null);
        console.log(`[EventListener] Synced ${viewCount} agents from AgentRegistry views (primary method)`);
        return;
      }
      // Fallback to events if views returned 0 agents
      const eventCount = await this._syncAgentsFromRegistryEvents();
      if (eventCount > 0) {
        this._setAgentHydrationHealth('ok', null);
        console.log(`[EventListener] Synced ${eventCount} agents from events (fallback method)`);
        return;
      }
      this._setAgentHydrationHealth('degraded', 'No agents returned from views or events');
      console.warn('[EventListener] Agent hydration returned zero records');
    } catch (err) {
      const primaryErr = err instanceof Error ? err.message : String(err);
      console.warn(`[EventListener] Agent view hydration failed: ${primaryErr}`);
      try {
        // If views failed, try events as recovery
        const eventCount = await this._syncAgentsFromRegistryEvents();
        if (eventCount > 0) {
          this._setAgentHydrationHealth('ok', null);
          console.log(`[EventListener] Recovered agent hydration via events (${eventCount} agents)`);
          return;
        }
        this._setAgentHydrationHealth('failed', `Hydration failed: ${primaryErr}`);
      } catch (fallbackErr) {
        const eventErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this._setAgentHydrationHealth('failed', `Hydration failed: ${primaryErr}; event fallback failed: ${eventErrMsg}`);
      }
      throw err;
    }
  }

  stopAll() {
    this._intervals.forEach(clearInterval);
    this._intervals = [];
    this._running = false;
    if (EventListenerService._activeService === this) {
      EventListenerService._activeService = null;
    }
    console.log('[EventListener] All polling loops stopped');
  }

  // ── HCS polling ──────────────────────────────────────────

  startHCSPolling() {
    if (!this.config?.hcsTopics) {
      console.warn('[EventListener] No HCS topics in config — skipping event polling');
      return;
    }

    // Discovery topic
    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.discovery, 'discovery');
    }, this.hcsPollMs));

    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.auditLog, 'auditLog');
    }, this.hcsPollMs));

    // AgentComms topic
    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.agentComms, 'agentComms');
    }, this.hcsPollMs));
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
      this.hcsEventsSeen += messages.length;
      const activeAuctionsCount = Object.values(this.store.activeJobs || {}).filter(
        (job) => !job?.terminalStatus
      ).length;
      this.store.setIngestionHealth?.({
        hcsEventsSeen: this.hcsEventsSeen,
        activeAuctionsCount,
      });
    } catch (err) {
      console.warn('[EventListener] Events API poll error:', err.message);
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

  _mkHcsEventId(topicId, sequenceNumber) {
    return `hcs:${topicId}:${sequenceNumber}`;
  }

  _mkContractEventId(ev, suffix = 0) {
    return `evm:${ev.transactionHash}:${Number(ev.logIndex ?? ev.index ?? 0)}:${suffix}`;
  }

  _mkFlowId(ev, suffix = 0) {
    return `flow:${ev.transactionHash}:${Number(ev.logIndex ?? ev.index ?? 0)}:${suffix}`;
  }

  _addLogEntry(entry, eventId = null) {
    if (eventId && this.store.upsertEvent) {
      const inserted = this.store.upsertEvent({ ...entry, eventId });
      if (inserted !== false) return;
    }
    this.store.addLogEntry?.(entry);
  }

  _addGuardFlow(flow) {
    const inserted = this.store.upsertGuardFlow?.(flow);
    if (inserted === false) return;
    if (!this.store.upsertGuardFlow) {
      this.store.addGuardFlow?.(flow);
    }
  }

  /** Route a parsed HCS message to the right store action. */
  _routeHCSMessage(topicKey, msg) {
    const { parsedData, timestamp, sequenceNumber } = msg;
    const topicId = this.config?.hcsTopics?.[topicKey] || topicKey;
    const payload = parsedData?.payload && typeof parsedData.payload === "object"
      ? parsedData.payload
      : {};
    const eventId = this._mkHcsEventId(topicId, sequenceNumber);
    const strictOnchain = this.sourceMode === 'onchain_strict';
    const entry = {
      ...payload,
      ...parsedData,
      _hcsTimestamp:  timestamp,
      _hcsSequence:   sequenceNumber,
      _hcsTopic:      topicId,
    };

    if (topicKey === 'discovery') {
      const normalizedRiskScore = Number(
        payload.initialRiskScore
        ?? payload.riskScore
        ?? entry.initialRiskScore
        ?? entry.riskScore
        ?? 0
      );
      const normalizedLineCount = Number(
        payload.estimatedLineCount
        ?? payload.estimatedLOC
        ?? entry.estimatedLineCount
        ?? entry.estimatedLOC
        ?? 0
      );
      const classifierMetadata =
        (payload.classifier && typeof payload.classifier === "object")
          ? payload.classifier
          : (
            payload.riskSource != null ||
            payload.riskModel != null ||
            payload.topRiskFactors != null ||
            payload.evmType != null ||
            payload.isProxy != null
          )
            ? {
              riskSource: payload.riskSource ?? null,
              riskModel: payload.riskModel ?? null,
              topRiskFactors: Array.isArray(payload.topRiskFactors) ? payload.topRiskFactors : [],
              evmType: payload.evmType ?? null,
              isProxy: payload.isProxy ?? null,
              contractName: payload.contractName ?? null,
              standards: Array.isArray(payload.standards) ? payload.standards : [],
              sourceOrigin: payload.sourceOrigin ?? null,
            }
            : null;
      const normalizedDiscovery = {
        ...entry,
        riskScore: Number.isFinite(normalizedRiskScore) ? normalizedRiskScore : 0,
        initialRiskScore: Number.isFinite(normalizedRiskScore) ? normalizedRiskScore : 0,
        estimatedLOC: Number.isFinite(normalizedLineCount) ? normalizedLineCount : 0,
        estimatedLineCount: Number.isFinite(normalizedLineCount) ? normalizedLineCount : 0,
        classifier: classifierMetadata,
      };

      if (this.onlyTestDiscoveries) {
        const contractAddress = String(normalizedDiscovery.contractAddress ?? payload.contractAddress ?? '').toLowerCase();
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

      this.store.addDiscovery(normalizedDiscovery);
      this.store.incrementStat('totalDiscoveries');
      this._addLogEntry({ ...normalizedDiscovery, source: 'discovery' }, eventId);
      return;
    }

    if (topicKey !== 'auditLog' && topicKey !== 'agentComms') return;

    const source = topicKey === 'auditLog' ? 'auditLog' : 'agentComms';
    let displayEntry = entry;
    let skipDisplayEntry = false;
    if (parsedData.type === 'BID_SUBMITTED') {
      const agentName = payload.agentId ?? 'unknown';
      const bidAmount = parseDisplayBidAmount(payload.bidAmount);
      if (!bidAmount) {
        this._addLogEntry({
          ...entry,
          type: 'BID_SUBMITTED_MALFORMED',
          reason: 'Malformed BID_SUBMITTED payload (missing/invalid bidAmount)',
          source,
        }, `${eventId}:malformed_bid`);
        skipDisplayEntry = true;
      }
      displayEntry = {
        ...entry,
        type: 'BidSubmitted',
        agentName,
        bidFormatted: bidAmount?.formatted ?? null,
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
      const reasonCode = typeof payload.reasonCode === 'string' ? payload.reasonCode : null;
      const normalizedType = isPayerFundingFailureReason(reasonCode)
        ? 'BID_SKIPPED'
        : 'BID_SUBMISSION_FAILED';
      displayEntry = {
        ...entry,
        type: normalizedType,
        jobId: String(payload.jobId ?? payload.contractAddress ?? sequenceNumber),
        reason: normalizeBidFailureReason(payload),
      };
    } else if (isWinnerSelectedType(parsedData.type)) {
      const winnerAgents = Array.isArray(payload.winners)
        ? payload.winners
          .map((winner) => String(winner))
          .filter((winner) => winner.length > 0)
        : [];
      if (winnerAgents.length === 0) {
        skipDisplayEntry = true;
      }
      displayEntry = {
        ...entry,
        type: 'WINNER_SELECTED',
        jobId: String(payload.jobId ?? sequenceNumber),
        winnerCount: winnerAgents.length,
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

    if (!(topicKey === 'auditLog' && parsedData.type === 'REPORT_METADATA') && !skipDisplayEntry) {
      this._addLogEntry({ ...displayEntry, source }, eventId);
    }

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
      this._addLogEntry({
        type: 'REPORT_PUBLISHED',
        jobId,
        timestamp: Math.floor(Date.now() / 1000),
        data: { cid: payload.cid, findingCount: payload.findingCount },
        source: 'auditLog',
      }, `${eventId}:report`);
      return;
    }

    if (parsedData.type === 'JOB_CREATED' && !strictOnchain) {
      const contractAddress = String(payload.contractAddress ?? '').toLowerCase();
      if (
        this.onlyTestDiscoveries &&
        this.allowedDiscoveryContracts.size > 0 &&
        !this.allowedDiscoveryContracts.has(contractAddress)
      ) {
        return;
      }

      const jobId = String(payload.jobId ?? sequenceNumber);
      const classifierMetadata =
        (payload.classifier && typeof payload.classifier === "object")
          ? payload.classifier
          : (
            payload.riskSource != null ||
            payload.riskModel != null ||
            payload.topRiskFactors != null ||
            payload.evmType != null ||
            payload.isProxy != null
          )
            ? {
              riskSource: payload.riskSource ?? null,
              riskModel: payload.riskModel ?? null,
              topRiskFactors: Array.isArray(payload.topRiskFactors) ? payload.topRiskFactors : [],
              evmType: payload.evmType ?? null,
              isProxy: payload.isProxy ?? null,
              contractName: payload.contractName ?? null,
              standards: Array.isArray(payload.standards) ? payload.standards : [],
              sourceOrigin: payload.sourceOrigin ?? null,
            }
            : null;
      this.store.setJob(jobId, {
        jobId,
        contractAddress: payload.contractAddress,
        contractChain: payload.chain ?? 'hedera',
        contractType: normalizeAuctionType(payload.contractType),
        budgetAvailable: payload.budget ?? 0,
        budgetFormatted: parseGuardAmount(payload.budget ?? 0),
        initialRiskScore: Number(payload.riskScore ?? 0),
        lineCount: Number(payload.estimatedLOC ?? payload.estimatedLineCount ?? 0),
        classifier: classifierMetadata,
        postedAt: Date.now(),
      });
      this.store.incrementStat('totalAuctions');
      return;
    }

    if (parsedData.type === 'BID_SUBMITTED') {
      const bidAmount = parseDisplayBidAmount(payload.bidAmount);
      if (!bidAmount) return;
      const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
      if (!strictOnchain) {
        this.store.addBid(jobId, {
          agent: payload.evmAddress ?? payload.agentAddress ?? payload.agentId,
          agentName: payload.agentId ?? 'unknown',
          bidAmount: bidAmount.value,
          bidFormatted: bidAmount.formatted,
          collateralLocked: payload.collateral ?? 0,
          reputationAtBid: Number(payload.reputation ?? 0),
          specialization: payload.specialization ?? 'unknown',
          estimatedCompletionTime: Number(payload.estimatedTimeSec ?? 0),
          timestamp: parsedData.timestamp ?? Date.now(),
        });
        this.store.incrementStat('totalBids');
      }
      this.store.addJobBidStatus?.(jobId, {
        status: 'submitted',
        agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
        evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
        reason: null,
        timestamp: parsedData.timestamp ?? Date.now(),
        eventId,
      });
      return;
    }

    if (parsedData.type === 'BID_SKIPPED') {
      const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
      this.store.addJobBidStatus?.(jobId, {
        status: 'skipped',
        agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
        evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
        reason: payload.reason ?? payload.reasonCode ?? 'Bid skipped',
        timestamp: parsedData.timestamp ?? Date.now(),
        eventId,
      });
      return;
    }

    if (parsedData.type === 'BID_SUBMISSION_FAILED') {
      const jobId = String(payload.jobId ?? payload.contractAddress ?? sequenceNumber);
      const reasonCode = typeof payload.reasonCode === 'string' ? payload.reasonCode : null;
      const status = isPayerFundingFailureReason(reasonCode) ? 'skipped' : 'failed';
      this.store.addJobBidStatus?.(jobId, {
        status,
        agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
        evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
        reason: normalizeBidFailureReason(payload),
        timestamp: parsedData.timestamp ?? Date.now(),
        eventId,
      });
      return;
    }

    if (isWinnerSelectedType(parsedData.type)) {
      const jobId = String(payload.jobId ?? sequenceNumber);
      const winnerAgents = Array.isArray(payload.winners)
        ? payload.winners
          .map((winner) => String(winner))
          .filter((winner) => winner.length > 0)
        : [];
      // Guard gate: ignore malformed winner payloads and preserve authoritative contract winners.
      if (winnerAgents.length === 0) return;
      const existingWinnerData = this.store.winners?.[jobId];
      if (
        existingWinnerData?.source === 'contract' &&
        Array.isArray(existingWinnerData?.agents) &&
        existingWinnerData.agents.length > 0
      ) {
        return;
      }
      const totalEscrowed = normalizeGuardRaw(payload.totalEscrowed);
      const platformFee = normalizeGuardRaw(payload.platformFee);

      this.store.setWinners?.(jobId, {
        agents: winnerAgents,
        totalEscrowed: totalEscrowed.raw,
        totalEscrowedFormatted: totalEscrowed.formatted,
        platformFee: platformFee.raw,
        platformFeeFormatted: platformFee.formatted,
        winnersAt: existingWinnerData?.winnersAt ?? (timestamp ?? Date.now()),
        source: 'auditLog',
      });
      return;
    }

    if (parsedData.type === 'AUCTION_INVITE_SUMMARY') {
      const jobId = String(payload.jobId ?? sequenceNumber);
      const invites = Array.isArray(payload.eligibleAgents) ? payload.eligibleAgents : [];
      for (const invite of invites) {
        this.store.addJobBidStatus?.(jobId, {
          status: 'invite_sent',
          agentId: invite?.agentId ?? 'unknown',
          evmAddress: invite?.evmAddress ?? null,
          reason: null,
          timestamp: parsedData.timestamp ?? Date.now(),
          eventId: `${eventId}:summary:${invite?.agentId ?? 'unknown'}`,
        });
      }
      return;
    }

    if (topicKey === 'agentComms' && parsedData.type === 'AUCTION_INVITE') {
      const jobId = String(payload.jobId ?? sequenceNumber);
      const existing = this.store.activeJobs?.[jobId];
      if (existing && payload.classifierHints && typeof payload.classifierHints === 'object') {
        this.store.setJob?.(jobId, {
          ...existing,
          jobId,
          contractAddress: existing.contractAddress ?? payload.contractAddress,
          classifier: {
            ...(existing.classifier || {}),
            ...payload.classifierHints,
          },
        });
      }
      const targetedIds = Array.isArray(payload.eligibleAgentIds)
        ? payload.eligibleAgentIds.map((value) => String(value))
        : [];
      const targetedAddresses = Array.isArray(payload.eligibleEvmAddresses)
        ? payload.eligibleEvmAddresses.map((value) => String(value))
        : [];
      if (targetedIds.length > 0 || targetedAddresses.length > 0) {
        targetedIds.forEach((agentId, idx) => {
          this.store.addJobBidStatus?.(jobId, {
            status: 'invite_sent',
            agentId,
            evmAddress: targetedAddresses[idx] ?? null,
            reason: null,
            timestamp: parsedData.timestamp ?? Date.now(),
            eventId: `${eventId}:invite:${agentId}`,
          });
        });
      } else {
        this.store.addJobBidStatus?.(jobId, {
          status: 'invite_sent',
          agentId: parsedData.agentId ?? payload.agentId ?? 'unknown',
          evmAddress: payload.evmAddress ?? payload.agentAddress ?? null,
          reason: null,
          timestamp: parsedData.timestamp ?? Date.now(),
          eventId,
        });
      }
      return;
    }

    if (parsedData.type === 'AGENT_REGISTERED' && !strictOnchain) {
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
      return;
    }

    if (parsedData.type === 'LLM_PROVIDER_READY') {
      this.store.setLlmProviderStatus?.(parsedData.agentId ?? 'llm-contextual-003', {
        status: 'ready',
        providerAddress: payload.providerAddress ?? null,
        model: payload.model ?? null,
        endpoint: payload.endpoint ?? null,
        reason: null,
        reasonCode: null,
        timestamp: parsedData.timestamp ?? Date.now(),
      });
      return;
    }

    if (parsedData.type === 'LLM_PROVIDER_UNHEALTHY') {
      this.store.setLlmProviderStatus?.(parsedData.agentId ?? 'llm-contextual-003', {
        status: 'unhealthy',
        providerAddress: payload.providerAddress ?? null,
        model: payload.model ?? null,
        endpoint: payload.endpoint ?? null,
        reason: payload.reason ?? null,
        reasonCode: payload.reasonCode ?? null,
        timestamp: parsedData.timestamp ?? Date.now(),
      });
      return;
    }

    if (parsedData.type === 'LLM_INFERENCE_STARTED') {
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
      return;
    }

    if (parsedData.type === 'LLM_INFERENCE_SUCCEEDED') {
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
      return;
    }

    if (parsedData.type === 'LLM_INFERENCE_FAILED') {
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
  }

  // ── Contract event polling ───────────────────────────────

  startContractEventPolling() {
    if (!this.provider || !this.contracts) {
      console.warn('[EventListener] No provider/contracts — skipping contract polling');
      return;
    }

    this._intervals.push(setInterval(() => {
      this._pollContractEvents();
    }, this.contractPollMs));
    this._pollContractEvents();
  }

  async _pollContractEvents() {
    if (this._contractPollInFlight) return;
    this._contractPollInFlight = true;
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (this.lastProcessedBlock === null) {
        // Strict mode starts from the current block to avoid replaying stale auctions.
        const backfillBlocks = this.sourceMode === 'onchain_strict' ? 0 : 100;
        this.lastProcessedBlock = this.onlyTestDiscoveries
          ? currentBlock
          : Math.max(0, currentBlock - backfillBlocks);
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

      // Helper: safely query a contract that may not be deployed yet.
      // Guard gate: do not advance block cursor when core auction queries fail.
      const criticalQueryFailures = [];
      const q = async (contract, event, options = {}) => {
        const { critical = false } = options;
        if (!contract) return [];
        try {
          return await contract.queryFilter(event, from, to);
        } catch (err) {
          if (critical) {
            criticalQueryFailures.push({
              event,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return [];
        }
      };

      const [
        jobPosted, bidSubmitted, winnersSelected, bidRefunded, jobCancelled, jobCompleted,
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
        q(auctionContract, 'JobPosted', { critical: true }),
        q(auctionContract, 'BidSubmitted', { critical: true }),
        q(auctionContract, 'WinnersSelected', { critical: true }),
        q(auctionContract, 'BidRefunded', { critical: true }),
        q(auctionContract, 'JobCancelled', { critical: true }),
        q(auctionContract, 'JobCompleted', { critical: true }),
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

      if (criticalQueryFailures.length > 0) {
        const failedEvents = criticalQueryFailures.map((failure) => failure.event).join(', ');
        console.warn(
          `[EventListener] Contract poll incomplete (${from}-${to}); critical queries failed: ${failedEvents}. Retrying without advancing cursor.`
        );
        this.store.setIngestionHealth?.({
          contractPollError: `critical_query_failed:${failedEvents}`,
          contractPollErrorAt: Date.now(),
        });
        return;
      }

      const polledEventCount = [
        jobPosted, bidSubmitted, winnersSelected, bidRefunded, jobCancelled, jobCompleted,
        agentRegistered, reputationUpdated, agentPromoted,
        subAuctionCreated, subBidSubmitted, subContractorSelected,
        resultDelivered, resultAccepted,
        dataListed, dataPurchased, dataRated,
        jobSettled, subJobSettled,
        vaultCreated, autoAuditTriggered,
        staked, stakeLocked, stakeUnlocked,
        slashInitiated, appealFiled, appealApproved, appealDenied,
        feeReceived, feeDistributed,
      ].reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
      this.contractEventsSeen += polledEventCount;

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
          contractType: normalizeAuctionType(a.contractType),
          budgetAvailable: a.budgetAvailable,
          budgetFormatted: parseGuardAmount(a.budgetAvailable),
          auctionDeadline: a.auctionDeadline,
          initialRiskScore: Number(a.initialRiskScore),
          lineCount: Number(a.lineCount),
          postedAt: Date.now(),
          updatedAt: Date.now(),
          blockNumber: ev.blockNumber,
        });
        this.store.incrementStat('totalAuctions');
        this._addLogEntry({
          type: 'JobPosted',
          source: 'contract',
          jobId: a.jobId.toString(),
          contractAddress: a.contractAddress,
          budgetFormatted: parseGuardAmount(a.budgetAvailable),
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
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
        this._addGuardFlow({
          flowId: this._mkFlowId(ev, 0),
          source: 'contract_event',
          from: a.agent,
          fromName: bid.agentName,
          to: this.contracts?.auctionContract?.target || 'auction',
          toName: 'Audit Auction',
          amount: a.collateralLocked,
          amountFormatted: parseGuardAmount(a.collateralLocked),
          type: 'BID_COLLATERAL_LOCK',
          jobId: a.jobId.toString(),
          txHash: ev.transactionHash,
          logIndex: Number(ev.logIndex ?? ev.index ?? 0),
          blockNumber: ev.blockNumber,
          timestamp: Date.now(),
        });
        this._addLogEntry({
          type: 'BidSubmitted',
          source: 'contract',
          jobId: a.jobId.toString(),
          agentName: bid.agentName,
          bidFormatted: bid.bidFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of winnersSelected) {
        const a = ev.args;
        const jobId = a.jobId.toString();
        const existingWinnerData = this.store.winners?.[jobId];
        this.store.setWinners(jobId, {
          agents: Array.from(a.winners),
          totalEscrowed: a.totalEscrowed,
          totalEscrowedFormatted: parseGuardAmount(a.totalEscrowed),
          platformFee: a.platformFee,
          platformFeeFormatted: parseGuardAmount(a.platformFee),
          winnersAt: existingWinnerData?.winnersAt ?? Date.now(),
          source: 'contract',
        });
        if ((a.platformFee ?? 0n) > 0n) {
          this._addGuardFlow({
            flowId: this._mkFlowId(ev, 0),
            source: 'contract_event',
            from: this.contracts?.auctionContract?.target || 'auction',
            fromLabel: 'Audit Auction',
            to: resolveTreasuryAddress(this.config),
            toName: 'Treasury',
            amount: a.platformFee,
            amountFormatted: parseGuardAmount(a.platformFee),
            type: 'PLATFORM_FEE',
            jobId: a.jobId.toString(),
            txHash: ev.transactionHash,
            logIndex: Number(ev.logIndex ?? ev.index ?? 0),
            blockNumber: ev.blockNumber,
            timestamp: Date.now(),
          });
        }
        this._addLogEntry({
          type: 'WinnersSelected',
          source: 'contract',
          jobId: a.jobId.toString(),
          winnerCount: a.winners.length,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of bidRefunded) {
        const a = ev.args;
        this._addGuardFlow({
          flowId: this._mkFlowId(ev, 0),
          source: 'contract_event',
          from: this.contracts?.auctionContract?.target || 'auction',
          fromName: 'Audit Auction',
          to: a.agent,
          toName: resolveAgentName(a.agent, this.config),
          amount: a.refundedCollateral,
          amountFormatted: parseGuardAmount(a.refundedCollateral),
          type: 'BID_COLLATERAL_REFUND',
          jobId: a.jobId.toString(),
          txHash: ev.transactionHash,
          logIndex: Number(ev.logIndex ?? ev.index ?? 0),
          blockNumber: ev.blockNumber,
          timestamp: Date.now(),
        });
        this._addLogEntry({
          type: 'BidRefunded',
          source: 'contract',
          jobId: a.jobId.toString(),
          agent: a.agent,
          agentName: resolveAgentName(a.agent, this.config),
          refunded: parseGuardAmount(a.refundedCollateral),
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of jobCancelled) {
        const a = ev.args;
        const jobId = a.jobId.toString();
        this.store.setJobTerminal?.(jobId, {
          status: 'cancelled',
          endedAt: Date.now(),
          txHash: ev.transactionHash,
          source: 'contract',
        });
        this._addLogEntry({
          type: 'JobCancelled',
          source: 'contract',
          jobId,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of jobCompleted) {
        const a = ev.args;
        const jobId = a.jobId.toString();
        this.store.setJobTerminal?.(jobId, {
          status: 'completed',
          endedAt: Date.now(),
          txHash: ev.transactionHash,
          source: 'contract',
        });
        this._addLogEntry({
          type: 'JobCompleted',
          source: 'contract',
          jobId,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
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
          this._addGuardFlow({
            flowId: this._mkFlowId(ev, 0),
            source: 'contract_event',
            from: subJob.requester,
            to: subJob.selectedAgent,
            toName: subJob.selectedAgentName,
            amount: a.paymentAmount,
            amountFormatted: parseGuardAmount(a.paymentAmount),
            type: 'SUB_CONTRACT',
            jobId: subJob.parentJobId,
            txHash: ev.transactionHash,
            logIndex: Number(ev.logIndex ?? ev.index ?? 0),
            blockNumber: ev.blockNumber,
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
        this._addLogEntry({
          type: 'DATA_LISTED',
          source: 'contract',
          listingId,
          parentJobId,
          sellerName: resolveAgentName(a.seller, this.config),
          title: a.title,
          priceFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of dataPurchased) {
        const a = ev.args;
        const listingId = a.listingId.toString();
        const pricePaidFormatted = parseGuardAmount(a.pricePaid);
        const sellerNet = a.pricePaid > a.platformFee ? a.pricePaid - a.platformFee : 0n;
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
        if (sellerNet > 0n) {
          this._addGuardFlow({
            flowId: this._mkFlowId(ev, 0),
            source: 'contract_event',
            from: a.buyer,
            fromName: resolveAgentName(a.buyer, this.config),
            to: a.seller,
            toName: resolveAgentName(a.seller, this.config),
            amount: sellerNet,
            amountFormatted: parseGuardAmount(sellerNet),
            type: 'DATA_PURCHASE_NET',
            listingId,
            txHash: ev.transactionHash,
            logIndex: Number(ev.logIndex ?? ev.index ?? 0),
            blockNumber: ev.blockNumber,
            timestamp: Date.now(),
          });
        }
        if (a.platformFee > 0n) {
          this._addGuardFlow({
            flowId: this._mkFlowId(ev, 1),
            source: 'contract_event',
            from: a.buyer,
            fromName: resolveAgentName(a.buyer, this.config),
            to: resolveTreasuryAddress(this.config),
            toName: 'Treasury',
            amount: a.platformFee,
            amountFormatted: parseGuardAmount(a.platformFee),
            type: 'PLATFORM_FEE',
            listingId,
            txHash: ev.transactionHash,
            logIndex: Number(ev.logIndex ?? ev.index ?? 0),
            blockNumber: ev.blockNumber,
            timestamp: Date.now(),
          });
        }
        this.store.incrementStat('totalDataSales');
        this._addLogEntry({
          type: 'DATA_PURCHASED',
          source: 'contract',
          listingId,
          buyerName: purchase.buyerName,
          sellerName: purchase.sellerName,
          pricePaidFormatted,
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
      }

      for (const ev of dataRated) {
        const a = ev.args;
        const listingId = a.listingId.toString();
        const rating = Number(a.rating);
        this.store.updateDataPurchaseRating(listingId, a.buyer, rating);
        this._addLogEntry({
          type: 'DATA_RATED',
          source: 'contract',
          listingId,
          buyerName: resolveAgentName(a.buyer, this.config),
          rating,
          timestamp: Date.now(),
        }, this._mkContractEventId(ev));
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
        this._addLogEntry({
          type: 'JOB_SETTLED',
          source: 'contract',
          settlementId,
          jobId,
          totalDisbursedFormatted,
          recipientCount: Number(a.recipientCount),
          timestamp: Date.now(),
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
        // Fetch per-recipient breakdown and emit individual GUARD flows
        if (paymentSettlementContract) {
          try {
            const payments = await paymentSettlementContract.getSettlementPayments(a.settlementId);
            if (this.pendingSettlementBreakdowns > 0) {
              this.pendingSettlementBreakdowns -= 1;
            }
            this.store.setIngestionHealth?.({
              pendingSettlementBreakdowns: this.pendingSettlementBreakdowns,
            });
            const treasuryAddress = resolveTreasuryAddress(this.config);
            let paymentIndex = 0;
            for (const payment of payments) {
              const base = payment.basePayment ?? 0n;
              const bonus = payment.bonus ?? 0n;
              const reportFee = payment.reportFee ?? 0n;
              const gross = base + bonus;
              const net = gross > reportFee ? gross - reportFee : 0n;
              const flowType = resolveSettlementFlowType(payment.paymentType, payment.description);
              if (net > 0n) {
                this._addGuardFlow({
                  flowId: this._mkFlowId(ev, paymentIndex),
                  source: 'contract_event',
                  from: 'vault',
                  to: payment.recipient,
                  toName: resolveAgentName(payment.recipient, this.config),
                  amount: net,
                  amountFormatted: parseGuardAmount(net),
                  type: flowType,
                  jobId,
                  settlementId,
                  txHash: ev.transactionHash,
                  logIndex: Number(ev.logIndex ?? ev.index ?? 0),
                  blockNumber: ev.blockNumber,
                  timestamp: Date.now(),
                });
              }
              if (reportFee > 0n) {
                this._addGuardFlow({
                  flowId: this._mkFlowId(ev, paymentIndex + 5000),
                  source: 'contract_event',
                  from: 'vault',
                  to: treasuryAddress,
                  toName: 'Treasury',
                  amount: reportFee,
                  amountFormatted: parseGuardAmount(reportFee),
                  type: 'REPORT_FEE',
                  jobId,
                  settlementId,
                  txHash: ev.transactionHash,
                  logIndex: Number(ev.logIndex ?? ev.index ?? 0),
                  blockNumber: ev.blockNumber,
                  timestamp: Date.now(),
                });
              }
              paymentIndex += 1;
            }
            if ((a.platformFee ?? 0n) > 0n) {
              this._addGuardFlow({
                flowId: this._mkFlowId(ev, 9999),
                source: 'contract_event',
                from: 'vault',
                to: treasuryAddress,
                toName: 'Treasury',
                amount: a.platformFee,
                amountFormatted: parseGuardAmount(a.platformFee),
                type: 'PLATFORM_FEE',
                jobId,
                settlementId,
                txHash: ev.transactionHash,
                logIndex: Number(ev.logIndex ?? ev.index ?? 0),
                blockNumber: ev.blockNumber,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            this.pendingSettlementBreakdowns += 1;
            this.store.setIngestionHealth?.({
              pendingSettlementBreakdowns: this.pendingSettlementBreakdowns,
            });
            console.warn('[EventListener] Could not fetch settlement payments:', err.message);
          }
        }
      }

      for (const ev of subJobSettled) {
        const a = ev.args;
        this._addLogEntry({
          type: 'SUB_JOB_SETTLED',
          source: 'contract',
          settlementId: a.settlementId.toString(),
          subJobId: a.subJobId.toString(),
          agentName: resolveAgentName(a.agent, this.config),
          amountFormatted: parseGuardAmount(a.amount),
          timestamp: Date.now(),
        }, this._mkContractEventId(ev));
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
        if ((a.slashedAmount ?? 0n) > 0n) {
          this._addGuardFlow({
            flowId: this._mkFlowId(ev, 0),
            source: 'contract_event',
            from: a.agent,
            fromName: resolveAgentName(a.agent, this.config),
            to: resolveTreasuryAddress(this.config),
            toName: 'Treasury',
            amount: a.slashedAmount,
            amountFormatted: parseGuardAmount(a.slashedAmount),
            type: 'SLASH_TO_TREASURY',
            jobId: a.jobId.toString(),
            txHash: ev.transactionHash,
            logIndex: Number(ev.logIndex ?? ev.index ?? 0),
            blockNumber: ev.blockNumber,
            timestamp: Date.now(),
          });
        }
        this._addLogEntry({
          type: 'SLASH_INITIATED',
          source: 'contract',
          ...slash,
          _tx: this._mkTx(ev, blockTs),
        }, this._mkContractEventId(ev));
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
      const activeAuctionsCount = Object.values(this.store.activeJobs || {}).filter(
        (job) => !job?.terminalStatus
      ).length;
      this.store.setIngestionHealth?.({
        lastContractBlock: Number(to),
        contractEventsSeen: this.contractEventsSeen,
        activeAuctionsCount,
        contractPollError: null,
      });
    } catch (err) {
      console.warn('[EventListener] Contract poll error:', err.message);
    } finally {
      this._contractPollInFlight = false;
    }
  }
}

EventListenerService._activeService = null;
