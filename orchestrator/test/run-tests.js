import assert from "node:assert/strict";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { ContractClient } from "../src/contract-client.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { CONFIG } from "../src/config.js";

const ADDR_JOB = "0xfeed000000000000000000000000000000000001";
const ADDR_AGENT_A = "0x00000000000000000000000000000000000000aa";
const ADDR_AGENT_B = "0x00000000000000000000000000000000000000bb";
const ADDR_ORCH = "0x0000000000000000000000000000000000000abc";

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMocks(opts = {}) {
  const {
    createAuctionShouldFail = false,
    createFailuresBeforeSuccess = 0,
    createAuctionErrorMessage = "forced createAuditJob failure",
    activeBuyer = true,
    settledOnChain = false,
    activeCheckThrows = false,
    cancelDelayMs = 0,
    selectDelayMs = 0,
    onChainBids = [],
  } = opts;
  const auditLogMessages = [];
  const agentCommsMessages = [];
  const cancelledJobs = [];
  const auctionListeners = new Map();
  let createCalls = 0;
  const dataMarketplace = {
    purchaseData: async () => {},
  };
  const subAuction = {
    createSubAuction: async () => {},
    acceptResult: async () => {},
  };
  const paymentSettlement = {
    settleJob: async () => {},
    isJobSettled: async () => settledOnChain,
  };

  const hcs = {
    publishAgentComms: async (msg) => agentCommsMessages.push(msg),
    publishAuditLog: async (msg) => auditLogMessages.push(msg),
    subscribeDiscovery() {},
    subscribeAgentComms() {},
    subscribeAuditLog() {},
  };

  const contracts = {
    auction: {
      createAuditJob: async () => {
        createCalls += 1;
        if (createAuctionShouldFail || createCalls <= createFailuresBeforeSuccess) {
          throw new Error(createAuctionErrorMessage);
        }
        return { wait: async () => ({ logs: [{ tag: "job-posted" }] }) };
      },
      interface: {
        parseLog: () => ({ name: "JobPosted", args: { jobId: 4242n } }),
      },
      on: (event, handler) => {
        auctionListeners.set(event, handler);
      },
      emit: async (event, ...args) => {
        const handler = auctionListeners.get(event);
        if (!handler) throw new Error(`Missing auction listener for ${event}`);
        await handler(...args);
      },
    },
    cancelJob: async (jobId) => {
      if (cancelDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, cancelDelayMs));
      cancelledJobs.push(Number(jobId));
      return { hash: "0xcancel", status: 1 };
    },
    selectWinners: async () => {
      if (selectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, selectDelayMs));
      return { hash: "0xselect", status: 1 };
    },
    getBidCount: async () => BigInt(Array.isArray(onChainBids) ? onChainBids.length : 0),
    getBidsForJob: async () => (Array.isArray(onChainBids) ? onChainBids : []),
    getActiveJobs: async () => [],
    getJob: async () => ({
      auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 60),
      status: 0,
    }),
    dataMarketplace,
    subAuction,
    paymentSettlement,
    purchaseData: async (...args) => dataMarketplace.purchaseData(...args),
    createSubAuction: async (...args) => subAuction.createSubAuction(...args),
    acceptSubResult: async (...args) => subAuction.acceptResult(...args),
    settleJob: async (...args) => paymentSettlement.settleJob(...args),
    agentRegistry: {
      isActiveAgent: async () => {
        if (activeCheckThrows) throw new Error("transient rpc failure");
        return activeBuyer;
      },
    },
    getAddress: () => ADDR_ORCH,
  };

  const inft = {
    updateReputation: async () => {},
    markJobCompleted: async () => {},
  };

  return { hcs, contracts, auditLogMessages, agentCommsMessages, inft, cancelledJobs, getCreateCalls: () => createCalls };
}

async function testAgentRegistration() {
  const log = mockLog();
  const roster = new Roster(log);
  const orch = new OrchestratorAgent({ log, roster, hcs: {}, contracts: {}, enablePing: false });

  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId: "agent-1",
    timestamp: now(),
    payload: { evmAddress: ADDR_AGENT_A, stake: 50, reputation: 70, specializations: ["dex"] },
  });

  const eligible = roster.eligibleFor("dex");
  assert.equal(eligible.length, 1, "registered agent should be eligible");
  assert.equal(eligible[0].agentId, "agent-1");
}

async function testDiscoveryInvites() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  const { hcs, contracts, agentCommsMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  const invite = agentCommsMessages.find((m) => m.type === MessageType.AUCTION_INVITE);
  assert.ok(invite, "AUCTION_INVITE should be sent");
  assert.equal(invite.payload.contractAddress, ADDR_JOB);
  assert.deepEqual(invite.payload.eligibleAgentIds, ["a1"]);
  assert.ok(typeof invite.payload.inviteBatchId === "string" && invite.payload.inviteBatchId.length > 0);
}

async function testDiscoveryDedupeSkipsDuplicate() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  const { hcs, contracts, agentCommsMessages, auditLogMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  const discovery = {
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  };

  await orch.handleDiscovery(discovery);
  await orch.handleDiscovery(discovery);

  const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
  assert.equal(invites.length, 1, "duplicate discovery should not produce another invite");
  assert.ok(auditLogMessages.some((m) => m.type === "DISCOVERY_DEDUPED"), "dedupe telemetry should be emitted");
}

async function testDiscoveryNotBlockedByStaleRehydratedJob() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  const { hcs, contracts, agentCommsMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  // Simulate startup-rehydrated stale job (expired, no observed bids).
  orch.setJobByKey("999", {
    contractAddress: ADDR_JOB,
    contractType: "lending",
    bidders: [],
    hcsBidCount: 0,
    reportPublished: false,
    settled: false,
    cancelledOnChain: false,
    terminalOnChain: false,
    rehydratedForSelection: true,
    auctionDeadlineSec: Math.floor(Date.now() / 1000) - 60,
  });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
  assert.equal(invites.length, 1, "stale rehydrated jobs must not suppress fresh invites");
}

