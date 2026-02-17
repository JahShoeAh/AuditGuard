import { create } from 'zustand';

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
  useMockEvents: true,
  toggleMockEvents: () => set((s) => ({ useMockEvents: !s.useMockEvents })),

  // ── Contract discoveries (from HCS Discovery topic) ──────
  discoveries: [],
  addDiscovery: (d) =>
    set((s) => ({ discoveries: [d, ...s.discoveries].slice(0, 100) })),

  // ── Auction jobs (from AuditAuction.JobPosted events) ────
  activeJobs: {},
  setJob: (id, job) =>
    set((s) => ({ activeJobs: { ...s.activeJobs, [id]: job } })),

  // ── Bids (from AuditAuction.BidSubmitted events) ─────────
  bids: {},
  addBid: (jobId, bid) =>
    set((s) => ({
      bids: { ...s.bids, [jobId]: [...(s.bids[jobId] || []), bid] },
    })),

  // ── Agents (from AgentRegistry view functions) ───────────
  agents: {},
  setAgent: (addr, profile) =>
    set((s) => ({ agents: { ...s.agents, [addr]: profile } })),

  // ── Audit log (from HCS AuditLog topic) ─────────────────
  auditLog: [],
  addLogEntry: (entry) =>
    set((s) => ({ auditLog: [entry, ...s.auditLog].slice(0, 200) })),

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
}));

export default useStore;
