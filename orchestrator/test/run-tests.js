// Minimal test harness using built-in assert to avoid external deps.
import assert from "node:assert/strict";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../src/types.js";
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
  };
  return { hcs, contracts, auditLogMessages, agentCommsMessages };
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
  const { hcs, contracts, auditLogMessages } = makeMocks();
  let settled = false;
  contracts.paymentSettlement.settleJob = async () => { settled = true; };
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleFindings({
    type: MessageType.FINDINGS_SUBMITTED,
    agentId: "static",
    timestamp: now(),
    payload: { jobId: 99, findingsHash: "0xhash", evmAddress: "0xabc" },
  });

  assert.ok(settled, "should call settleJob");
  assert.ok(auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "logs settlement");
}

async function run() {
  const tests = [
    ["agent registration", testAgentRegistration],
    ["discovery invites", testDiscoveryInvites],
    ["fallback winners", testFallbackWinners],
    ["auto-buy data listing", testAutoBuyDataListing],
    ["create sub-auction", testCreateSubAuction],
    ["accept sub result", testAcceptSubResult],
    ["settlement on findings", testSettlementOnFindings],
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
