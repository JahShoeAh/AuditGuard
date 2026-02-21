import { describe, expect, it, vi } from "vitest";
import { EventListenerService } from "../services/event-listener";
import { buildAuctionRows } from "../hooks/useAuctionData";

function makeStoreSpies() {
  return {
    addDiscovery: vi.fn(),
    addLogEntry: vi.fn(),
    upsertEvent: vi.fn(() => true),
    setJob: vi.fn(),
    setJobTerminal: vi.fn(),
    addBid: vi.fn(),
    addJobBidStatus: vi.fn(),
    setLlmProviderStatus: vi.fn(),
    addLlmInferenceStatus: vi.fn(),
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
    upsertGuardFlow: vi.fn(() => true),
    updateAgentStake: vi.fn(),
    addSlashEvent: vi.fn(),
    addTreasuryRevenue: vi.fn(),
    addTreasuryDistribution: vi.fn(),
    setIngestionHealth: vi.fn(),
    agents: {},
    activeJobs: {},
    reportMetadata: {},
    subJobs: {},
  };
}

function makeContractMock(handlers = {}) {
  return {
    queryFilter: vi.fn(async (event) => handlers[event] || []),
  };
}

const config = {
  hcsTopics: {
    discovery: "0.0.1",
    auditLog: "0.0.2",
    agentComms: "0.0.3",
  },
  dashboard: {
    sourceMode: "hybrid",
    hcsReplayMode: "from_now",
  },
  seededAgents: {},
};

describe("Cross-service event contract compatibility", () => {
  it("accepts canonical HCS payloads for JOB_CREATED, AUCTION_INVITE, BID_SUBMITTED, WINNER_SELECTED", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "JOB_CREATED",
        payload: {
          jobId: "9001",
          contractAddress: "0x0000000000000000000000000000000000000a11",
          contractType: "lending",
          budget: 100,
          riskScore: 76,
          estimatedLOC: 1500,
          onChain: true,
          classifier: {
            riskSource: "0g",
            riskModel: "qwen/qwen-2.5-7b-instruct",
            topRiskFactors: ["reentrancy"],
            evmType: "erc20",
            isProxy: false,
          },
        },
      },
      timestamp: "1700000000.100000000",
      sequenceNumber: 1,
    });

    svc._routeHCSMessage("agentComms", {
      parsedData: {
        type: "AUCTION_INVITE",
        payload: {
          jobId: "9001",
          contractAddress: "0x0000000000000000000000000000000000000a11",
          contractType: "lending",
          budget: 100,
          riskScore: 76,
          estimatedLOC: 1500,
          inviteBatchId: "invite:9001:1700000000",
          eligibleAgentIds: ["static-analysis-047", "fuzzer-012"],
          eligibleEvmAddresses: [
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
          ],
          classifierHints: {
            riskSource: "0g",
            riskModel: "qwen/qwen-2.5-7b-instruct",
            topRiskFactors: ["reentrancy"],
            evmType: "erc20",
            isProxy: false,
          },
        },
      },
      timestamp: "1700000000.200000000",
      sequenceNumber: 2,
    });

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SUBMITTED",
        agentId: "static-analysis-047",
        payload: {
          jobId: "9001",
          contractAddress: "0x0000000000000000000000000000000000000a11",
          bidAmount: 12.4,
          collateral: 6.2,
          estimatedTimeSec: 180,
        },
      },
      timestamp: "1700000000.300000000",
      sequenceNumber: 3,
    });

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "9001",
          winners: [
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
          ],
          totalEscrowed: "1860000000",
          platformFee: "18600000",
        },
      },
      timestamp: "1700000000.400000000",
      sequenceNumber: 4,
    });

    expect(store.setJob).toHaveBeenCalledWith(
      "9001",
      expect.objectContaining({
        jobId: "9001",
        contractAddress: "0x0000000000000000000000000000000000000a11",
        classifier: expect.objectContaining({
          riskSource: "0g",
        }),
      })
    );
    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "9001",
      expect.objectContaining({
        status: "invite_sent",
        agentId: "static-analysis-047",
      })
    );
    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "9001",
      expect.objectContaining({
        status: "submitted",
        agentId: "static-analysis-047",
      })
    );
    expect(store.upsertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WINNER_SELECTED",
      })
    );
  });

  it("maps JobCancelled and JobCompleted contract events into terminal metadata", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 220),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = makeContractMock({
      JobCancelled: [
        {
          args: { jobId: 33n },
          blockNumber: 219,
          transactionHash: "0xjobcancel33",
        },
      ],
      JobCompleted: [
        {
          args: { jobId: 34n },
          blockNumber: 219,
          transactionHash: "0xjobcomplete34",
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
    svc.lastProcessedBlock = 218;
    await svc._pollContractEvents();

    expect(store.setJobTerminal).toHaveBeenCalledWith(
      "33",
      expect.objectContaining({ status: "cancelled", txHash: "0xjobcancel33" })
    );
    expect(store.setJobTerminal).toHaveBeenCalledWith(
      "34",
      expect.objectContaining({ status: "completed", txHash: "0xjobcomplete34" })
    );
  });

  it("excludes terminal auctions from live rows after lifecycle sequence completes", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "33": {
          jobId: "33",
          contractType: "lending",
          auctionDeadline: nowSec + 60,
          terminalStatus: "cancelled",
        },
        "34": {
          jobId: "34",
          contractType: "bridge",
          auctionDeadline: nowSec + 60,
        },
      },
      bids: {
        "34": [{ agentName: "static-analysis-047", bidAmount: 12.4 }],
      },
      winners: {
        "34": {
          agents: ["0x00000000000000000000000000000000000000aa"],
          winnersAt: (nowSec * 1000) - 5_000,
        },
      },
      activeJobIds: [33n, 34n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((entry) => entry.job.jobId)).toEqual(["34"]);
  });
});
