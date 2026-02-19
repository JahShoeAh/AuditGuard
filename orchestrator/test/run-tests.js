// Minimal test harness using built-in assert to avoid external deps.
import assert from "node:assert/strict";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { CONFIG } from "../src/config.js";

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function makeMocks() {
  const auditLogMessages = [];
  const agentCommsMessages = [];
  const hcs = {
    publishAgentComms: async (msg) => agentCommsMessages.push(msg),
    publishAuditLog: async (msg) => auditLogMessages.push(msg),
    subscribeDiscovery() {},
    subscribeAgentComms() {},
    subscribeAuditLog() {},
  };
  const contracts = {
    auction: { createJob: async () => {} },
    dataMarketplace: { purchaseData: async () => {} },
    subAuction: { createSubAuction: async () => {}, acceptResult: async () => {} },
    paymentSettlement: { settleJob: async () => {} },
    getAddress: () => "0x0000000000000000000000000000000000000abc",
  };
  const inft = { updateReputation: async () => {}, markJobCompleted: async () => {} };
  return { hcs, contracts, auditLogMessages, agentCommsMessages, inft };
}

async function testAgentRegistration() {
  const log = mockLog();
  const roster = new Roster(log);
  const orch = new OrchestratorAgent({ log, roster, hcs: {}, contracts: {}, enablePing: false });

  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId: "agent-1",
    timestamp: now(),
    payload: { evmAddress: "0xabc", stake: 50, reputation: 70, specializations: ["dex"] },
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
    evmAddress: "0x1",
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
    payload: { contractAddress: "0xdead", contractType: "lending", budget: 0 },
  });

  assert.ok(agentCommsMessages.length > 0, "should publish invites");
  const invite = agentCommsMessages.find((m) => m.type === MessageType.AUCTION_INVITE);
  assert.ok(invite, "AUCTION_INVITE should be sent");
  assert.equal(invite.payload.contractAddress, "0xdead");
}

async function testFallbackWinners() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "a1",
    evmAddress: "0x1",
    stake: 50,
    reputation: 90,
    specializations: ["any"],
  });
  const { hcs, contracts, auditLogMessages } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  // shorten timeout for test
  CONFIG.timeouts.winnerWaitMs = 5;

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: { contractAddress: "0xjob", contractType: "vault", budget: 0 },
  });

  await new Promise((r) => setTimeout(r, CONFIG.timeouts.winnerWaitMs + 5));

  assert.ok(
    auditLogMessages.some((m) => m.type === MessageType.WINNERS_SELECTED_FALLBACK),
    "fallback winners should be published"
  );
}

async function testAutoBuyDataListing() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  const purchaseSpy = contracts.dataMarketplace.purchaseData = async () => { purchaseSpy.called = true; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDataListing({
    type: MessageType.DATA_LISTING_CREATED,
    agentId: "static",
    timestamp: now(),
    payload: { listingId: 1, category: "SCAN_REPORT", price: 0.5, jobId: "job-1" },
  });

  assert.ok(purchaseSpy.called, "should auto-buy cheap listing");
  assert.ok(auditLogMessages.some((m) => m.type === "DATA_PURCHASED"), "logs purchase");
}

async function testCreateSubAuction() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let created = false;
  contracts.subAuction.createSubAuction = async () => { created = true; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleSubAuctionRequest({
    type: MessageType.SUB_AUCTION_POSTED,
    agentId: "llm",
    timestamp: now(),
    payload: { parentJobId: 42, taskType: "dependency_analysis", paymentAmount: 2 },
  });

  assert.ok(created, "should call createSubAuction");
  assert.ok(auditLogMessages.some((m) => m.type === "SUB_AUCTION_CREATED"), "logs sub-auction");
}

async function testAcceptSubResult() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let accepted = false;
  contracts.subAuction.acceptResult = async () => { accepted = true; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleSubResult({
    type: MessageType.SUB_RESULT_DELIVERED,
    agentId: "dependency",
    timestamp: now(),
    payload: { subAuctionId: 7 },
  });

  assert.ok(accepted, "should accept sub-auction result");
  assert.ok(auditLogMessages.some((m) => m.type === "SUB_RESULT_ACCEPTED"), "logs acceptance");
}

async function testSettlementOnFindings() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages, inft } = makeMocks();
  let settled = false;
  contracts.paymentSettlement.settleJob = async () => { settled = true; };
  let repUpdates = 0;
  inft.updateReputation = async () => { repUpdates++; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, inft, enablePing: false });

  orch.jobs.set(99, {
    findings: [],
    winners: ["0x0000000000000000000000000000000000000abc"],
    bidders: [],
    reportPublished: false,
    settled: false,
  });

  // Findings alone should not trigger settlement now
  await orch.handleFindings({
    type: MessageType.FINDINGS_SUBMITTED,
    agentId: "static",
    timestamp: now(),
    payload: {
      jobId: 99,
      findingsHash: "0xhash",
      evmAddress: "0x0000000000000000000000000000000000000abc",
      findingsCount: 2,
      criticalCount: 1
    },
  });

  // Settlement happens when Report Agent publishes the report
  // Simulate auditLog relay of REPORT_PUBLISHED
  await orch.handleReportPublished({
    type: MessageType.AUDIT_LOG,
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId: 99, totalFindings: 2, criticalFindings: 1, reportHash: "0xrep" },
  });

  assert.ok(settled, "should call settleJob");
  assert.ok(auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "logs settlement");
  assert.ok(auditLogMessages.some((m) => m.type === "REPORT_PUBLISHED"), "publishes report");
  assert.ok(auditLogMessages.some((m) => m.type === "REPUTATION_UPDATED"), "updates reputation");
  assert.ok(auditLogMessages.some((m) => m.type === "ALERT_FIRED"), "fires alert on critical");
  assert.equal(repUpdates, 1, "calls inft reputation hook");
}