async function testInviteFilterFailClosedOnUnavailableActiveCheck() {
  const previousRetries = process.env.ORCHESTRATOR_ACTIVE_CHECK_RETRIES;
  process.env.ORCHESTRATOR_ACTIVE_CHECK_RETRIES = "1";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    roster.upsert({
      agentId: "a1",
      evmAddress: ADDR_AGENT_A,
      stake: 50,
      reputation: 80,
      specializations: ["lending"],
    });
    const { hcs, contracts, agentCommsMessages, auditLogMessages } = makeMocks({ activeCheckThrows: true });
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

    await orch.handleDiscovery({
      type: MessageType.CONTRACT_DISCOVERED,
      agentId: "scanner",
      timestamp: now(),
      payload: {
        contractAddress: "0xfeed000000000000000000000000000000000002",
        contractType: "lending",
        budget: 100,
        riskScore: 65,
        estimatedLOC: 1400,
      },
    });

    const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
    assert.equal(invites.length, 0, "invite should be suppressed when active checks are unavailable");
    const summary = auditLogMessages.find((m) => m.type === "AUCTION_INVITE_SUMMARY");
    assert.ok(summary, "summary should still be emitted");
    assert.equal(summary.payload.excludedByReason.active_check_unavailable, 1);
  } finally {
    if (previousRetries == null) delete process.env.ORCHESTRATOR_ACTIVE_CHECK_RETRIES;
    else process.env.ORCHESTRATOR_ACTIVE_CHECK_RETRIES = previousRetries;
  }
}

async function testInviteSummaryTelemetry() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "eligible-agent",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  roster.upsert({
    agentId: "mismatch-agent",
    evmAddress: ADDR_AGENT_B,
    stake: 50,
    reputation: 80,
    specializations: ["dex"],
  });
  roster.upsert({
    agentId: "low-stake-agent",
    evmAddress: "0x00000000000000000000000000000000000000cc",
    stake: 1,
    reputation: 80,
    specializations: ["lending"],
  });
  const { hcs, contracts, auditLogMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  const summary = auditLogMessages.find((m) => m.type === "AUCTION_INVITE_SUMMARY");
  assert.ok(summary, "AUCTION_INVITE_SUMMARY should be published");
  assert.equal(summary.payload.eligibleAgents.length, 1, "expected one eligible agent");
  assert.equal(summary.payload.excludedByReason.specialization_mismatch, 1);
  assert.equal(summary.payload.excludedByReason.low_stake, 1);
}

async function testSingleInviteBatchPerJob() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  roster.upsert({
    agentId: "a2",
    evmAddress: ADDR_AGENT_B,
    stake: 55,
    reputation: 82,
    specializations: ["lending"],
  });
  const { hcs, contracts, auditLogMessages, agentCommsMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: "0xfeed0000000000000000000000000000000000aa",
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
  assert.equal(invites.length, 1, "exactly one invite batch should be published per job");
  const summaries = auditLogMessages.filter((m) => m.type === "AUCTION_INVITE_SUMMARY");
  assert.equal(summaries.length, 1, "exactly one invite summary should be published per job");
  assert.equal(
    invites[0].payload.eligibleAgentIds.length,
    summaries[0].payload.eligibleAgents.length,
    "invite batch and invite summary must report matching eligible counts"
  );
}

async function testDiscoveryRejectsInvalidAddress() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages, agentCommsMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: "0xdead",
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  assert.equal(agentCommsMessages.length, 0, "invalid discovery should not invite agents");
  assert.ok(auditLogMessages.some((m) => m.type === "DISCOVERY_REJECTED"), "invalid discovery should be logged");
}

async function testStrictFailFastOnCreateFailure() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 80,
    specializations: ["lending"],
  });
  const { hcs, contracts, agentCommsMessages, auditLogMessages } = makeMocks({ createAuctionShouldFail: true });
  const orch = new OrchestratorAgent({
    log,
    roster,
    hcs,
    contracts,
    enablePing: false,
    strictLive: true,
  });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 65,
      estimatedLOC: 1400,
    },
  });

  assert.equal(agentCommsMessages.length, 0, "strict mode must not invite after createAuditJob failure");
  assert.ok(auditLogMessages.some((m) => m.type === "ONCHAIN_TX_FAILED"), "on-chain failure should be logged");
  assert.ok(auditLogMessages.some((m) => m.type === "JOB_FAILED"), "job failure should be explicit");
}

