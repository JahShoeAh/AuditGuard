import { create } from 'zustand';

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDiscovery(discovery) {
  const riskScore = toFiniteNumber(
    discovery?.initialRiskScore ?? discovery?.riskScore ?? 0,
    0
  );
  const estimatedLOC = toFiniteNumber(
    discovery?.estimatedLineCount ?? discovery?.estimatedLOC ?? 0,
    0
  );
  return {
    ...discovery,
    riskScore,
    initialRiskScore: riskScore,
    estimatedLOC,
    estimatedLineCount: estimatedLOC,
  };
}

const useStore = create((set) => ({
  // ── Connection state ─────────────────────────────────────
  isConnected: false,
  connectionError: null,
  config: null,
  contracts: null,
  hederaClient: null,
  ethersProvider: null,

  setConnected: (config, contracts, hederaClient, ethersProvider) =>
    set({ isConnected: true, connectionError: null, config, contracts, hederaClient, ethersProvider }),
  setConnectionError: (error) =>
    set({ isConnected: false, connectionError: error }),

  // Mock events toggle
  useMockEvents: false,
  toggleMockEvents: () => set((s) => ({ useMockEvents: !s.useMockEvents })),

  // ── Contract discoveries (from HCS Discovery topic) ──────
  discoveries: [],
  discoveriesByAddress: {},
  addDiscovery: (d) =>
    set((s) => {
      const normalized = normalizeDiscovery(d);
      const nextDiscoveries = [normalized, ...s.discoveries].slice(0, 100);
      const addressKey = String(normalized?.contractAddress || "").toLowerCase();
      return {
        discoveries: nextDiscoveries,
        discoveriesByAddress: addressKey
          ? { ...s.discoveriesByAddress, [addressKey]: normalized }
          : s.discoveriesByAddress,
      };
    }),

  // ── Auction jobs (from AuditAuction.JobPosted events) ────
  activeJobs: {},
  setJob: (id, job) =>
    set((s) => ({ activeJobs: { ...s.activeJobs, [id]: job } })),
  jobTerminal: {},
  setJobTerminal: (jobId, terminal) =>
    set((s) => {
      const key = String(jobId);
      const existingJob = s.activeJobs[key];
      return {
        jobTerminal: { ...s.jobTerminal, [key]: terminal },
        activeJobs: existingJob
          ? {
            ...s.activeJobs,
            [key]: {
              ...existingJob,
              terminalStatus: terminal?.status ?? existingJob.terminalStatus ?? null,
              endedAt: terminal?.endedAt ?? existingJob.endedAt ?? null,
              terminalTxHash: terminal?.txHash ?? existingJob.terminalTxHash ?? null,
            },
          }
          : s.activeJobs,
      };
    }),

  // ── Bids (from AuditAuction.BidSubmitted events) ─────────
  bids: {},
  addBid: (jobId, bid) =>
    set((s) => ({
      bids: { ...s.bids, [jobId]: [...(s.bids[jobId] || []), bid] },
    })),

  // ── Bid lifecycle visibility (from HCS audit log) ────────
  jobBidStatus: {},
  addJobBidStatus: (jobId, status) =>
    set((s) => {
      const key = String(jobId);
      const existing = s.jobBidStatus[key] || [];
      if (status?.eventId) {
        const duplicate = existing.some((item) =>
          item?.eventId === status.eventId &&
          item?.status === status.status &&
          item?.agentId === status.agentId
        );
        if (duplicate) return s;
      }
      return {
        jobBidStatus: {
          ...s.jobBidStatus,
          [key]: [status, ...existing].slice(0, 100),
        },
      };
    }),

  // ── LLM provider + inference lifecycle ───────────────────
  llmProviderStatus: {},
  setLlmProviderStatus: (agentId, status) =>
    set((s) => ({
      llmProviderStatus: {
        ...s.llmProviderStatus,
        [agentId]: [status, ...(s.llmProviderStatus[agentId] || [])].slice(0, 100),
      },
    })),
  llmInferenceStatus: {},
  addLlmInferenceStatus: (jobId, status) =>
    set((s) => ({
      llmInferenceStatus: {
        ...s.llmInferenceStatus,
        [jobId]: [status, ...(s.llmInferenceStatus[jobId] || [])].slice(0, 100),
      },
    })),

  // ── Agents (from AgentRegistry view functions) ───────────
  agents: {},
  setAgent: (addr, profile) =>
    set((s) => ({ agents: { ...s.agents, [addr]: profile } })),

  // ── Audit log (from HCS AuditLog topic) ─────────────────
  auditLog: [],
  addLogEntry: (entry) =>
    set((s) => ({ auditLog: [entry, ...s.auditLog].slice(0, 200) })),
  eventIndex: {},
  upsertEvent: (entry) => {
    const eventId = entry?.eventId;
    if (!eventId) {
      set((s) => ({ auditLog: [entry, ...s.auditLog].slice(0, 200) }));
      return true;
    }
    let inserted = false;
    set((s) => {
      if (s.eventIndex[eventId]) {
        return {
          ingestionHealth: {
            ...s.ingestionHealth,
            duplicatesDropped: (s.ingestionHealth?.duplicatesDropped || 0) + 1,
            duplicateDrops: (s.ingestionHealth?.duplicateDrops || 0) + 1,
          },
        };
      }
      inserted = true;
      const nextLog = [entry, ...s.auditLog].slice(0, 200);
      const nextIndex = {};
      for (const item of nextLog) {
        if (item?.eventId) nextIndex[item.eventId] = true;
      }
      return { auditLog: nextLog, eventIndex: nextIndex };
    });
    return inserted;
  },

  // ── Report metadata (from HCS REPORT_METADATA messages) ─
  reportMetadata: {},
  addReportMetadata: (jobId, meta) => set((s) => ({
    reportMetadata: { ...s.reportMetadata, [jobId]: meta },
  })),

  // ── Winners (from AuditAuction.WinnersSelected events) ───
  winners: {},
  setWinners: (jobId, w) =>
    set((s) => ({ winners: { ...s.winners, [jobId]: w } })),

  // ── Day 2: Sub-auctions (from SubAuction contract) ───────
  subJobs: {},       // subJobId → SubJob object
  subBids: {},       // subJobId → SubBid[] array
  parentSubJobs: {}, // parentJobId → subJobId[] (tree linkage)

  addSubJob: (subJob) => set((s) => ({
    subJobs: { ...s.subJobs, [subJob.subJobId]: subJob },
    parentSubJobs: {
      ...s.parentSubJobs,
      [subJob.parentJobId]: [
        ...(s.parentSubJobs[subJob.parentJobId] || []),
        subJob.subJobId,
      ],
    },
  })),

  addSubBid: (subJobId, bid) => set((s) => ({
    subBids: {
      ...s.subBids,
      [subJobId]: [...(s.subBids[subJobId] || []), bid],
    },
  })),

  updateSubJobStatus: (subJobId, updates) => set((s) => ({
    subJobs: {
      ...s.subJobs,
      [subJobId]: { ...s.subJobs[subJobId], ...updates },
    },
  })),

  // ── Day 2: Data marketplace (from DataMarketplace contract) ─
  dataListings: {},  // listingId → DataListing object
  dataPurchases: [], // array of purchase records
  jobListings: {},   // parentJobId → listingId[] (data tied to a job)

  addDataListing: (listing) => set((s) => ({
    dataListings: { ...s.dataListings, [listing.listingId]: listing },
    jobListings: listing.parentJobId ? {
      ...s.jobListings,
      [listing.parentJobId]: [
        ...(s.jobListings[listing.parentJobId] || []),
        listing.listingId,
      ],
    } : s.jobListings,
  })),

  addDataPurchase: (purchase) => set((s) => ({
    dataPurchases: [purchase, ...s.dataPurchases].slice(0, 100),
  })),

  updateDataPurchaseRating: (listingId, buyer, rating) => set((s) => ({
    dataPurchases: s.dataPurchases.map((p) =>
      p.listingId === listingId && p.buyer?.toLowerCase() === buyer?.toLowerCase()
        ? { ...p, rating }
        : p
    ),
  })),

  // ── Day 2: Settlements (from PaymentSettlement contract) ──
  settlements: {},   // settlementId → SettlementRecord
  jobSettlements: {}, // jobId → settlementId

  addSettlement: (settlement) => set((s) => ({
    settlements: { ...s.settlements, [settlement.settlementId]: settlement },
    jobSettlements: { ...s.jobSettlements, [settlement.jobId]: settlement.settlementId },
  })),

  // ── Day 2: GUARD flow tracking ───────────────────────────
  guardFlows: [], // { from, to, amount, type, timestamp, jobId }
  addGuardFlow: (flow) => set((s) => ({
    guardFlows: [flow, ...s.guardFlows].slice(0, 500),
  })),
  flowIndex: {},
  upsertGuardFlow: (flow) => {
    const flowId = flow?.flowId;
    if (!flowId) {
      set((s) => ({ guardFlows: [flow, ...s.guardFlows].slice(0, 500) }));
      return true;
    }
    let inserted = false;
    set((s) => {
      if (s.flowIndex[flowId]) {
        return {
          ingestionHealth: {
            ...s.ingestionHealth,
            duplicatesDropped: (s.ingestionHealth?.duplicatesDropped || 0) + 1,
            duplicateDrops: (s.ingestionHealth?.duplicateDrops || 0) + 1,
          },
        };
      }
      inserted = true;
      const nextFlows = [flow, ...s.guardFlows].slice(0, 500);
      const nextIndex = {};
      for (const item of nextFlows) {
        if (item?.flowId) nextIndex[item.flowId] = true;
      }
      return { guardFlows: nextFlows, flowIndex: nextIndex };
    });
    return inserted;
  },

  // ── Ingestion observability ───────────────────────────────
  ingestionHealth: {
    sourceMode: 'onchain_strict',
    replayMode: 'from_now',
    lastHcsSeq: { discovery: 0, auditLog: 0, agentComms: 0 },
    lastTopicSeq: { discovery: 0, auditLog: 0, agentComms: 0 },
    lastContractBlock: 0,
    duplicatesDropped: 0,
    duplicateDrops: 0,
    contractEventsSeen: 0,
    hcsEventsSeen: 0,
    activeAuctionsCount: 0,
    decodeFailures: 0,
    pendingSettlementBreakdowns: 0,
    agentHydrationStatus: 'degraded',
    agentHydrationError: null,
    agentHydrationLastAt: 0,
  },
  setIngestionHealth: (patch) =>
    set((s) => ({
      ingestionHealth: {
        ...s.ingestionHealth,
        ...patch,
        lastHcsSeq: {
          ...(s.ingestionHealth?.lastHcsSeq || {}),
          ...(patch?.lastHcsSeq || {}),
        },
        lastTopicSeq: {
          ...(s.ingestionHealth?.lastTopicSeq || {}),
          ...(patch?.lastTopicSeq || {}),
        },
      },
    })),

  // ── Live stats ───────────────────────────────────────────
  stats: {
    totalDiscoveries: 0,
    totalAuctions: 0,
    totalBids: 0,
    guardTransacted: 0,
    totalSubAuctions: 0,
    totalDataSales: 0,
    totalSettlements: 0,
    totalGuardTransacted: 0,
  },
  incrementStat: (key, amount = 1) =>
    set((s) => ({
      stats: { ...s.stats, [key]: (s.stats[key] || 0) + amount },
    })),

  // ── Day 3: Agent enriched profiles (from StakingManager) ─
  agentProfiles: {},
  setAgentProfile: (addr, profile) =>
    set((s) => ({ agentProfiles: { ...s.agentProfiles, [addr]: profile } })),

  // ── Day 3: Reputation history (sparklines + graphs) ──────
  reputationHistory: {},
  addReputationSnapshot: (addr, snapshot) =>
    set((s) => ({
      reputationHistory: {
        ...s.reputationHistory,
        [addr]: [...(s.reputationHistory[addr] || []), snapshot].slice(-50),
      },
    })),

  // ── Day 3: Vault / contract health data ──────────────────
  contractHealth: {},
  setContractHealth: (addr, health) =>
    set((s) => ({ contractHealth: { ...s.contractHealth, [addr]: health } })),

  // ── Day 3: Slash events (newest first, max 50) ────────────
  slashEvents: [],
  addSlashEvent: (slash) =>
    set((s) => ({ slashEvents: [slash, ...s.slashEvents].slice(0, 50) })),

  // ── Day 3: Treasury revenue tracking ─────────────────────
  treasuryRevenue: {
    total: 0, auditFees: 0, marketplaceFees: 0,
    reportFees: 0, slashingProceeds: 0, subAuctionFees: 0,
  },
  addTreasuryRevenue: (source, amount) =>
    set((s) => {
      const sourceKey = [
        'auditFees', 'marketplaceFees', 'reportFees', 'slashingProceeds', 'subAuctionFees',
      ][source] || 'auditFees';
      const amt = Number(amount) || 0;
      return {
        treasuryRevenue: {
          ...s.treasuryRevenue,
          total: s.treasuryRevenue.total + amt,
          [sourceKey]: (s.treasuryRevenue[sourceKey] || 0) + amt,
        },
      };
    }),
  treasuryDistributions: [],
  addTreasuryDistribution: (dist) =>
    set((s) => ({ treasuryDistributions: [dist, ...s.treasuryDistributions].slice(0, 50) })),

  // ── Day 3: Tab + selection state ─────────────────────────
  activeTab: 'liveFeed',
  setActiveTab: (tab) => set({ activeTab: tab }),
  selectedAgent: null,
  setSelectedAgent: (addr) => set({ selectedAgent: addr }),
  selectedContract: null,
  setSelectedContract: (addr) => set({ selectedContract: addr }),

  // ── Day 3: Agent stake update (from StakingManager.Staked) ─
  updateAgentStake: (addr, newTotal) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [addr]: { ...(s.agents[addr] || {}), stakedAmount: newTotal },
      },
    })),

  // ── Day 3: Stake history (for StakingChart) ───────────────
  // { timestamp, totalStaked, lockedStake, availableStake, event, jobId }
  stakeHistory: {},
  addStakeSnapshot: (addr, snapshot) =>
    set((s) => ({
      stakeHistory: {
        ...s.stakeHistory,
        [addr]: [...(s.stakeHistory[addr] || []), snapshot].slice(-50),
      },
    })),

  // ── HSS Schedule events (from AuditScheduler contract) ──────
  // Events: AuditScheduled, AuditTriggered, AuditScheduleCancelled, ScheduleFailed
  hssEvents: [],
  addHssEvent: (ev) =>
    set((s) => ({ hssEvents: [ev, ...s.hssEvents].slice(0, 500) })),

  // ── Full store reset (debug panel) ───────────────────────
  resetAll: () => set({
    isConnected: false, connectionError: null,
    discoveries: [], discoveriesByAddress: {}, activeJobs: {}, jobTerminal: {}, bids: {}, jobBidStatus: {}, llmProviderStatus: {}, llmInferenceStatus: {}, agents: {}, auditLog: [],
    reportMetadata: {},
    winners: {}, subJobs: {}, subBids: {}, parentSubJobs: {},
    dataListings: {}, dataPurchases: [], jobListings: {},
    settlements: {}, jobSettlements: {}, guardFlows: [],
    eventIndex: {}, flowIndex: {},
    agentProfiles: {}, reputationHistory: {}, contractHealth: {},
    slashEvents: [], treasuryDistributions: [], stakeHistory: {},
    treasuryRevenue: {
      total: 0, auditFees: 0, marketplaceFees: 0,
      reportFees: 0, slashingProceeds: 0, subAuctionFees: 0,
    },
    selectedAgent: null, selectedContract: null,
    stats: {
      totalDiscoveries: 0, totalAuctions: 0, totalBids: 0,
      guardTransacted: 0, totalSubAuctions: 0, totalDataSales: 0,
      totalSettlements: 0, totalGuardTransacted: 0,
    },
    ingestionHealth: {
      sourceMode: 'onchain_strict',
      replayMode: 'from_now',
      lastHcsSeq: { discovery: 0, auditLog: 0, agentComms: 0 },
      lastTopicSeq: { discovery: 0, auditLog: 0, agentComms: 0 },
      lastContractBlock: 0,
      duplicatesDropped: 0,
      duplicateDrops: 0,
      contractEventsSeen: 0,
      hcsEventsSeen: 0,
      activeAuctionsCount: 0,
      decodeFailures: 0,
      pendingSettlementBreakdowns: 0,
      agentHydrationStatus: 'degraded',
      agentHydrationError: null,
      agentHydrationLastAt: 0,
    },
  }),
}));

export default useStore;
