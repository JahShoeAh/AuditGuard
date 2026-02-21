import assert from "node:assert/strict";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { CONFIG } from "../src/config.js";

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMocks() {
  const auditLogMessages = [];
  const agentCommsMessages = [];
  const settledJobs = [];

  const hcs = {
    publishAgentComms: async (msg) => agentCommsMessages.push(msg),
    publishAuditLog: async (msg) => auditLogMessages.push(msg),
    subscribeDiscovery() {},
    subscribeAgentComms() {},
    subscribeAuditLog() {},
  };

  const contracts = {
    auction: {
      interface: {
        parseLog: () => ({ name: "JobPosted", args: { jobId: 101 } }),
      },
      createAuditJob: async () => ({
        hash: "0xtx",
        wait: async () => ({ logs: [{}], hash: "0xtx" }),
      }),
    },
    cancelJob: async () => ({ hash: "0xcancel", status: 1 }),
    selectWinners: async () => ({ hash: "0xselect", status: 1 }),
    dataMarketplace: { purchaseData: async () => {} },
    subAuction: { createSubAuction: async () => {}, acceptResult: async () => {} },
    paymentSettlement: {
      settleJob: async (jobId, payments) => {
        settledJobs.push({ jobId, payments });
      },
    },
    getAddress: () => "0x0000000000000000000000000000000000000abc",
  };

  const inft = {
    updateReputation: async () => {},
    markJobCompleted: async () => {},
  };

  return {
    hcs,
    contracts,
    inft,
    auditLogMessages,
    agentCommsMessages,
    settledJobs,
  };
}

function registerAgent(orch, { agentId, evmAddress, stake, reputation, specializations }) {
  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId,
    timestamp: now(),
    payload: { evmAddress, stake, reputation, specializations },
  });
}

async function testE2EBasicFlow() {
  const originalWinnerWaitMs = CONFIG.timeouts.winnerWaitMs;
  const originalBidFinalityGraceMs = CONFIG.timeouts.bidFinalityGraceMs;
  CONFIG.timeouts.winnerWaitMs = 1000;
  CONFIG.timeouts.bidFinalityGraceMs = 0;

  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts, inft, auditLogMessages, agentCommsMessages, settledJobs } = makeMocks();

    const orch = new OrchestratorAgent({
      log,
      roster,
      hcs,
      contracts,
      inft,
      enablePing: false,
    });

    registerAgent(orch, {
      agentId: "static-47",
      evmAddress: "0x0000000000000000000000000000000000000047",
      stake: 50,
      reputation: 92,
      specializations: ["lending"],
    });
    registerAgent(orch, {
      agentId: "fuzzer-12",
      evmAddress: "0x0000000000000000000000000000000000000012",
      stake: 60,
      reputation: 85,
      specializations: ["any"],
    });
    registerAgent(orch, {
      agentId: "wrong-spec",
      evmAddress: "0x00000000000000000000000000000000000000aa",
      stake: 80,
      reputation: 99,
      specializations: ["dex"],
    });

    await orch.handleDiscovery({
      type: MessageType.CONTRACT_DISCOVERED,
      agentId: "scanner",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000beef01",
        contractType: "lending",
        budget: 100,
        riskScore: 75,
        estimatedLOC: 1200,
      },
    });

    const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
    assert.equal(invites.length, 1, "should publish one AUCTION_INVITE per job");
    assert.equal(invites[0].payload.contractType, "lending", "invite payload should include contract type");
    assert.equal(invites[0].payload.eligibleAgentIds.length, 2, "invite payload should include eligible agent ids");

    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "static-47",
      timestamp: now(),
      payload: {
        jobId: 101,
        contractAddress: "0xdeadbeef00000000000000000000000000beef01",
        bidAmount: 12,
        collateral: 6,
        estimatedTimeSec: 220,
        reputation: 92,
        evmAddress: "0x0000000000000000000000000000000000000047",
      },
    });
    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "fuzzer-12",
      timestamp: now(),
      payload: {
        jobId: 101,
        contractAddress: "0xdeadbeef00000000000000000000000000beef01",
        bidAmount: 14,
        collateral: 6,
        estimatedTimeSec: 260,
        reputation: 85,
        evmAddress: "0x0000000000000000000000000000000000000012",
      },
    });

    await sleep(1300);
    const selectedJob = orch.jobs.get("101");
    assert.ok(selectedJob?.winners?.length > 0, "winners should be selected by on-chain path");

    await orch.handleFindings({
      type: MessageType.FINDINGS_SUBMITTED,
      agentId: "static-47",
      timestamp: now(),
      payload: {
        jobId: 101,
        findingsHash: "0xfindingshash",
        evmAddress: "0x0000000000000000000000000000000000000047",
        findingsCount: 2,
        criticalCount: 1,
      },
    });

    await orch.handleReportPublished({
      type: MessageType.AUDIT_LOG,
      agentId: "report-agent",
      timestamp: now(),
      payload: {
        jobId: 101,
        totalFindings: 2,
        criticalFindings: 1,
        reportHash: "0xreporthash",
      },
    });

    assert.ok(auditLogMessages.some((m) => m.type === "REPORT_PUBLISHED"), "report should be logged");
    assert.ok(auditLogMessages.some((m) => m.type === "ALERT_FIRED"), "alert should be logged");
    assert.ok(auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED"), "settlement should be logged");
    assert.ok(auditLogMessages.some((m) => m.type === "REPUTATION_UPDATED"), "reputation update should be logged");
    assert.equal(settledJobs.length, 1, "should settle the job once");
  } finally {
    CONFIG.timeouts.winnerWaitMs = originalWinnerWaitMs;
    CONFIG.timeouts.bidFinalityGraceMs = originalBidFinalityGraceMs;
  }
}

async function run() {
  try {
    await testE2EBasicFlow();
    console.log("✅ e2e simulation passed");
  } catch (err) {
    console.error(`❌ e2e simulation failed — ${err.message}`);
    process.exit(1);
  }
}

run();