async function testNonStrictCreateFailureNoInviteAndAbort() {
  const previousCreateRetry = {
    maxAttempts: CONFIG.createRetry.maxAttempts,
    backoffMs: CONFIG.createRetry.backoffMs,
    maxBackoffMs: CONFIG.createRetry.maxBackoffMs,
  };
  CONFIG.createRetry.maxAttempts = 2;
  CONFIG.createRetry.backoffMs = 1;
  CONFIG.createRetry.maxBackoffMs = 2;
  try {
    const log = mockLog();
    const roster = new Roster(log);
    roster.upsert({
      agentId: "a1",
      evmAddress: ADDR_AGENT_A,
      stake: 50,
      reputation: 80,
      specializations: ["lending"],
    });
    const { hcs, contracts, agentCommsMessages, auditLogMessages, getCreateCalls } = makeMocks({
      createAuctionShouldFail: true,
      createAuctionErrorMessage: "transient rpc timeout",
    });
    let selectCalls = 0;
    contracts.selectWinners = async () => {
      selectCalls += 1;
      return { hash: "0xselect", status: 1 };
    };
    const orch = new OrchestratorAgent({
      log,
      roster,
      hcs,
      contracts,
      enablePing: false,
      strictLive: false,
    });

    await orch.handleDiscovery({
      type: MessageType.CONTRACT_DISCOVERED,
      agentId: "scanner",
      timestamp: now(),
      payload: {
        contractAddress: ADDR_JOB,
        contractType: "lending",
        budget: 100,
        riskScore: 65,
        estimatedLOC: 1400,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
    assert.equal(invites.length, 0, "non-strict mode must not invite after unresolved create failure");
    assert.equal(getCreateCalls(), 2, "createAuditJob should retry up to configured max attempts");
    assert.ok(auditLogMessages.some((m) => m.type === "JOB_CREATE_RETRYING"), "retry telemetry should be emitted");
    assert.ok(auditLogMessages.some((m) => m.type === "JOB_CREATE_ABORTED"), "abort telemetry should be emitted");
    assert.equal(selectCalls, 0, "winner selection timer should not arm when create never confirms");
    assert.equal(orch.jobs.size, 0, "failed create should not leave provisional jobs in memory");
  } finally {
    CONFIG.createRetry.maxAttempts = previousCreateRetry.maxAttempts;
    CONFIG.createRetry.backoffMs = previousCreateRetry.backoffMs;
    CONFIG.createRetry.maxBackoffMs = previousCreateRetry.maxBackoffMs;
  }
}

async function testConfigEnvPropagation() {
  const keys = [
    "ORCHESTRATOR_WINNER_WAIT_MS",
    "ORCHESTRATOR_AUCTION_DURATION_MS",
    "ORCHESTRATOR_BID_FINALITY_GRACE_MS",
    "ORCHESTRATOR_MIN_AUCTION_DURATION_MS",
    "ORCHESTRATOR_CREATE_RETRY_MAX_ATTEMPTS",
    "ORCHESTRATOR_CREATE_RETRY_BACKOFF_MS",
    "ORCHESTRATOR_CREATE_RETRY_MAX_BACKOFF_MS",
    "ORCHESTRATOR_WRITE_QUEUE_MAX_HIGH_STREAK",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ORCHESTRATOR_WINNER_WAIT_MS = "91000";
  process.env.ORCHESTRATOR_AUCTION_DURATION_MS = "87000";
  process.env.ORCHESTRATOR_BID_FINALITY_GRACE_MS = "12345";
  process.env.ORCHESTRATOR_MIN_AUCTION_DURATION_MS = "86000";
  process.env.ORCHESTRATOR_CREATE_RETRY_MAX_ATTEMPTS = "7";
  process.env.ORCHESTRATOR_CREATE_RETRY_BACKOFF_MS = "222";
  process.env.ORCHESTRATOR_CREATE_RETRY_MAX_BACKOFF_MS = "7777";
  process.env.ORCHESTRATOR_WRITE_QUEUE_MAX_HIGH_STREAK = "4";
  try {
    const configModule = await import(`../src/config.js?reload=${Date.now()}`);
    const cfg = configModule.CONFIG;
    assert.equal(cfg.timeouts.winnerWaitMs, 91000, "winner wait should honor ORCHESTRATOR_WINNER_WAIT_MS");
    assert.equal(cfg.timeouts.auctionDurationMs, 87000, "auction duration should honor ORCHESTRATOR_AUCTION_DURATION_MS");
    assert.equal(cfg.timeouts.bidFinalityGraceMs, 12345, "grace should honor ORCHESTRATOR_BID_FINALITY_GRACE_MS");
    assert.equal(cfg.timeouts.minAuctionDurationMs, 86000, "min duration should honor ORCHESTRATOR_MIN_AUCTION_DURATION_MS");
    assert.equal(cfg.createRetry.maxAttempts, 7, "create retry attempts should honor env");
    assert.equal(cfg.createRetry.backoffMs, 222, "create retry backoff should honor env");
    assert.equal(cfg.createRetry.maxBackoffMs, 7777, "create retry max backoff should honor env");
    assert.equal(cfg.queue.writeQueueMaxHighStreak, 4, "write queue high-streak cap should honor env");
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function testNoBidJobFailure() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: ADDR_AGENT_A,
    stake: 50,
    reputation: 90,
    specializations: ["any"],
  });
  const { hcs, contracts, auditLogMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "vault",
      budget: 120,
      riskScore: 50,
      estimatedLOC: 1100,
    },
  });
  await orch.selectWinnersOnChain("4242");

  assert.ok(
    auditLogMessages.some(
      (m) => m.type === "JOB_FAILED" && m?.payload?.phase === "select_winners"
    ),
    "no-bid jobs should be marked as failed in no-fallback mode"
  );
}

async function testBidMatchingUsesJobId() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "agent-1",
    evmAddress: ADDR_AGENT_A,
    stake: 100,
    reputation: 90,
    specializations: ["lending"],
  });
  const { hcs, contracts } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  orch.setJobByKey("100", {
    contractAddress: ADDR_JOB,
    contractType: "lending",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
    cancelledOnChain: true,
    terminalOnChain: true,
  });
  orch.setJobByKey("101", {
    contractAddress: ADDR_JOB,
    contractType: "lending",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  orch.handleBidSubmitted({
    type: "BID_SUBMITTED",
    agentId: "agent-1",
    timestamp: now(),
    payload: {
      jobId: "101",
      contractAddress: ADDR_JOB,
      bidAmount: 12,
      collateral: 6,
      estimatedTimeSec: 200,
      reputation: 90,
      evmAddress: ADDR_AGENT_A,
    },
  });

  const staleJob = orch.getJobByKey("100");
  const activeJob = orch.getJobByKey("101");
  assert.equal(staleJob?.bidders?.length ?? 0, 0, "stale/cancelled job must not receive bid records");
  assert.equal(activeJob?.bidders?.length ?? 0, 1, "matching jobId should receive bid record");
}

async function testReconcileClosesExpiredActiveAuction() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, cancelledJobs } = makeMocks();
  contracts.getActiveJobs = async () => [4242n];
  contracts.getJob = async () => ({
    auctionDeadline: BigInt(Math.floor(Date.now() / 1000) - 5),
    status: 0, // AUCTION_OPEN
  });
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  await orch.reconcileExpiredActiveAuctions();

  assert.ok(cancelledJobs.includes(4242), "reconcile should cancel expired active job");
}

