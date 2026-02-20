import assert from "node:assert/strict";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { CONFIG } from "../src/config.js";

const ADDR_JOB = "0xfeed000000000000000000000000000000000001";
const ADDR_AGENT_A = "0x00000000000000000000000000000000000000aa";
const ADDR_AGENT_B = "0x00000000000000000000000000000000000000bb";
const ADDR_ORCH = "0x0000000000000000000000000000000000000abc";

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function makeMocks(opts = {}) {
  const {
    createAuctionShouldFail = false,
    activeBuyer = true,
    settledOnChain = false,
    activeCheckThrows = false,
    cancelDelayMs = 0,
    selectDelayMs = 0,
  } = opts;
  const auditLogMessages = [];
  const agentCommsMessages = [];
  const cancelledJobs = [];

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
        if (createAuctionShouldFail) throw new Error("forced createAuditJob failure");
        return { wait: async () => ({ logs: [{ tag: "job-posted" }] }) };
      },
      interface: {
        parseLog: () => ({ name: "JobPosted", args: { jobId: 4242n } }),
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
    getActiveJobs: async () => [],
    getJob: async () => ({
      auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 60),
      status: 0,
    }),
    dataMarketplace: {
      purchaseData: async () => {},
    },
    subAuction: {
      createSubAuction: async () => {},
      acceptResult: async () => {},
    },
    paymentSettlement: {
      settleJob: async () => {},
      isJobSettled: async () => settledOnChain,
    },
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

  return { hcs, contracts, auditLogMessages, agentCommsMessages, inft, cancelledJobs };
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

  const prevWinnerWait = CONFIG.timeouts.winnerWaitMs;
  CONFIG.timeouts.winnerWaitMs = 5;
  try {
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
    await new Promise((r) => setTimeout(r, CONFIG.timeouts.winnerWaitMs + 10));
  } finally {
    CONFIG.timeouts.winnerWaitMs = prevWinnerWait;
  }

  assert.ok(
    auditLogMessages.some(
      (m) => m.type === "JOB_FAILED" && m?.payload?.phase === "select_winners"
    ),
    "no-bid jobs should be marked as failed in no-fallback mode"
  );
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
  const { hcs, contracts, auditLogMessages } = makeMocks({ selectDelayMs: 20 });
  let selectCalls = 0;
  contracts.selectWinners = async () => {
    selectCalls += 1;
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
  assert.ok(
    auditLogMessages.some((m) => m.type === "WINNER_SELECTION_SKIPPED"),
    "single-flight winner-selection telemetry should be emitted"
  );
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
    ["discovery dedupe", testDiscoveryDedupeSkipsDuplicate],
    ["invite filter fail-closed active check", testInviteFilterFailClosedOnUnavailableActiveCheck],
    ["invite summary telemetry", testInviteSummaryTelemetry],
    ["discovery invalid address rejected", testDiscoveryRejectsInvalidAddress],
    ["strict fail-fast on create failure", testStrictFailFastOnCreateFailure],
    ["no-bid job failure", testNoBidJobFailure],
    ["reconcile closes expired active auction", testReconcileClosesExpiredActiveAuction],
    ["close expired auction single-flight", testCloseExpiredAuctionSingleflight],
    ["select winners single-flight", testSelectWinnersSingleflight],
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