async function testBidSubmissionValidation() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  const jobId = 555;
  orch.jobs.set(jobId, {
    contractAddress: "0xfeed000000000000000000000000000000000001",
    contractType: "lending",
    bidders: [],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  // Agent below min stake should be rejected.
  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId: "low-stake",
    timestamp: now(),
    payload: {
      evmAddress: "0x00000000000000000000000000000000000000aa",
      stake: 1,
      reputation: 90,
      specializations: ["lending"],
    },
  });
  orch.handleBidSubmitted({
    type: "BID_SUBMITTED",
    agentId: "low-stake",
    timestamp: now(),
    payload: {
      contractAddress: "0xfeed000000000000000000000000000000000001",
      bidAmount: 10,
      collateral: 2,
      estimatedTimeSec: 120,
      reputation: 90,
      evmAddress: "0x00000000000000000000000000000000000000aa",
    },
  });
  assert.equal(orch.jobs.get(jobId).bidders.length, 0, "low-stake bid should be rejected");

  // Valid agent and valid bid should be recorded.
  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId: "good-agent",
    timestamp: now(),
    payload: {
      evmAddress: "0x00000000000000000000000000000000000000bb",
      stake: 50,
      reputation: 80,
      specializations: ["lending"],
    },
  });
  orch.handleBidSubmitted({
    type: "BID_SUBMITTED",
    agentId: "good-agent",
    timestamp: now(),
    payload: {
      contractAddress: "0xfeed000000000000000000000000000000000001",
      bidAmount: 15,
      collateral: 4,
      estimatedTimeSec: 90,
      reputation: 80,
      evmAddress: "0x00000000000000000000000000000000000000bb",
    },
  });
  assert.equal(orch.jobs.get(jobId).bidders.length, 1, "valid bid should be recorded");
}

async function testSkipSettlementWhenAlreadySettledOnChain() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let settleCalls = 0;
  contracts.paymentSettlement.isJobSettled = async () => true;
  contracts.paymentSettlement.settleJob = async () => { settleCalls++; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  const jobId = 777;
  const winner = "0x0000000000000000000000000000000000000abc";
  const job = {
    winners: [winner],
    findings: [
      {
        agentId: "static",
        evmAddress: winner,
        findingsCount: 2,
        criticalCount: 0,
        findingsHash: "0xhash",
      },
    ],
    reportPublished: false,
    settled: false,
  };
  orch.jobs.set(jobId, job);

  await orch.handleReportPublished({
    type: "REPORT_PUBLISHED",
    agentId: "report-agent",
    timestamp: now(),
    payload: { jobId, totalFindings: 2, criticalFindings: 0, reportHash: "0xrep" },
  });

  assert.equal(settleCalls, 0, "should not settle when already settled on-chain");
  assert.equal(orch.jobs.get(jobId).settled, true, "job should be marked settled in-memory");
  assert.ok(!auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "no settlement log expected");
}

async function testSkipSettlementWithInvalidReportAgentAddress() {
  const log = mockLog();
  const roster = new Roster(log);
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let settleCalls = 0;
  contracts.getAddress = () => ""; // invalid orchestrator fallback address
  contracts.paymentSettlement.isJobSettled = async () => false;
  contracts.paymentSettlement.settleJob = async () => { settleCalls++; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  const jobId = 888;
  const winner = "0x0000000000000000000000000000000000000abc";
  orch.jobs.set(jobId, {
    winners: [winner],
    findings: [
      {
        agentId: "static",
        evmAddress: winner,
        findingsCount: 3,
        criticalCount: 1,
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
    payload: {
      jobId,
      totalFindings: 3,
      criticalFindings: 1,
      reportHash: "0xrep",
      reportAgentAddress: "not-an-address",
    },
  });

  assert.equal(settleCalls, 0, "should skip settlement with invalid report agent address");
  assert.ok(!auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "no settlement log expected");
}

async function run() {
  const tests = [
    ["agent registration", testAgentRegistration],
    ["discovery invites", testDiscoveryInvites],
    ["fallback winners", testFallbackWinners],
    ["bid submission validation", testBidSubmissionValidation],
    ["auto-buy data listing", testAutoBuyDataListing],
    ["create sub-auction", testCreateSubAuction],
    ["accept sub result", testAcceptSubResult],
    ["settlement/report/alert on findings", testSettlementOnFindings],
    ["skip settlement when already settled on-chain", testSkipSettlementWhenAlreadySettledOnChain],
    ["skip settlement on invalid report agent", testSkipSettlementWithInvalidReportAgentAddress],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ ${name} — ${err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  if (passed !== tests.length) process.exit(1);
}

run();