async function testTerminalAuctionNoReopenAfterCancel() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, cancelledJobs } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  const closed = await orch.closeExpiredAuction("4242", "manual_close");
  assert.equal(closed, true, "manual close should succeed");
  assert.equal(cancelledJobs.length, 1, "manual close should call cancelJob once");

  contracts.getActiveJobs = async () => [4242n];
  contracts.getJob = async () => ({
    auctionDeadline: BigInt(Math.floor(Date.now() / 1000) - 5),
    status: 2, // not AUCTION_OPEN => terminal
  });
  await orch.reconcileExpiredActiveAuctions();

  assert.equal(cancelledJobs.length, 1, "reconcile must not re-cancel already terminal jobs");
}

async function testCloseExpiredAuctionSingleflight() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, cancelledJobs, auditLogMessages } = makeMocks({ cancelDelayMs: 20 });
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  const [first, second] = await Promise.all([
    orch.closeExpiredAuction("4242", "test_singleflight"),
    orch.closeExpiredAuction("4242", "test_singleflight"),
  ]);

  assert.equal(first, true, "first close should succeed");
  assert.equal(second, true, "second close should share the in-flight result");
  assert.equal(cancelledJobs.length, 1, "single-flight should issue only one cancel tx");
  assert.ok(
    auditLogMessages.some((m) => m.type === "AUCTION_CLOSE_SKIPPED"),
    "single-flight skip telemetry should be emitted"
  );
}

async function testSelectWinnersSingleflight() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({
    selectDelayMs: 20,
    onChainBids: [
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 1n,
      },
    ],
  });
  let selectCalls = 0;
  let selectedIndices = [];
  contracts.selectWinners = async (_jobId, winningBidIndices = []) => {
    selectCalls += 1;
    selectedIndices = Array.isArray(winningBidIndices) ? [...winningBidIndices] : [];
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { hash: "0xselect", status: 1 };
  };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [
      {
        agentId: "agent-1",
        evmAddress: ADDR_AGENT_A,
        bidAmount: 10,
        estimatedTimeSec: 100,
        reputation: 90,
      },
    ],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  await Promise.all([
    orch.selectWinnersOnChain("4242"),
    orch.selectWinnersOnChain("4242"),
  ]);

  assert.equal(selectCalls, 1, "single-flight should issue one selectWinners tx");
  assert.equal(selectedIndices.length, 1, "winner selection should submit exactly one winning bid index");
  assert.ok(
    auditLogMessages.some((m) => m.type === "WINNER_SELECTION_SKIPPED"),
    "single-flight winner-selection telemetry should be emitted"
  );
}

async function testImmediateWinnerAuditLogAndDeduping() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({
    onChainBids: [
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 1n,
      },
    ],
  });
  contracts.selectWinners = async () => ({ hash: "0xselectwinner", status: 1 });

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [
      {
        agentId: "agent-1",
        evmAddress: ADDR_AGENT_A,
        bidAmount: 10,
        estimatedTimeSec: 100,
        reputation: 90,
      },
    ],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  await orch.selectWinnersOnChain("4242");

  const immediateWinnerLogs = auditLogMessages.filter((m) => m.type === "WINNER_SELECTED");
  assert.equal(immediateWinnerLogs.length, 1, "winner should be published immediately after selectWinners tx");
  assert.equal(immediateWinnerLogs[0]?.payload?.txHash, "0xselectwinner");

  orch.subscribeContractEvents();
  await contracts.auction.emit(
    "WinnersSelected",
    4242n,
    [ADDR_AGENT_A],
    1000000000n,
    50000000n,
    { transactionHash: "0xselectwinner" }
  );

  const dedupedWinnerLogs = auditLogMessages.filter((m) => m.type === "WINNER_SELECTED");
  assert.equal(dedupedWinnerLogs.length, 1, "duplicate winner announcements should be deduped");
}

async function testSelectWinnersUsesOnChainBidIndexMapping() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "agent-a",
    evmAddress: ADDR_AGENT_A,
    stake: 100,
    reputation: 90,
    specializations: ["vault"],
  });
  roster.upsert({
    agentId: "agent-b",
    evmAddress: ADDR_AGENT_B,
    stake: 100,
    reputation: 40,
    specializations: ["vault"],
  });

  const { hcs, contracts } = makeMocks({
    onChainBids: [
      {
        agent: ADDR_AGENT_B,
        bidAmount: 2000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 40n,
        estimatedCompletionTime: 300n,
        timestamp: 1n,
      },
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 2n,
      },
    ],
  });
  let selectedIndices = [];
  contracts.selectWinners = async (_jobId, winningBidIndices = []) => {
    selectedIndices = [...winningBidIndices];
    return { hash: "0xselect", status: 1 };
  };

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [
      {
        agentId: "agent-a",
        evmAddress: ADDR_AGENT_A,
        bidAmount: 10,
        estimatedTimeSec: 100,
        reputation: 90,
      },
    ],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  await orch.selectWinnersOnChain("4242");

  assert.deepEqual(selectedIndices, [1], "winner selection should submit on-chain bid index for selected winner");
}

async function testSelectWinnersIgnoresLocalGhostBidsWhenOnChainEmpty() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, cancelledJobs } = makeMocks({ onChainBids: [] });
  let selectCalls = 0;
  contracts.selectWinners = async () => {
    selectCalls += 1;
    return { hash: "0xselect", status: 1 };
  };

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [
      {
        agentId: "ghost-agent",
        evmAddress: ADDR_AGENT_A,
        bidAmount: 10,
        estimatedTimeSec: 100,
        reputation: 90,
      },
    ],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  await orch.selectWinnersOnChain("4242");

  assert.equal(selectCalls, 0, "should not select winners from local-only bids when on-chain bid list is empty");
  assert.ok(cancelledJobs.includes(4242), "no on-chain bids should trigger cancel path");
}

