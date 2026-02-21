/**
 * AuditGuard Dashboard — Store Integration Tests
 *
 * Tests the Zustand store state management without rendering React components.
 * Validates that store actions correctly transform state for all event types.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// We test the store factory directly (no React needed)
let useStore;

beforeEach(async () => {
  // Fresh store for each test (dynamic import to avoid module caching)
  const mod = await import('../store/index.js');
  useStore = mod.default;
  useStore.getState().resetAll();
});

describe('Store — Discovery events', () => {
  it('should add a discovery event', () => {
    const discovery = {
      contractAddress: '0xabc123',
      chain: 'hedera-testnet',
      contractType: 'lending',
      riskScore: 85,
      estimatedLOC: 3500,
      timestamp: Date.now(),
    };

    useStore.getState().addDiscovery(discovery);
    const state = useStore.getState();

    expect(state.discoveries).toHaveLength(1);
    expect(state.discoveries[0].contractAddress).toBe('0xabc123');
  });

  it('should cap discoveries at 100', () => {
    for (let i = 0; i < 110; i++) {
      useStore.getState().addDiscovery({ contractAddress: `0x${i}`, timestamp: i });
    }
    expect(useStore.getState().discoveries).toHaveLength(100);
  });
});

describe('Store — Auction jobs and bids', () => {
  it('should set an active job', () => {
    useStore.getState().setJob(1, {
      contractAddress: '0xabc',
      contractType: 'dex',
      status: 'AUCTION_OPEN',
    });

    const jobs = useStore.getState().activeJobs;
    expect(jobs[1]).toBeDefined();
    expect(jobs[1].contractType).toBe('dex');
  });

  it('should add bids to a job', () => {
    useStore.getState().addBid('1', { agentId: 'static-47', amount: 15 });
    useStore.getState().addBid('1', { agentId: 'fuzzer-12', amount: 22 });

    const bids = useStore.getState().bids;
    expect(bids['1']).toHaveLength(2);
    expect(bids['1'][0].agentId).toBe('static-47');
  });

  it('should track bid lifecycle status per job', () => {
    useStore.getState().addJobBidStatus('1', { status: 'invite_sent', agentId: 'static-47' });
    useStore.getState().addJobBidStatus('1', { status: 'skipped', agentId: 'static-47', reason: 'inactive_agent' });

    const lifecycle = useStore.getState().jobBidStatus['1'];
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0].status).toBe('skipped');
  });

  it('should dedupe bid lifecycle rows by eventId/status/agent', () => {
    useStore.getState().addJobBidStatus('1', {
      status: 'invite_sent',
      agentId: 'static-47',
      eventId: 'hcs:0.0.2:77:summary:static-47',
    });
    useStore.getState().addJobBidStatus('1', {
      status: 'invite_sent',
      agentId: 'static-47',
      eventId: 'hcs:0.0.2:77:summary:static-47',
    });

    const lifecycle = useStore.getState().jobBidStatus['1'];
    expect(lifecycle).toHaveLength(1);
  });
});

describe('Store — LLM provider/inference status', () => {
  it('should record LLM provider status entries', () => {
    useStore.getState().setLlmProviderStatus('llm-contextual-003', { status: 'ready', model: 'qwen' });
    useStore.getState().setLlmProviderStatus('llm-contextual-003', { status: 'unhealthy', reasonCode: 'zg_timeout' });

    const entries = useStore.getState().llmProviderStatus['llm-contextual-003'];
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('unhealthy');
  });

  it('should record LLM inference lifecycle per job', () => {
    useStore.getState().addLlmInferenceStatus('7', { status: 'started', model: 'qwen' });
    useStore.getState().addLlmInferenceStatus('7', { status: 'succeeded', findingsCount: 4 });

    const entries = useStore.getState().llmInferenceStatus['7'];
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('succeeded');
  });
});

describe('Store — Agent profiles', () => {
  it('should set an agent profile', () => {
    useStore.getState().setAgent('0xAAA', {
      agentId: 'static-47',
      tier: 1,
      reputationScore: 7500,
      stakedAmount: 100e8,
    });

    const agent = useStore.getState().agents['0xAAA'];
    expect(agent.agentId).toBe('static-47');
    expect(agent.reputationScore).toBe(7500);
  });
});

describe('Store — Audit log entries', () => {
  it('should add audit log entries', () => {
    useStore.getState().addLogEntry({ type: 'BID_SUBMITTED', agentId: 'static-47', timestamp: 1 });
    useStore.getState().addLogEntry({ type: 'WINNER_SELECTED', agentId: 'orchestrator', timestamp: 2 });

    const log = useStore.getState().auditLog;
    expect(log).toHaveLength(2);
    expect(log[0].type).toBe('WINNER_SELECTED');
  });

  it('should cap audit log at 200', () => {
    for (let i = 0; i < 220; i++) {
      useStore.getState().addLogEntry({ type: 'BID_SUBMITTED', timestamp: i });
    }
    expect(useStore.getState().auditLog).toHaveLength(200);
  });
});

describe('Store — Sub-auctions', () => {
  it('should add sub-jobs and link to parent', () => {
    useStore.getState().addSubJob({
      subJobId: 'sub-1',
      parentJobId: 'job-1',
      taskType: 'dependency_analysis',
    });

    expect(useStore.getState().subJobs['sub-1']).toBeDefined();
    expect(useStore.getState().parentSubJobs['job-1']).toContain('sub-1');
  });
});

describe('Store — Data marketplace', () => {
  it('should add data listing and link to job', () => {
    useStore.getState().addDataListing({
      listingId: 'L1',
      parentJobId: 'J1',
      category: 'SCAN_REPORT',
      price: 0.5,
    });

    expect(useStore.getState().dataListings['L1']).toBeDefined();
    expect(useStore.getState().jobListings['J1']).toContain('L1');
  });

  it('should add data purchase', () => {
    useStore.getState().addDataPurchase({
      listingId: 'L1',
      buyer: '0xBBB',
      price: 0.5,
    });

    expect(useStore.getState().dataPurchases).toHaveLength(1);
  });
});

describe('Store — Settlements', () => {
  it('should add settlement record', () => {
    useStore.getState().addSettlement({
      settlementId: 'S1',
      jobId: 'J1',
      total: 30,
      recipients: ['0xAAA', '0xBBB'],
    });

    expect(useStore.getState().settlements['S1']).toBeDefined();
    expect(useStore.getState().jobSettlements['J1']).toBe('S1');
  });
});

describe('Store — Report persistence', () => {
  it('should mark a job as report-persisted', () => {
    useStore.getState().setJob('J9', {
      jobId: 'J9',
      contractAddress: '0xabc',
      contractType: 'lending',
    });
    useStore.getState().setJobReportPersisted('J9', {
      persistedAt: 1700000000000,
      reportHash: '0xreporthash',
    });

    const state = useStore.getState();
    expect(state.jobReportPersisted['J9']).toMatchObject({
      persistedAt: 1700000000000,
      reportHash: '0xreporthash',
    });
    expect(state.activeJobs['J9']).toMatchObject({
      reportPersistedAt: 1700000000000,
      reportPersistedHash: '0xreporthash',
    });
  });
});

describe('Store — GUARD flow tracking', () => {
  it('should add GUARD flow records', () => {
    useStore.getState().addGuardFlow({
      from: '0xAAA', to: '0xBBB', amount: 15, type: 'audit_payment',
    });

    expect(useStore.getState().guardFlows).toHaveLength(1);
    expect(useStore.getState().guardFlows[0].amount).toBe(15);
  });

  it('should dedupe guard flows by flowId with upsertGuardFlow', () => {
    useStore.getState().upsertGuardFlow({
      flowId: 'flow:1',
      from: '0xAAA', to: '0xBBB', amount: 10, type: 'MAIN_AUDIT',
    });
    useStore.getState().upsertGuardFlow({
      flowId: 'flow:1',
      from: '0xAAA', to: '0xBBB', amount: 10, type: 'MAIN_AUDIT',
    });

    expect(useStore.getState().guardFlows).toHaveLength(1);
    expect(useStore.getState().ingestionHealth.duplicatesDropped).toBe(1);
  });
});

describe('Store — Stats', () => {
  it('should increment stats correctly', () => {
    useStore.getState().incrementStat('totalDiscoveries', 1);
    useStore.getState().incrementStat('totalBids', 3);
    useStore.getState().incrementStat('totalGuardTransacted', 100);

    const stats = useStore.getState().stats;
    expect(stats.totalDiscoveries).toBe(1);
    expect(stats.totalBids).toBe(3);
    expect(stats.totalGuardTransacted).toBe(100);
  });
});

describe('Store — Treasury', () => {
  it('should track treasury revenue by source', () => {
    useStore.getState().addTreasuryRevenue(0, 5);
    useStore.getState().addTreasuryRevenue(1, 2);

    const rev = useStore.getState().treasuryRevenue;
    expect(rev.total).toBe(7);
    expect(rev.auditFees).toBe(5);
    expect(rev.marketplaceFees).toBe(2);
  });
});

describe('Store — Reset', () => {
  it('should reset all state', () => {
    useStore.getState().addDiscovery({ contractAddress: '0x1' });
    useStore.getState().incrementStat('totalBids', 5);
    expect(useStore.getState().discoveries).toHaveLength(1);

    useStore.getState().resetAll();

    expect(useStore.getState().discoveries).toHaveLength(0);
    expect(useStore.getState().stats.totalBids).toBe(0);
  });
});

describe('Store — Reputation history', () => {
  it('should append reputation snapshots per agent', () => {
    useStore.getState().addReputationSnapshot('0xAAA', { reputation: 5000, timestamp: 1 });
    useStore.getState().addReputationSnapshot('0xAAA', { reputation: 5200, timestamp: 2 });

    const history = useStore.getState().reputationHistory['0xAAA'];
    expect(history).toHaveLength(2);
    expect(history[1].reputation).toBe(5200);
  });
});

describe('Store — Winners', () => {
  it('should set winner addresses for a job', () => {
    useStore.getState().setWinners('J1', { agents: ['0xAAA', '0xBBB'] });
    expect(useStore.getState().winners['J1']).toEqual({ agents: ['0xAAA', '0xBBB'] });
  });
});

describe('Store — Event dedupe', () => {
  it('should dedupe log entries by eventId with upsertEvent', () => {
    useStore.getState().upsertEvent({ eventId: 'hcs:0.0.1:1', type: 'PING' });
    useStore.getState().upsertEvent({ eventId: 'hcs:0.0.1:1', type: 'PING' });

    expect(useStore.getState().auditLog).toHaveLength(1);
    expect(useStore.getState().ingestionHealth.duplicatesDropped).toBe(1);
  });
});

describe('Store — Ingestion health', () => {
  it('tracks required ingestion health counters and topic cursors', () => {
    const health = useStore.getState().ingestionHealth;
    expect(health.lastTopicSeq).toEqual({ discovery: 0, auditLog: 0, agentComms: 0 });
    expect(health.duplicateDrops).toBe(0);
    expect(health.contractEventsSeen).toBe(0);
    expect(health.hcsEventsSeen).toBe(0);
    expect(health.activeAuctionsCount).toBe(0);
  });

  it('merges lastHcsSeq and lastTopicSeq patches without dropping existing keys', () => {
    useStore.getState().setIngestionHealth({
      lastHcsSeq: { discovery: 9 },
      lastTopicSeq: { discovery: 9 },
      hcsEventsSeen: 10,
    });
    useStore.getState().setIngestionHealth({
      lastHcsSeq: { auditLog: 12 },
      lastTopicSeq: { auditLog: 12 },
      contractEventsSeen: 5,
    });

    const health = useStore.getState().ingestionHealth;
    expect(health.lastHcsSeq).toEqual({ discovery: 9, auditLog: 12, agentComms: 0 });
    expect(health.lastTopicSeq).toEqual({ discovery: 9, auditLog: 12, agentComms: 0 });
    expect(health.hcsEventsSeen).toBe(10);
    expect(health.contractEventsSeen).toBe(5);
  });
});
