import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventListenerService } from "../services/event-listener";

function makeStoreSpies() {
  return {
    addDiscovery: vi.fn(),
    addLogEntry: vi.fn(),
    setJob: vi.fn(),
    addBid: vi.fn(),
    setWinners: vi.fn(),
    setAgent: vi.fn(),
    incrementStat: vi.fn(),
    addSubJob: vi.fn(),
    addSubBid: vi.fn(),
    updateSubJobStatus: vi.fn(),
    addDataListing: vi.fn(),
    addDataPurchase: vi.fn(),
    updateDataPurchaseRating: vi.fn(),
    addSettlement: vi.fn(),
    addGuardFlow: vi.fn(),
    updateAgentStake: vi.fn(),
    addSlashEvent: vi.fn(),
    addTreasuryRevenue: vi.fn(),
    addTreasuryDistribution: vi.fn(),
    agents: {},
    subJobs: {},
  };
}

function makeContractMock(handlers = {}) {
  return {
    queryFilter: vi.fn(async (event) => handlers[event] || []),
  };
}

describe("EventListenerService", () => {
  const config = {
    hcsTopics: {
      discovery: "0.0.1",
      auditLog: "0.0.2",
      agentComms: "0.0.3",
    },
    seededAgents: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes discovery HCS messages into discovery + audit log actions", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("discovery", {
      parsedData: {
        type: "CONTRACT_DISCOVERED",
        payload: { contractAddress: "0xabc", contractType: "lending" },
      },
      timestamp: "1700000000.123456789",
      sequenceNumber: 42,
    });

    expect(store.addDiscovery).toHaveBeenCalledTimes(1);
    expect(store.incrementStat).toHaveBeenCalledWith("totalDiscoveries");
    expect(store.addLogEntry).toHaveBeenCalledTimes(1);
    expect(store.addLogEntry.mock.calls[0][0]).toMatchObject({
      type: "CONTRACT_DISCOVERED",
      contractAddress: "0xabc",
      _hcsSequence: 42,
      _hcsTopic: "0.0.1",
      source: "discovery",
    });
  });

  it("routes BID_SUBMITTED audit log messages into bid stats", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SUBMITTED",
        payload: { jobId: 123, bidAmount: 10 },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 2,
    });

    expect(store.addLogEntry).toHaveBeenCalledTimes(1);
    expect(store.incrementStat).toHaveBeenCalledWith("totalBids");
  });

  it("ingests live JobPosted + BidSubmitted contract events", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 110),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = makeContractMock({
      JobPosted: [
        {
          args: {
            jobId: 7n,
            contractAddress: "0x0000000000000000000000000000000000000aaa",
            contractChain: "hedera",
            contractType: "lending",
            budgetAvailable: 5000000000n,
            auctionDeadline: 1700000100n,
            initialRiskScore: 75n,
            lineCount: 1400n,
          },
          blockNumber: 100,
          transactionHash: "0xjobtx",
        },
      ],
      BidSubmitted: [
        {
          args: {
            jobId: 7n,
            agent: "0x0000000000000000000000000000000000000bbb",
            bidAmount: 1200000000n,
            collateralLocked: 400000000n,
            reputationAtBid: 82n,
            specialization: "lending",
            estimatedCompletionTime: 300n,
          },
          blockNumber: 101,
          transactionHash: "0xbidtx",
        },
      ],
    });

    const contracts = {
      auctionContract,
      agentRegistryContract: makeContractMock(),
      subAuctionContract: makeContractMock(),
      dataMarketplaceContract: makeContractMock(),
      paymentSettlementContract: makeContractMock(),
      vaultFactoryContract: makeContractMock(),
      stakingManagerContract: makeContractMock(),
      treasuryContract: makeContractMock(),
    };

    const svc = new EventListenerService(config, contracts, store, provider);
    svc.lastProcessedBlock = 99;

    await svc._pollContractEvents();

    expect(store.setJob).toHaveBeenCalledWith(
      "7",
      expect.objectContaining({
        jobId: "7",
        contractType: "lending",
      })
    );
    expect(store.addBid).toHaveBeenCalledWith(
      "7",
      expect.objectContaining({
        bidFormatted: "12.00 GUARD",
      })
    );
    expect(store.incrementStat).toHaveBeenCalledWith("totalAuctions");
    expect(store.incrementStat).toHaveBeenCalledWith("totalBids");
  });
});