async function testSelectWinnersHydratesMissingJobFromChain() {
  const previousRehydrate = process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION;
  process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION = "true";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts } = makeMocks({
      onChainBids: [
        {
          agent: ADDR_AGENT_A,
          bidAmount: 1000000000n,
          collateralLocked: 5000000000n,
          reputationAtBid: 90n,
          estimatedCompletionTime: 100n,
          timestamp: 1n,
        },
      ],
    });
    let selectCalls = 0;
    contracts.selectWinners = async () => {
      selectCalls += 1;
      return { hash: "0xselect", status: 1 };
    };
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

    await orch.selectWinnersOnChain("4242", { path: "reconcile" });

    assert.equal(selectCalls, 1, "missing in-memory job should be hydrated and selected");
    assert.ok(orch.getJobByKey("4242"), "hydrated job should be persisted in memory");
  } finally {
    if (previousRehydrate == null) delete process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION;
    else process.env.ORCHESTRATOR_REHYDRATE_MISSING_JOB_FOR_SELECTION = previousRehydrate;
  }
}

async function testReconcileSelectCapRespected() {
  const previousCap = process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE;
  process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE = "1";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts } = makeMocks({
      onChainBids: [
        {
          agent: ADDR_AGENT_A,
          bidAmount: 1000000000n,
          collateralLocked: 5000000000n,
          reputationAtBid: 90n,
          estimatedCompletionTime: 100n,
          timestamp: 1n,
        },
      ],
    });
    contracts.getActiveJobs = async () => [4242n, 4243n];
    contracts.getJob = async () => ({
      auctionDeadline: BigInt(Math.floor(Date.now() / 1000) - 3),
      status: 0,
    });
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
    const calls = [];
    orch.requestWinnerSelection = async (jobId, opts = {}) => {
      calls.push({ jobId: String(jobId), sourcePath: opts.sourcePath ?? "" });
    };

    await orch.reconcileExpiredActiveAuctions();

    assert.equal(calls.length, 1, "reconcile must honor max selects per cycle cap");
    assert.equal(calls[0].sourcePath, "reconcile", "reconcile-triggered selection should carry reconcile source");
  } finally {
    if (previousCap == null) delete process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE;
    else process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE = previousCap;
  }
}

async function testReconcileInspectionWindowRotation() {
  const previousInspectCap = process.env.ORCHESTRATOR_RECONCILE_MAX_INSPECT_PER_CYCLE;
  const previousSelectCap = process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE;
  const previousCloseCap = process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE;
  process.env.ORCHESTRATOR_RECONCILE_MAX_INSPECT_PER_CYCLE = "2";
  process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE = "10";
  process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE = "10";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts } = makeMocks({ onChainBids: [] });
    contracts.getActiveJobs = async () => [5001n, 5002n, 5003n];
    const inspected = [];
    contracts.getJob = async (jobId) => {
      inspected.push(Number(jobId));
      return {
        auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 120),
        status: 0,
      };
    };
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

    await orch.reconcileExpiredActiveAuctions();
    await orch.reconcileExpiredActiveAuctions();

    assert.deepEqual(
      inspected.slice(0, 2),
      [5001, 5002],
      "first reconcile cycle should inspect only first two active jobs"
    );
    assert.deepEqual(
      inspected.slice(2, 4),
      [5003, 5001],
      "second reconcile cycle should rotate inspection window"
    );
  } finally {
    if (previousInspectCap == null) delete process.env.ORCHESTRATOR_RECONCILE_MAX_INSPECT_PER_CYCLE;
    else process.env.ORCHESTRATOR_RECONCILE_MAX_INSPECT_PER_CYCLE = previousInspectCap;
    if (previousSelectCap == null) delete process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE;
    else process.env.ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE = previousSelectCap;
    if (previousCloseCap == null) delete process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE;
    else process.env.ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE = previousCloseCap;
  }
}

async function testWinnerSelectionTimingTelemetry() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({
    onChainBids: [
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 1n,
      },
    ],
  });
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
    auctionDeadlineSec: Math.floor(Date.now() / 1000) - 1,
    winnerSelectionScheduledAt: Date.now() - 1500,
  });

  await orch.selectWinnersOnChain("4242", { path: "timer" });

  const timing = auditLogMessages.find((m) => m.type === "WINNER_SELECTION_TIMING");
  assert.ok(timing, "winner timing telemetry should be emitted");
  assert.equal(timing.payload.path, "timer");
  assert.equal(timing.payload.result, "success");
  assert.ok(Number(timing.payload.attempts) >= 1, "timing telemetry should include attempts");
}

async function testReportPublishedPreDeadlineDefersAndRearms() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({
    onChainBids: [
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 1n,
      },
    ],
  });
  const futureDeadlineSec = Math.floor(Date.now() / 1000) + 45;
  contracts.getJob = async () => ({
    status: 0,
    auctionDeadline: BigInt(futureDeadlineSec),
    contractAddress: ADDR_JOB,
    contractType: "vault",
  });
  let selectCalls = 0;
  contracts.selectWinners = async () => {
    selectCalls += 1;
    return { hash: "0xselect", status: 1 };
  };

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
    auctionDeadlineSec: futureDeadlineSec,
  });

  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: "4242", totalFindings: 0, criticalFindings: 0, reportHash: "0xrep" },
  });
  await sleep(25);

  assert.equal(selectCalls, 0, "report-published path must not select before deadline");
  assert.ok(orch.winnerSelectionTimers.has("4242"), "deferred report trigger should re-arm winner timer");
  const deferred = auditLogMessages.find((m) => m.type === "WINNER_SELECTION_DEFERRED");
  assert.ok(deferred, "deferred telemetry should be emitted");
  assert.equal(deferred?.payload?.reasonCode, "deadline_not_reached");
  orch.clearWinnerSelectionTimer("4242");
}

