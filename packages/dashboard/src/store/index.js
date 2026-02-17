import { create } from 'zustand';

const useStore = create((set) => ({
  // Connection state
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
  useMockEvents: true,  // default ON so UI works before agents run
  toggleMockEvents: () => set((s) => ({ useMockEvents: !s.useMockEvents })),

  // Contract discoveries (from HCS Discovery topic)
  discoveries: [],
  addDiscovery: (d) =>
    set((s) => ({ discoveries: [d, ...s.discoveries].slice(0, 100) })),

  // Auction jobs (from AuditAuction.JobPosted events)
  activeJobs: {},
  setJob: (id, job) =>
    set((s) => ({ activeJobs: { ...s.activeJobs, [id]: job } })),

  // Bids (from AuditAuction.BidSubmitted events)
  bids: {},
  addBid: (jobId, bid) =>
    set((s) => ({
      bids: {
        ...s.bids,
        [jobId]: [...(s.bids[jobId] || []), bid],
      },
    })),

  // Agents (from AgentRegistry view functions)
  agents: {},
  setAgent: (addr, profile) =>
    set((s) => ({ agents: { ...s.agents, [addr]: profile } })),

  // Audit log (from HCS AuditLog topic — universal event stream)
  auditLog: [],
  addLogEntry: (entry) =>
    set((s) => ({ auditLog: [entry, ...s.auditLog].slice(0, 200) })),

  // Winners (from AuditAuction.WinnersSelected events)
  winners: {},
  setWinners: (jobId, w) =>
    set((s) => ({ winners: { ...s.winners, [jobId]: w } })),

  // Live stats
  stats: {
    totalDiscoveries: 0,
    totalAuctions: 0,
    totalBids: 0,
    guardTransacted: 0,
  },
  incrementStat: (key, amount = 1) =>
    set((s) => ({
      stats: { ...s.stats, [key]: s.stats[key] + amount },
    })),
}));

export default useStore;
