import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventListenerService } from "../services/event-listener";

function makeStoreSpies() {
  return {
    addDiscovery: vi.fn(),
    addLogEntry: vi.fn(),
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
    updateAgentStake: vi.fn(),
    addSlashEvent: vi.fn(),
    addTreasuryRevenue: vi.fn(),
    addTreasuryDistribution: vi.fn(),
    setIngestionHealth: vi.fn(),
    agents: {},
    winners: {},
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
    dashboard: {
      sourceMode: "onchain_strict",
      hcsReplayMode: "from_now",
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

  it("in strict mode, keeps BID_SUBMITTED as lifecycle/log only (no canonical bid mutation)", () => {
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
    expect(store.incrementStat).not.toHaveBeenCalledWith("totalBids");
    expect(store.addBid).not.toHaveBeenCalled();
    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "123",
      expect.objectContaining({ status: "submitted" })
    );
  });

  it("in hybrid mode, applies canonical BID_SUBMITTED updates from audit log", () => {
    const store = makeStoreSpies();
    const hybridConfig = {
      ...config,
      dashboard: { ...config.dashboard, sourceMode: "hybrid" },
    };
    const svc = new EventListenerService(hybridConfig, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SUBMITTED",
        payload: { jobId: 123, bidAmount: 10, agentId: "static-analysis-047" },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 2,
    });

    expect(store.addBid).toHaveBeenCalledTimes(1);
    expect(store.incrementStat).toHaveBeenCalledWith("totalBids");
  });

  it("routes BID_SKIPPED messages into job bid lifecycle", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SKIPPED",
        agentId: "static-analysis-047",
        payload: { jobId: "55", reason: "Wallet is not an active on-chain agent" },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 4,
    });

    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "55",
      expect.objectContaining({
        status: "skipped",
        agentId: "static-analysis-047",
      })
    );
  });

  it("downgrades payer-funding BID_SUBMISSION_FAILED to skipped with concise reason", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SUBMISSION_FAILED",
        agentId: "static-analysis-047",
        payload: {
          jobId: "481",
          reasonCode: "insufficient_payer_hbar",
          error:
            "server response 400 Bad Request (request={ }, response={ }, error=null, info={ \"responseBody\": \"{\\\"error\\\":{\\\"code\\\":-32000,\\\"message\\\":\\\"Insufficient funds for transfer\\\"}}\" })",
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 9,
    });

    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "481",
      expect.objectContaining({
        status: "skipped",
        agentId: "static-analysis-047",
        reason: "Insufficient payer HBAR for transaction fees",
      })
    );
    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "BID_SKIPPED",
        jobId: "481",
        reason: "Insufficient payer HBAR for transaction fees",
      })
    );
  });

  it("routes AUCTION_INVITE_SUMMARY messages into invite lifecycle entries", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "AUCTION_INVITE_SUMMARY",
        payload: {
          jobId: "77",
          eligibleAgents: [
            { agentId: "static-analysis-047", evmAddress: "0x00000000000000000000000000000000000000aa" },
            { agentId: "fuzzer-012", evmAddress: "0x00000000000000000000000000000000000000bb" },
          ],
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 5,
    });

    expect(store.addJobBidStatus).toHaveBeenCalledTimes(2);
    expect(store.addJobBidStatus).toHaveBeenNthCalledWith(
      1,
      "77",
      expect.objectContaining({ status: "invite_sent", agentId: "static-analysis-047" })
    );
  });

  it("expands targeted AUCTION_INVITE payloads into per-agent invite lifecycle entries", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("agentComms", {
      parsedData: {
        type: "AUCTION_INVITE",
        payload: {
          jobId: "91",
          eligibleAgentIds: ["static-analysis-047", "fuzzer-012"],
          eligibleEvmAddresses: [
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
          ],
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 6,
    });

    expect(store.addJobBidStatus).toHaveBeenCalledTimes(2);
    expect(store.addJobBidStatus).toHaveBeenNthCalledWith(
      1,
      "91",
      expect.objectContaining({ status: "invite_sent", agentId: "static-analysis-047" })
    );
    expect(store.addJobBidStatus).toHaveBeenNthCalledWith(
      2,
      "91",
      expect.objectContaining({ status: "invite_sent", agentId: "fuzzer-012" })
    );
  });

  it("does not create placeholder active jobs from AUCTION_INVITE classifier hints alone", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("agentComms", {
      parsedData: {
        type: "AUCTION_INVITE",
        payload: {
          jobId: "92",
          contractAddress: "0x0000000000000000000000000000000000000a11",
          classifierHints: {
            riskSource: "0g",
            riskModel: "qwen/qwen-2.5-7b-instruct",
          },
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 7,
    });

    expect(store.setJob).not.toHaveBeenCalled();
    expect(store.addJobBidStatus).toHaveBeenCalledWith(
      "92",
      expect.objectContaining({ status: "invite_sent" })
    );
  });

  it("flags malformed BID_SUBMITTED payloads and skips bid lifecycle mutation", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "BID_SUBMITTED",
        payload: { jobId: 123, bidAmount: 0 },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 7,
    });

    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BID_SUBMITTED_MALFORMED" })
    );
    expect(store.addJobBidStatus).not.toHaveBeenCalled();
  });

  it("in strict mode, does not mutate canonical agents from AGENT_REGISTERED audit logs", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "AGENT_REGISTERED",
        agentId: "static-analysis-047",
        payload: {
          evmAddress: "0x00000000000000000000000000000000000000aa",
          stake: 100,
          reputation: 75,
          specializations: ["lending", "vault"],
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 3,
    });

    expect(store.setAgent).not.toHaveBeenCalled();
  });

  it("in hybrid mode, allows AGENT_REGISTERED audit logs to upsert agents", () => {
    const store = makeStoreSpies();
    const hybridConfig = {
      ...config,
      dashboard: { ...config.dashboard, sourceMode: "hybrid" },
    };
    const svc = new EventListenerService(hybridConfig, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "AGENT_REGISTERED",
        agentId: "static-analysis-047",
        payload: {
          evmAddress: "0x00000000000000000000000000000000000000aa",
          stake: 100,
          reputation: 75,
          specializations: ["lending", "vault"],
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 3,
    });

    expect(store.setAgent).toHaveBeenCalledTimes(1);
  });

  it("routes LLM provider and inference lifecycle events into dedicated store slices", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "LLM_PROVIDER_READY",
        agentId: "llm-contextual-003",
        payload: {
          providerAddress: "0xa48f01287233509FD694a22Bf840225062E67836",
          model: "qwen-2.5-7b-instruct",
        },
      },
      timestamp: "1700000000.000000001",
      sequenceNumber: 90,
    });

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "LLM_INFERENCE_FAILED",
        agentId: "llm-contextual-003",
        payload: {
          jobId: "88",
          reasonCode: "zg_timeout",
          reason: "inference request timeout",
        },
      },
      timestamp: "1700000001.000000001",
      sequenceNumber: 91,
    });

    expect(store.setLlmProviderStatus).toHaveBeenCalledWith(
      "llm-contextual-003",
      expect.objectContaining({ status: "ready" })
    );
    expect(store.addLlmInferenceStatus).toHaveBeenCalledWith(
      "88",
      expect.objectContaining({ status: "failed", reasonCode: "zg_timeout" })
    );
  });

  it("hydrates winners immediately from WINNER_SELECTED audit-log events", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "33",
          winners: [
            "0x00000000000000000000000000000000000000aa",
            "0x00000000000000000000000000000000000000bb",
          ],
          totalEscrowed: "150000000",
          platformFee: "5000000",
        },
      },
      timestamp: "1700000002.000000001",
      sequenceNumber: 92,
    });

    expect(store.setWinners).toHaveBeenCalledWith(
      "33",
      expect.objectContaining({
        agents: [
          "0x00000000000000000000000000000000000000aa",
          "0x00000000000000000000000000000000000000bb",
        ],
        totalEscrowedFormatted: "1.50 GUARD",
        platformFeeFormatted: "0.05 GUARD",
        source: "auditLog",
      })
    );
    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WINNER_SELECTED",
        jobId: "33",
        winnerCount: 2,
      })
    );
  });

  it("does not overwrite authoritative contract winners with malformed WINNER_SELECTED payloads", () => {
    const store = makeStoreSpies();
    store.winners = {
      "33": {
        source: "contract",
        agents: ["0x00000000000000000000000000000000000000cc"],
      },
    };
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "33",
          winners: [],
        },
      },
      timestamp: "1700000002.000000001",
      sequenceNumber: 93,
    });

    expect(store.setWinners).not.toHaveBeenCalled();
  });

  it("accepts legacy WINNERS_SELECTED payloads and normalizes them for UI/store", () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNERS_SELECTED",
        payload: {
          jobId: "34",
          winners: ["0x00000000000000000000000000000000000000dd"],
        },
      },
      timestamp: "1700000002.000000001",
      sequenceNumber: 94,
    });

    expect(store.setWinners).toHaveBeenCalledWith(
      "34",
      expect.objectContaining({
        agents: ["0x00000000000000000000000000000000000000dd"],
        source: "auditLog",
      })
    );
    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WINNER_SELECTED",
        jobId: "34",
        winnerCount: 1,
      })
    );
  });

  it("preserves first winnersAt for duplicate WINNER_SELECTED audit-log events", () => {
    const store = makeStoreSpies();
    store.setWinners = vi.fn((jobId, data) => {
      store.winners[jobId] = data;
    });
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "36",
          winners: ["0x00000000000000000000000000000000000000aa"],
        },
      },
      timestamp: "1700000002.000000001",
      sequenceNumber: 96,
    });
    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "36",
          winners: ["0x00000000000000000000000000000000000000aa"],
        },
      },
      timestamp: "1700000015.000000001",
      sequenceNumber: 97,
    });

    expect(store.setWinners).toHaveBeenLastCalledWith(
      "36",
      expect.objectContaining({
        winnersAt: "1700000002.000000001",
      })
    );
  });

  it("does not overwrite authoritative contract winners with conflicting WINNER_SELECTED payloads", () => {
    const store = makeStoreSpies();
    store.winners = {
      "35": {
        source: "contract",
        agents: ["0x00000000000000000000000000000000000000cc"],
      },
    };
    const svc = new EventListenerService(config, {}, store, null);

    svc._routeHCSMessage("auditLog", {
      parsedData: {
        type: "WINNER_SELECTED",
        payload: {
          jobId: "35",
          winners: ["0x00000000000000000000000000000000000000ee"],
        },
      },
      timestamp: "1700000002.000000001",
      sequenceNumber: 95,
    });

    expect(store.setWinners).not.toHaveBeenCalled();
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
        postedAt: expect.any(Number),
        updatedAt: expect.any(Number),
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

  it("marks terminal metadata from JobCancelled and JobCompleted contract events", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 220),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = makeContractMock({
      JobCancelled: [
        {
          args: { jobId: 11n },
          blockNumber: 219,
          transactionHash: "0xcancelled",
        },
      ],
      JobCompleted: [
        {
          args: { jobId: 12n },
          blockNumber: 219,
          transactionHash: "0xcompleted",
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
      "11",
      expect.objectContaining({ status: "cancelled", txHash: "0xcancelled" })
    );
    expect(store.setJobTerminal).toHaveBeenCalledWith(
      "12",
      expect.objectContaining({ status: "completed", txHash: "0xcompleted" })
    );
    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: "JobCancelled", jobId: "11" })
    );
    expect(store.addLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: "JobCompleted", jobId: "12" })
    );
  });

  it("splits DataPurchased into seller net flow + treasury fee flow", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 500),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const dataMarketplaceContract = makeContractMock({
      DataPurchased: [
        {
          args: {
            listingId: 9n,
            buyer: "0x0000000000000000000000000000000000000bbb",
            seller: "0x0000000000000000000000000000000000000aaa",
            pricePaid: 100000000n,
            platformFee: 10000000n,
          },
          blockNumber: 499,
          transactionHash: "0xdatapurchase",
        },
      ],
    });

    const contracts = {
      auctionContract: makeContractMock(),
      agentRegistryContract: makeContractMock(),
      subAuctionContract: makeContractMock(),
      dataMarketplaceContract,
      paymentSettlementContract: makeContractMock(),
      vaultFactoryContract: makeContractMock(),
      stakingManagerContract: makeContractMock(),
      treasuryContract: makeContractMock(),
    };

    const cfg = {
      ...config,
      contracts: { treasury: { evmAddress: "0x0000000000000000000000000000000000000fee" } },
    };
    const svc = new EventListenerService(cfg, contracts, store, provider);
    svc.lastProcessedBlock = 498;

    await svc._pollContractEvents();

    expect(store.addDataPurchase).toHaveBeenCalledTimes(1);
    expect(store.addGuardFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "DATA_PURCHASE_NET",
        amount: 90000000n,
        to: "0x0000000000000000000000000000000000000aaa",
      })
    );
    expect(store.addGuardFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PLATFORM_FEE",
        amount: 10000000n,
        to: "0x0000000000000000000000000000000000000fee",
      })
    );
  });

  it("from_now replay mode initializes HCS cursor without replaying historical rows", async () => {
    const store = makeStoreSpies();
    const svc = new EventListenerService(config, {}, store, null);
    const fetchSpy = vi.spyOn(svc, "fetchHCSMessages")
      .mockResolvedValueOnce([{ sequenceNumber: 50, timestamp: "1700000000.1", parsedData: { type: "PING" } }])
      .mockResolvedValueOnce([{ sequenceNumber: 51, timestamp: "1700000001.1", parsedData: { type: "PONG" } }]);
    const routeSpy = vi.spyOn(svc, "_routeHCSMessage");

    await svc._pollHCSTopic("0.0.2", "auditLog");
    expect(routeSpy).not.toHaveBeenCalled();
    expect(svc.lastSeq.auditLog).toBe(50);

    await svc._pollHCSTopic("0.0.2", "auditLog");
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("prevents a second EventListenerService instance from starting while one is active", () => {
    const storeA = makeStoreSpies();
    const storeB = makeStoreSpies();
    const svcA = new EventListenerService(config, {}, storeA, null);
    const svcB = new EventListenerService(config, {}, storeB, null);

    const aHcs = vi.spyOn(svcA, "startHCSPolling").mockImplementation(() => {});
    const aContract = vi.spyOn(svcA, "startContractEventPolling").mockImplementation(() => {});
    const bHcs = vi.spyOn(svcB, "startHCSPolling").mockImplementation(() => {});
    const bContract = vi.spyOn(svcB, "startContractEventPolling").mockImplementation(() => {});

    const stopA = svcA.startAll();
    const stopB = svcB.startAll();

    expect(aHcs).toHaveBeenCalledTimes(1);
    expect(aContract).toHaveBeenCalledTimes(1);
    expect(bHcs).not.toHaveBeenCalled();
    expect(bContract).not.toHaveBeenCalled();

    stopB?.();
    stopA?.();
  });

  it("maps JobSettled payments into canonical payout + fee guard flows", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 800),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const paymentSettlementContract = makeContractMock({
      JobSettled: [
        {
          args: {
            settlementId: 3n,
            jobId: 77n,
            totalDisbursed: 400000000n,
            platformFee: 50000000n,
            reportFees: 10000000n,
            recipientCount: 1n,
          },
          blockNumber: 799,
          transactionHash: "0xsettle",
        },
      ],
    });
    paymentSettlementContract.getSettlementPayments = vi.fn(async () => ([
      {
        recipient: "0x0000000000000000000000000000000000000abc",
        basePayment: 300000000n,
        bonus: 20000000n,
        reportFee: 10000000n,
        paymentType: 2, // SUB_AUCTION
        description: "dependency payout",
      },
    ]));

    const contracts = {
      auctionContract: makeContractMock(),
      agentRegistryContract: makeContractMock(),
      subAuctionContract: makeContractMock(),
      dataMarketplaceContract: makeContractMock(),
      paymentSettlementContract,
      vaultFactoryContract: makeContractMock(),
      stakingManagerContract: makeContractMock(),
      treasuryContract: makeContractMock(),
    };

    const cfg = {
      ...config,
      contracts: { treasury: { evmAddress: "0x0000000000000000000000000000000000000fee" } },
    };
    const svc = new EventListenerService(cfg, contracts, store, provider);
    svc.lastProcessedBlock = 798;

    await svc._pollContractEvents();

    expect(paymentSettlementContract.getSettlementPayments).toHaveBeenCalledWith(3n);
    expect(store.addSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: "3", jobId: "77" })
    );
    expect(store.addGuardFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SUB_CONTRACT",
        amount: 310000000n,
        to: "0x0000000000000000000000000000000000000abc",
      })
    );
    expect(store.addGuardFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REPORT_FEE",
        amount: 10000000n,
        to: "0x0000000000000000000000000000000000000fee",
      })
    );
    expect(store.addGuardFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PLATFORM_FEE",
        amount: 50000000n,
        to: "0x0000000000000000000000000000000000000fee",
      })
    );
  });

  it("updates ingestion health counters for HCS + contract ingestion", async () => {
    const store = makeStoreSpies();
    store.activeJobs = {
      "7": { jobId: "7", auctionDeadline: 1700000100 },
    };
    const provider = {
      getBlockNumber: vi.fn(async () => 220),
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
          blockNumber: 219,
          transactionHash: "0xjobtx",
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

    expect(store.setIngestionHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        contractEventsSeen: expect.any(Number),
        activeAuctionsCount: expect.any(Number),
      })
    );

    const fetchSpy = vi.spyOn(svc, "fetchHCSMessages")
      .mockResolvedValueOnce([{ sequenceNumber: 60, timestamp: "1700000000.1", parsedData: { type: "PING" } }])
      .mockResolvedValueOnce([{ sequenceNumber: 61, timestamp: "1700000001.1", parsedData: { type: "PONG" } }]);
    await svc._pollHCSTopic("0.0.2", "auditLog");
    await svc._pollHCSTopic("0.0.2", "auditLog");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(store.setIngestionHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        hcsEventsSeen: expect.any(Number),
        lastTopicSeq: expect.objectContaining({ auditLog: 61 }),
      })
    );
  });

  it("does not advance contract cursor when critical auction queries fail", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 310),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = {
      queryFilter: vi.fn(async (event) => {
        if (event === "WinnersSelected") {
          throw new Error("rpc unavailable");
        }
        return [];
      }),
    };

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
    svc.lastProcessedBlock = 300;

    await svc._pollContractEvents();

    expect(svc.lastProcessedBlock).toBe(300);
    expect(store.setIngestionHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        contractPollError: expect.stringContaining("critical_query_failed"),
      })
    );
  });

  it("preserves existing winnersAt when contract WinnersSelected is re-observed", async () => {
    const store = makeStoreSpies();
    store.winners = {
      "77": {
        agents: ["0x00000000000000000000000000000000000000aa"],
        winnersAt: 1700000000000,
        source: "auditLog",
      },
    };
    store.setWinners = vi.fn((jobId, data) => {
      store.winners[jobId] = data;
    });
    const provider = {
      getBlockNumber: vi.fn(async () => 512),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = makeContractMock({
      WinnersSelected: [
        {
          args: {
            jobId: 77n,
            winners: ["0x00000000000000000000000000000000000000aa"],
            totalEscrowed: 100000000n,
            platformFee: 1000000n,
          },
          blockNumber: 511,
          transactionHash: "0xwinner77",
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
    svc.lastProcessedBlock = 510;
    await svc._pollContractEvents();

    expect(store.setWinners).toHaveBeenCalledWith(
      "77",
      expect.objectContaining({
        winnersAt: 1700000000000,
        source: "contract",
      })
    );
  });

  it("hydrates winners from contract polling even when events API polling fails", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => 701),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };
    const auctionContract = makeContractMock({
      WinnersSelected: [
        {
          args: {
            jobId: 91n,
            winners: ["0x00000000000000000000000000000000000000aa"],
            totalEscrowed: 150000000n,
            platformFee: 5000000n,
          },
          blockNumber: 700,
          transactionHash: "0xwinner91",
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
    svc.lastProcessedBlock = 699;
    vi.spyOn(svc, "fetchEvents").mockRejectedValue(new Error("events api unavailable"));

    await svc._pollEventsAPI();
    await svc._pollContractEvents();

    expect(store.setWinners).toHaveBeenCalledWith(
      "91",
      expect.objectContaining({
        source: "contract",
      })
    );
    expect(store.setIngestionHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        winnerSource: "contract",
      })
    );
  });

  it("skips overlapping contract polls while a prior poll is still in flight", async () => {
    const store = makeStoreSpies();
    const provider = {
      getBlockNumber: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 410;
      }),
      getBlock: vi.fn(async () => ({ timestamp: 1700000000 })),
    };

    const auctionContract = makeContractMock();
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
    svc.lastProcessedBlock = 409;

    const first = svc._pollContractEvents();
    const second = svc._pollContractEvents();
    await Promise.all([first, second]);

    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it("reads HCS/contract polling intervals from dashboard config with safe fallback", () => {
    const store = makeStoreSpies();
    const customConfig = {
      ...config,
      dashboard: {
        ...config.dashboard,
        hcsPollMs: 1300,
        contractPollMs: 1200,
      },
    };
    const invalidConfig = {
      ...config,
      dashboard: {
        ...config.dashboard,
        hcsPollMs: 10,
        contractPollMs: 50,
      },
    };

    const withCustom = new EventListenerService(customConfig, {}, store, null);
    const withInvalid = new EventListenerService(invalidConfig, {}, store, null);

    expect(withCustom.hcsPollMs).toBe(1300);
    expect(withCustom.contractPollMs).toBe(1200);
    expect(withInvalid.hcsPollMs).toBe(2000);
    expect(withInvalid.contractPollMs).toBe(2000);
  });
});