async function testReportPublishedPostDeadlineWithBidsSelects() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({
    onChainBids: [
      {
        agent: ADDR_AGENT_A,
        bidAmount: 1000000000n,
        collateralLocked: 5000000000n,
        reputationAtBid: 90n,
        estimatedCompletionTime: 100n,
        timestamp: 1n,
      },
    ],
  });
  const pastDeadlineSec = Math.floor(Date.now() / 1000) - 5;
  contracts.getJob = async () => ({
    status: 0,
    auctionDeadline: BigInt(pastDeadlineSec),
    contractAddress: ADDR_JOB,
    contractType: "vault",
  });
  let selectCalls = 0;
  contracts.selectWinners = async () => {
    selectCalls += 1;
    return { hash: "0xselect", status: 1 };
  };

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
    auctionDeadlineSec: pastDeadlineSec,
  });

  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: "4242", totalFindings: 0, criticalFindings: 0, reportHash: "0xrep" },
  });
  await sleep(25);

  assert.equal(selectCalls, 1, "report-published path should select after deadline when bids exist");
  assert.ok(
    !auditLogMessages.some(
      (m) => m.type === "WINNER_SELECTION_DEFERRED" && m?.payload?.reasonCode === "deadline_not_reached"
    ),
    "post-deadline report flow should not be deferred for deadline"
  );
}

async function testReportPublishedPostDeadlineNoBidsCancels() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, cancelledJobs, auditLogMessages } = makeMocks({ onChainBids: [] });
  const pastDeadlineSec = Math.floor(Date.now() / 1000) - 5;
  contracts.getJob = async () => ({
    status: 0,
    auctionDeadline: BigInt(pastDeadlineSec),
    contractAddress: ADDR_JOB,
    contractType: "vault",
  });
  let selectCalls = 0;
  contracts.selectWinners = async () => {
    selectCalls += 1;
    return { hash: "0xselect", status: 1 };
  };

  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "vault",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
    auctionDeadlineSec: pastDeadlineSec,
  });

  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: "4242", totalFindings: 0, criticalFindings: 0, reportHash: "0xrep" },
  });
  await sleep(25);

  assert.equal(selectCalls, 0, "report-published path should skip selection when no on-chain bids");
  assert.ok(cancelledJobs.includes(4242), "post-deadline/no-bid report flow should cancel expired job");
  const deferred = auditLogMessages.find((m) => m.type === "WINNER_SELECTION_DEFERRED");
  assert.ok(deferred, "deferred telemetry should exist for no-bid path");
  assert.equal(deferred?.payload?.reasonCode, "no_onchain_bids");
}

async function testWinnerSelectionPriorityOnlyWhenReady() {
  const previousFastPath = process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED;
  process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED = "true";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts, auditLogMessages } = makeMocks({
      onChainBids: [
        {
          agent: ADDR_AGENT_A,
          bidAmount: 1000000000n,
          collateralLocked: 5000000000n,
          reputationAtBid: 90n,
          estimatedCompletionTime: 100n,
          timestamp: 1n,
        },
      ],
    });
    const nowSec = Math.floor(Date.now() / 1000);
    contracts.getJob = async (jobId) => {
      const numericJobId = Number(jobId);
      if (numericJobId === 4243) {
        return {
          status: 0,
          auctionDeadline: BigInt(nowSec + 60),
          contractAddress: ADDR_JOB,
          contractType: "vault",
        };
      }
      return {
        status: 0,
        auctionDeadline: BigInt(nowSec - 5),
        contractAddress: ADDR_JOB,
        contractType: "vault",
      };
    };
    const usedPriorities = [];
    contracts.selectWinners = async (_jobId, _indices, opts = {}) => {
      usedPriorities.push(opts.priority ?? "normal");
      return { hash: "0xselect", status: 1 };
    };

    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });
    orch.setJobByKey("4242", {
      contractAddress: ADDR_JOB,
      contractType: "vault",
      bidders: [],
      winners: [],
      findings: [],
      reportPublished: false,
      auctionDeadlineSec: nowSec - 5,
    });
    orch.setJobByKey("4243", {
      contractAddress: ADDR_JOB,
      contractType: "vault",
      bidders: [],
      winners: [],
      findings: [],
      reportPublished: false,
      auctionDeadlineSec: nowSec + 60,
    });

    await orch.requestWinnerSelection("4242", { sourcePath: "reconcile" });
    await orch.requestWinnerSelection("4243", { sourcePath: "report_published" });
    await sleep(20);

    assert.deepEqual(
      usedPriorities,
      ["high"],
      "high priority should only be used when selection is ready (closed + bids)"
    );
    const successTiming = auditLogMessages.find(
      (m) => m.type === "WINNER_SELECTION_TIMING" && m?.payload?.jobId === "4242" && m?.payload?.result === "success"
    );
    assert.ok(successTiming, "ready path should emit winner timing telemetry");
    assert.equal(successTiming?.payload?.priorityUsed, "high");
    const deferredTiming = auditLogMessages.find(
      (m) => m.type === "WINNER_SELECTION_TIMING" && m?.payload?.jobId === "4243" && m?.payload?.result === "deferred"
    );
    assert.ok(deferredTiming, "not-ready path should emit deferred timing telemetry");
    assert.equal(deferredTiming?.payload?.suppressedReason, "deadline_not_reached");
    orch.clearWinnerSelectionTimer("4243");
  } finally {
    if (previousFastPath == null) delete process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED;
    else process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED = previousFastPath;
  }
}

async function testContractClientPriorityDefaults() {
  const client = Object.create(ContractClient.prototype);
  const priorities = [];
  client._enqueueWriteWithPriority = async (_sendFn, priority = "normal") => {
    priorities.push(priority);
    return { wait: async () => ({ hash: "0xok", status: 1 }) };
  };
  client.auction = {
    createAuditJob: async () => ({ hash: "0xcreate" }),
    selectWinners: async () => ({ hash: "0xselect" }),
    cancelJob: async () => ({ hash: "0xcancel" }),
  };

  await client.createAuditJob(ADDR_JOB, "hedera-testnet", "vault", 50, 1000n, 1000, 120);
  await client.cancelJob(4242);
  await client.selectWinners(4242, [0]);
  await client.selectWinners(4242, [0], { priority: "high" });
  await client.cancelJob(4242, { priority: "high" });

  assert.deepEqual(
    priorities,
    ["normal", "normal", "normal", "high", "high"],
    "contract client should default cancel/select to normal and require explicit high override"
  );
}

