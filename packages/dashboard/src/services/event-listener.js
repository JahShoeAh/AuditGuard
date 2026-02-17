/**
 * EventListenerService
 *
 * Unified event ingestion — manages both HCS mirror-node polling
 * and ethers.js contract-event polling, routing everything into
 * the Zustand store.
 */

const MIRROR_NODE = import.meta.env.VITE_HEDERA_MIRROR_NODE
  || 'https://testnet.mirrornode.hedera.com';

const HCS_POLL_MS = 4_000;       // 4 s for HCS topics
const CONTRACT_POLL_MS = 5_000;  // 5 s for on-chain events

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
   *  @param {object} contracts  { agentRegistryContract, auctionContract, budgetVaultContract }
   *  @param {object} store  Zustand store actions (bound via getState)
   *  @param {import('ethers').JsonRpcProvider} provider */
  constructor(config, contracts, store, provider) {
    this.config    = config;
    this.contracts = contracts;
    this.store     = store;
    this.provider  = provider;

    // HCS state — last seen sequence number per topic
    this.lastSeq = {
      discovery:  0,
      auditLog:   0,
      agentComms: 0,
    };

    // Contract event state
    this.lastProcessedBlock = null;

    this._intervals = [];
  }

  // ── public ───────────────────────────────────────────────

  startAll() {
    this.startHCSPolling();
    this.startContractEventPolling();
    console.log('[EventListener] All polling loops started');
    return () => this.stopAll();
  }

  stopAll() {
    this._intervals.forEach(clearInterval);
    this._intervals = [];
    console.log('[EventListener] All polling loops stopped');
  }

  // ── HCS polling ──────────────────────────────────────────

  startHCSPolling() {
    const topics = this.config.hcsTopics;
    if (!topics) {
      console.warn('[EventListener] No HCS topics in config — skipping HCS polling');
      return;
    }

    // Discovery topic
    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.discovery, 'discovery');
    }, HCS_POLL_MS));

    // AuditLog topic
    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.auditLog, 'auditLog');
    }, HCS_POLL_MS));

    // AgentComms topic
    this._intervals.push(setInterval(() => {
      this._pollHCSTopic(topics.agentComms, 'agentComms');
    }, HCS_POLL_MS));
  }

  async _pollHCSTopic(topicId, topicKey) {
    try {
      const messages = await this.fetchHCSMessages(topicId, this.lastSeq[topicKey]);
      if (messages.length === 0) return;

      for (const msg of messages) {
        this.lastSeq[topicKey] = msg.sequenceNumber;
        this._routeHCSMessage(topicKey, msg);
      }
    } catch (err) {
      console.warn(`[EventListener] HCS poll error (${topicKey}):`, err.message);
    }
  }

  /**
   * Fetch new HCS messages from the mirror node REST API.
   * Returns array of { sequenceNumber, timestamp, parsedData }.
   */
  async fetchHCSMessages(topicId, afterSequence) {
    const url = `${MIRROR_NODE}/api/v1/topics/${topicId}/messages`
      + `?order=asc&limit=25&sequencenumber=gt:${afterSequence}`;

    const res = await fetch(url);
    if (!res.ok) {
      // 404 is normal for topics with no messages yet
      if (res.status === 404) return [];
      throw new Error(`Mirror node responded ${res.status}`);
    }

    const json = await res.json();
    const items = json.messages || [];

    return items.map((m) => {
      let parsedData = {};
      try {
        const decoded = atob(m.message);
        parsedData = JSON.parse(decoded);
      } catch {
        parsedData = { raw: m.message };
      }
      return {
        sequenceNumber: m.sequence_number,
        timestamp: m.consensus_timestamp,
        parsedData,
      };
    });
  }

  /** Route a parsed HCS message to the right store action. */
  _routeHCSMessage(topicKey, msg) {
    const { parsedData, timestamp } = msg;
    const entry = { ...parsedData, _hcsTimestamp: timestamp };

    if (topicKey === 'discovery') {
      this.store.addDiscovery(entry);
      this.store.incrementStat('totalDiscoveries');
      this.store.addLogEntry({ ...entry, source: 'discovery' });
    } else if (topicKey === 'auditLog') {
      this.store.addLogEntry({ ...entry, source: 'auditLog' });
      // Also update specific slices based on type
      if (parsedData.type === 'JOB_CREATED') {
        this.store.incrementStat('totalAuctions');
      } else if (parsedData.type === 'BID_SUBMITTED') {
        this.store.incrementStat('totalBids');
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
        // Catch the last ~100 blocks of history on first run
        this.lastProcessedBlock = Math.max(0, currentBlock - 100);
      }

      if (currentBlock <= this.lastProcessedBlock) return; // no new blocks

      const from = this.lastProcessedBlock + 1;
      const to   = currentBlock;

      // Run all queries in parallel
      const { auctionContract, agentRegistryContract } = this.contracts;

      const [
        jobPosted, bidSubmitted, winnersSelected, bidRefunded,
        agentRegistered, reputationUpdated, agentPromoted,
      ] = await Promise.all([
        auctionContract.queryFilter('JobPosted', from, to).catch(() => []),
        auctionContract.queryFilter('BidSubmitted', from, to).catch(() => []),
        auctionContract.queryFilter('WinnersSelected', from, to).catch(() => []),
        auctionContract.queryFilter('BidRefunded', from, to).catch(() => []),
        agentRegistryContract.queryFilter('AgentRegistered', from, to).catch(() => []),
        agentRegistryContract.queryFilter('ReputationUpdated', from, to).catch(() => []),
        agentRegistryContract.queryFilter('AgentPromoted', from, to).catch(() => []),
      ]);

      // ── Process AuditAuction events ──

      for (const ev of jobPosted) {
        const a = ev.args;
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

      this.lastProcessedBlock = to;
    } catch (err) {
      console.warn('[EventListener] Contract poll error:', err.message);
    }
  }
}
