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
  } = opts;
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
    auction: {
      createAuditJob: async () => {
        if (createAuctionShouldFail) throw new Error("forced createAuditJob failure");
        return { wait: async () => ({ logs: [{ tag: "job-posted" }] }) };
      },
      interface: {
        parseLog: () => ({ name: "JobPosted", args: { jobId: 4242n } }),
      },
    },
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
      isActiveAgent: async () => activeBuyer,
    },
    getAddress: () => ADDR_ORCH,
  };

  const inft = {
    updateReputation: async () => {},
    markJobCompleted: async () => {},
  };

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

async function testFallbackWinners() {
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
    auditLogMessages.some((m) => m.type === MessageType.WINNERS_SELECTED_FALLBACK),
    "fallback winners should be published"
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
    ["invite summary telemetry", testInviteSummaryTelemetry],
    ["discovery invalid address rejected", testDiscoveryRejectsInvalidAddress],
    ["strict fail-fast on create failure", testStrictFailFastOnCreateFailure],
    ["fallback winners", testFallbackWinners],
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