async function testContractClientWriteQueueFairness() {
  const queueHarness = Object.create(ContractClient.prototype);
  queueHarness.fastWinnerPathEnabled = true;
  queueHarness.writeQueueMaxHighStreak = 2;
  queueHarness._writeQueue = [];
  queueHarness._writeQueueRunning = false;
  queueHarness._highPriorityStreak = 0;

  const order = [];
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const tasks = [
    queueHarness._enqueueWriteWithPriority(async () => {
      await gate;
      order.push("H1");
    }, "high"),
    queueHarness._enqueueWriteWithPriority(async () => {
      order.push("H2");
    }, "high"),
    queueHarness._enqueueWriteWithPriority(async () => {
      order.push("N1");
    }, "normal"),
    queueHarness._enqueueWriteWithPriority(async () => {
      order.push("H3");
    }, "high"),
    queueHarness._enqueueWriteWithPriority(async () => {
      order.push("H4");
    }, "high"),
  ];

  await sleep(5);
  releaseGate();
  await Promise.all(tasks);

  assert.deepEqual(
    order,
    ["H1", "H2", "N1", "H3", "H4"],
    "queue fairness must interleave a normal task after high-streak cap is reached"
  );
}

async function testStartupWinnerRearmSchedulesTimers() {
  const previousRearm = process.env.ORCHESTRATOR_STARTUP_WINNER_REARM;
  process.env.ORCHESTRATOR_STARTUP_WINNER_REARM = "true";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts } = makeMocks();
    contracts.getActiveJobs = async () => [4242n];
    contracts.getJob = async () => ({
      status: 0,
      auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 30),
      contractAddress: ADDR_JOB,
      contractType: "lending",
    });
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

    await orch.bootstrapWinnerSelectionFromActiveJobs();

    assert.ok(orch.getJobByKey("4242"), "startup re-arm should hydrate active on-chain jobs");
    assert.ok(orch.winnerSelectionTimers.has("4242"), "startup re-arm should schedule winner selection timer");
    orch.clearWinnerSelectionTimer("4242");
  } finally {
    if (previousRearm == null) delete process.env.ORCHESTRATOR_STARTUP_WINNER_REARM;
    else process.env.ORCHESTRATOR_STARTUP_WINNER_REARM = previousRearm;
  }
}

async function testStartupWinnerRearmSkipsExpiredJobs() {
  const previousRearm = process.env.ORCHESTRATOR_STARTUP_WINNER_REARM;
  process.env.ORCHESTRATOR_STARTUP_WINNER_REARM = "true";
  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts } = makeMocks();
    const nowSec = Math.floor(Date.now() / 1000);
    contracts.getActiveJobs = async () => [4242n, 4243n];
    contracts.getJob = async (jobId) => {
      if (Number(jobId) === 4242) {
        return {
          status: 0,
          auctionDeadline: BigInt(nowSec - 5),
          contractAddress: ADDR_JOB,
          contractType: "lending",
        };
      }
      return {
        status: 0,
        auctionDeadline: BigInt(nowSec + 30),
        contractAddress: ADDR_JOB,
        contractType: "lending",
      };
    };
    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

    await orch.bootstrapWinnerSelectionFromActiveJobs();

    assert.ok(orch.winnerSelectionTimers.has("4243"), "future active job should be re-armed on startup");
    assert.ok(!orch.winnerSelectionTimers.has("4242"), "expired active job should not be re-armed on startup");
    orch.clearWinnerSelectionTimer("4243");
  } finally {
    if (previousRearm == null) delete process.env.ORCHESTRATOR_STARTUP_WINNER_REARM;
    else process.env.ORCHESTRATOR_STARTUP_WINNER_REARM = previousRearm;
  }
}

async function testAutoBuyDataListing() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({ activeBuyer: true });
  let purchaseCalled = false;
  contracts.dataMarketplace.purchaseData = async () => {
    purchaseCalled = true;
  };
  const orch = new OrchestratorAgent({
    log,
    roster,
    hcs,
    contracts,
    enablePing: false,
    strictLive: true,
  });

  await orch.handleDataListing({
    type: MessageType.DATA_LISTING_CREATED,
    agentId: "static",
    timestamp: now(),
    payload: { listingId: "1", category: "SCAN_REPORT", price: 0.5, jobId: "4242" },
  });

  assert.ok(purchaseCalled, "should auto-buy when orchestrator buyer is active");
  assert.ok(auditLogMessages.some((m) => m.type === "DATA_PURCHASED"), "purchase should be logged");
}

async function testAutoBuySkippedForInactiveBuyer() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({ activeBuyer: false });
  let purchaseCalled = false;
  contracts.dataMarketplace.purchaseData = async () => {
    purchaseCalled = true;
  };
  const orch = new OrchestratorAgent({
    log,
    roster,
    hcs,
    contracts,
    enablePing: false,
    strictLive: true,
  });

  await orch.handleDataListing({
    type: MessageType.DATA_LISTING_CREATED,
    agentId: "static",
    timestamp: now(),
    payload: { listingId: "1", category: "SCAN_REPORT", price: 0.5, jobId: "4242" },
  });

  assert.equal(purchaseCalled, false, "strict mode must skip auto-buy for inactive buyer");
  assert.ok(auditLogMessages.some((m) => m.type === "DATA_PURCHASE_SKIPPED"), "skip should be logged");
}

async function testCreateSubAuctionAndAcceptResult() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let created = false;
  let accepted = false;
  contracts.subAuction.createSubAuction = async () => {
    created = true;
  };
  contracts.subAuction.acceptResult = async () => {
    accepted = true;
  };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleSubAuctionRequest({
    type: MessageType.SUB_AUCTION_POSTED,
    agentId: "llm",
    timestamp: now(),
    payload: { parentJobId: "42", taskType: "dependency_analysis", paymentAmount: 2 },
  });
  await orch.handleSubResult({
    type: MessageType.SUB_RESULT_DELIVERED,
    agentId: "dependency",
    timestamp: now(),
    payload: { subAuctionId: "7" },
  });

  assert.ok(created, "should call createSubAuction");
  assert.ok(accepted, "should call acceptResult");
  assert.ok(auditLogMessages.some((m) => m.type === "SUB_AUCTION_CREATED"), "sub-auction should be logged");
  assert.ok(auditLogMessages.some((m) => m.type === "SUB_RESULT_ACCEPTED"), "sub-result should be logged");
}

async function testSettlementOnReport() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages, inft } = makeMocks();
  let settled = false;
  let repUpdates = 0;
  contracts.paymentSettlement.settleJob = async () => {
    settled = true;
  };
  inft.updateReputation = async () => {
    repUpdates += 1;
  };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, inft, enablePing: false });

  orch.jobs.set("99", {
    findings: [],
    winners: [ADDR_ORCH],
    bidders: [],
    reportPublished: false,
    settled: false,
  });

  await orch.handleFindings({
    type: MessageType.FINDINGS_SUBMITTED,
    agentId: "static",
    timestamp: now(),
    payload: {
      jobId: "99",
      findingsHash: "0xhash",
      evmAddress: ADDR_ORCH,
      findingsCount: 2,
      criticalCount: 1,
    },
  });
  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: "99", totalFindings: 2, criticalFindings: 1, reportHash: "0xrep" },
  });

  assert.ok(settled, "should settle on report publication");
  assert.ok(auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "settlement should be logged");
  assert.ok(auditLogMessages.some((m) => m.type === "ALERT_FIRED"), "alert should be logged for critical");
  assert.equal(repUpdates, 1, "reputation hook should be called");
}

async function testSkipSettlementWhenAlreadySettled() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks({ settledOnChain: true });
  let settleCalls = 0;
  contracts.paymentSettlement.settleJob = async () => {
    settleCalls += 1;
  };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  orch.jobs.set("777", {
    winners: [ADDR_ORCH],
    findings: [
      {
        agentId: "static",
        evmAddress: ADDR_ORCH,
        findingsCount: 2,
        criticalCount: 0,
        findingsHash: "0xhash",
      },
    ],
    reportPublished: false,
    settled: false,
  });

  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: "777", totalFindings: 2, criticalFindings: 0, reportHash: "0xrep" },
  });

  assert.equal(settleCalls, 0, "should not settle if already settled on-chain");
  assert.ok(!auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "no settlement log expected");
}

async function run() {
  const tests = [
    ["agent registration", testAgentRegistration],
    ["discovery invites", testDiscoveryInvites],
    ["single invite batch per job", testSingleInviteBatchPerJob],
    ["discovery dedupe", testDiscoveryDedupeSkipsDuplicate],
    ["discovery ignores stale rehydrated dedupe blockers", testDiscoveryNotBlockedByStaleRehydratedJob],
    ["invite filter fail-closed active check", testInviteFilterFailClosedOnUnavailableActiveCheck],
    ["invite summary telemetry", testInviteSummaryTelemetry],
    ["discovery invalid address rejected", testDiscoveryRejectsInvalidAddress],
    ["config env propagation", testConfigEnvPropagation],
    ["strict fail-fast on create failure", testStrictFailFastOnCreateFailure],
    ["non-strict create failure no invite and abort", testNonStrictCreateFailureNoInviteAndAbort],
    ["no-bid job failure", testNoBidJobFailure],
    ["bid matching uses jobId", testBidMatchingUsesJobId],
    ["reconcile closes expired active auction", testReconcileClosesExpiredActiveAuction],
    ["terminal auction no reopen after cancel", testTerminalAuctionNoReopenAfterCancel],
    ["close expired auction single-flight", testCloseExpiredAuctionSingleflight],
    ["select winners single-flight", testSelectWinnersSingleflight],
    ["winner selected immediate publish + dedupe", testImmediateWinnerAuditLogAndDeduping],
    ["select winners uses on-chain bid index mapping", testSelectWinnersUsesOnChainBidIndexMapping],
    ["select winners ignores local ghost bids when on-chain empty", testSelectWinnersIgnoresLocalGhostBidsWhenOnChainEmpty],
    ["select winners hydrates missing job from chain", testSelectWinnersHydratesMissingJobFromChain],
    ["reconcile select cap respected", testReconcileSelectCapRespected],
    ["reconcile inspection window rotation", testReconcileInspectionWindowRotation],
    ["winner selection timing telemetry", testWinnerSelectionTimingTelemetry],
    ["report published pre-deadline defers and re-arms", testReportPublishedPreDeadlineDefersAndRearms],
    ["report published post-deadline with bids selects", testReportPublishedPostDeadlineWithBidsSelects],
    ["report published post-deadline no-bids cancels", testReportPublishedPostDeadlineNoBidsCancels],
    ["winner priority only when selection-ready", testWinnerSelectionPriorityOnlyWhenReady],
    ["contract client priority defaults", testContractClientPriorityDefaults],
    ["contract client write-queue fairness", testContractClientWriteQueueFairness],
    ["startup winner rearm schedules timers", testStartupWinnerRearmSchedulesTimers],
    ["startup winner rearm skips expired jobs", testStartupWinnerRearmSkipsExpiredJobs],
    ["auto-buy data listing", testAutoBuyDataListing],
    ["auto-buy skipped inactive buyer", testAutoBuySkippedForInactiveBuyer],
    ["create sub-auction and accept result", testCreateSubAuctionAndAcceptResult],
    ["settlement/report/alert", testSettlementOnReport],
    ["skip settlement when already settled", testSkipSettlementWhenAlreadySettled],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`❌ ${name} — ${err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  if (passed !== tests.length) process.exit(1);
}

run();
