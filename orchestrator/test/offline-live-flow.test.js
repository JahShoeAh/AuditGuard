import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { CONFIG } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OFFLINE_STATE_PATH = join(__dirname, "..", "..", "packages", "dashboard", "public", "offline-state.json");

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function makeOfflineHarness() {
  const auditLogMessages = [];
  const agentCommsMessages = [];
  const settledCalls = [];
  const settledOnChain = new Set();

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
        parseLog: () => ({ name: "JobPosted", args: { jobId: 4242 } }),
      },
      createAuditJob: async () => ({
        hash: "0xfake_auction_tx",
        wait: async () => ({ logs: [{}], hash: "0xfake_auction_tx" }),
      }),
    },
    cancelJob: async () => ({ hash: "0xcancel", status: 1 }),
    selectWinners: async () => ({ hash: "0xselect", status: 1 }),
    dataMarketplace: { purchaseData: async () => {} },
    subAuction: { createSubAuction: async () => {}, acceptResult: async () => {} },
    paymentSettlement: {
      isJobSettled: async (jobId) => settledOnChain.has(Number(jobId)),
      settleJob: async (jobId, payments, reportAgent) => {
        settledCalls.push({ jobId: Number(jobId), payments, reportAgent });
        settledOnChain.add(Number(jobId));
      },
    },
    getAddress: () => "0x0000000000000000000000000000000000000abc",
  };

  const inft = {
    updateReputation: async () => {},
    markJobCompleted: async () => {},
  };

  return { hcs, contracts, inft, auditLogMessages, agentCommsMessages, settledCalls };
}

function registerPracticeAgent(orch, { agentId, evmAddress, stake, reputation, specializations }) {
  orch.handleAgentRegistered({
    type: MessageType.AGENT_REGISTERED,
    agentId,
    timestamp: now(),
    payload: { evmAddress, stake, reputation, specializations },
  });
}

async function main() {
  const originalWinnerWait = CONFIG.timeouts.winnerWaitMs;
  CONFIG.timeouts.winnerWaitMs = 5;

  try {
    const log = mockLog();
    const roster = new Roster(log);
    const { hcs, contracts, inft, auditLogMessages, agentCommsMessages, settledCalls } = makeOfflineHarness();

    const orch = new OrchestratorAgent({ log, roster, hcs, contracts, inft, enablePing: false });
    const seededAgents = {};

    // 1) Practice agents come online (simulated AGENT_REGISTERED from Hedera/HCS).
    registerPracticeAgent(orch, {
      agentId: "practice-static-1",
      evmAddress: "0x00000000000000000000000000000000000000a1",
      stake: 200,
      reputation: 91,
      specializations: ["lending", "any"],
    });
    seededAgents["0x00000000000000000000000000000000000000a1"] = {
      address: "0x00000000000000000000000000000000000000a1",
      agentId: "practice-static-1",
      name: "practice-static-1",
      reputationScore: 9100,
      stakedAmount: 20000000000,
      specialization: "lending",
    };
    registerPracticeAgent(orch, {
      agentId: "practice-fuzzer-1",
      evmAddress: "0x00000000000000000000000000000000000000b2",
      stake: 180,
      reputation: 87,
      specializations: ["lending", "vault"],
    });
    seededAgents["0x00000000000000000000000000000000000000b2"] = {
      address: "0x00000000000000000000000000000000000000b2",
      agentId: "practice-fuzzer-1",
      name: "practice-fuzzer-1",
      reputationScore: 8700,
      stakedAmount: 18000000000,
      specialization: "lending",
    };
    registerPracticeAgent(orch, {
      agentId: "practice-llm-1",
      evmAddress: "0x00000000000000000000000000000000000000c3",
      stake: 250,
      reputation: 95,
      specializations: ["lending", "bridge"],
    });
    seededAgents["0x00000000000000000000000000000000000000c3"] = {
      address: "0x00000000000000000000000000000000000000c3",
      agentId: "practice-llm-1",
      name: "practice-llm-1",
      reputationScore: 9500,
      stakedAmount: 25000000000,
      specialization: "lending",
    };
    registerPracticeAgent(orch, {
      agentId: "practice-lowstake",
      evmAddress: "0x00000000000000000000000000000000000000d4",
      stake: 1,
      reputation: 99,
      specializations: ["lending"],
    });
    seededAgents["0x00000000000000000000000000000000000000d4"] = {
      address: "0x00000000000000000000000000000000000000d4",
      agentId: "practice-lowstake",
      name: "practice-lowstake",
      reputationScore: 9900,
      stakedAmount: 100000000,
      specialization: "lending",
    };

    // 2) Fake Hedera contract goes live (simulated discovery event).
    await orch.handleDiscovery({
      type: MessageType.CONTRACT_DISCOVERED,
      agentId: "scanner-001",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
        contractType: "lending",
        budget: 120,
        riskScore: 82,
        estimatedLOC: 1800,
      },
    });

    // Discovery should have produced auction invites.
    const invites = agentCommsMessages.filter((m) => m.type === MessageType.AUCTION_INVITE);
    assert.equal(invites.length, 1, "expected one AUCTION_INVITE publish per job");
    assert.ok(
      Array.isArray(invites[0].payload.eligibleAgentIds) && invites[0].payload.eligibleAgentIds.length >= 3,
      "invite payload should carry eligible agent ids"
    );

    // 3) Agents submit bids (low-stake agent gets rejected by orchestrator).
    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "practice-static-1",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
        bidAmount: 28,
        collateral: 6,
        estimatedTimeSec: 220,
        reputation: 91,
        evmAddress: "0x00000000000000000000000000000000000000a1",
      },
    });
    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "practice-fuzzer-1",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
        bidAmount: 26,
        collateral: 5,
        estimatedTimeSec: 280,
        reputation: 87,
        evmAddress: "0x00000000000000000000000000000000000000b2",
      },
    });
    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "practice-llm-1",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
        bidAmount: 34,
        collateral: 8,
        estimatedTimeSec: 190,
        reputation: 95,
        evmAddress: "0x00000000000000000000000000000000000000c3",
      },
    });
    orch.handleBidSubmitted({
      type: "BID_SUBMITTED",
      agentId: "practice-lowstake",
      timestamp: now(),
      payload: {
        contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
        bidAmount: 18,
        collateral: 4,
        estimatedTimeSec: 140,
        reputation: 99,
        evmAddress: "0x00000000000000000000000000000000000000d4",
      },
    });

    // 4) Winner selection (strict on-chain path with mocked tx).
    await orch.selectWinnersOnChain(4242);
    const job = orch.jobs.get("4242");
    assert.ok(job, "job must exist");
    assert.ok(job.winners.length > 0, "winners should be selected");

    // 5) Winners submit findings; one non-winner submits noise.
    await orch.handleFindings({
      type: MessageType.FINDINGS_SUBMITTED,
      agentId: "practice-static-1",
      timestamp: now(),
      payload: {
        jobId: 4242,
        findingsHash: "0xaaa111",
        evmAddress: "0x00000000000000000000000000000000000000a1",
        findingsCount: 4,
        criticalCount: 1,
      },
    });
    await orch.handleFindings({
      type: MessageType.FINDINGS_SUBMITTED,
      agentId: "practice-fuzzer-1",
      timestamp: now(),
      payload: {
        jobId: 4242,
        findingsHash: "0xbbb222",
        evmAddress: "0x00000000000000000000000000000000000000b2",
        findingsCount: 3,
        criticalCount: 1,
      },
    });
    await orch.handleFindings({
      type: MessageType.FINDINGS_SUBMITTED,
      agentId: "practice-lowstake",
      timestamp: now(),
      payload: {
        jobId: 4242,
        findingsHash: "0xnoise333",
        evmAddress: "0x00000000000000000000000000000000000000d4",
        findingsCount: 9,
        criticalCount: 5,
      },
    });

    // 6) Report published -> orchestrator settles once.
    await orch.handleReportPublished({
      type: MessageType.AUDIT_LOG,
      agentId: "report-agent",
      timestamp: now(),
      payload: {
        jobId: 4242,
        totalFindings: 7,
        criticalFindings: 2,
        reportHash: "0xfinal_report_hash",
        reportAgentAddress: "0x0000000000000000000000000000000000000abc",
      },
    });

    assert.equal(settledCalls.length, 1, "expected exactly one settlement call");

    // Settlement recipients must be winners only.
    const winnerSet = new Set(job.winners.map((w) => String(w).toLowerCase()));
    for (const p of settledCalls[0].payments) {
      assert.ok(winnerSet.has(String(p.recipient).toLowerCase()), "recipient must be a selected winner");
    }

    assert.ok(
      auditLogMessages.some((m) => m.type === "PAYMENT_SETTLED" && Number(m.payload?.jobId) === 4242),
      "expected PAYMENT_SETTLED audit log"
    );

    // Duplicate report should not settle again.
    await orch.handleReportPublished({
      type: MessageType.AUDIT_LOG,
      agentId: "report-agent",
      timestamp: now(),
      payload: {
        jobId: 4242,
        totalFindings: 7,
        criticalFindings: 2,
        reportHash: "0xfinal_report_hash",
        reportAgentAddress: "0x0000000000000000000000000000000000000abc",
      },
    });
    assert.equal(settledCalls.length, 1, "duplicate report must not resettle");

    // 7) Write dashboard replay snapshot so UI can render this offline run.
    const jobSnapshot = orch.jobs.get("4242");
    const offlineState = {
      generatedAt: Date.now(),
      discoveries: [
        {
          type: "CONTRACT_DISCOVERY",
          contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
          contractType: "lending",
          chain: "hedera",
          estimatedLineCount: 1800,
          initialRiskScore: 82,
          discoveryTimestamp: new Date().toISOString(),
          timestamp: Date.now(),
        },
      ],
      activeJobs: {
        "4242": {
          jobId: "4242",
          contractAddress: "0xdeadbeef00000000000000000000000000ff1111",
          contractChain: "hedera",
          contractType: "lending",
          budgetAvailable: 12000000000,
          auctionDeadline: Math.floor(Date.now() / 1000) + 120,
          initialRiskScore: 82,
          lineCount: 1800,
          discoveredAt: Date.now() - 5000,
          postedAt: Date.now() - 3000,
          winnersAt: Date.now() - 1000,
        },
      },
      bids: {
        "4242": (jobSnapshot?.bidders ?? []).map((b) => ({
          jobId: "4242",
          agent: b.evmAddress,
          agentName: b.agentId,
          bidAmount: b.bidAmount,
          collateralLocked: b.collateral,
          reputationAtBid: b.reputation,
          estimatedCompletionTime: b.estimatedTimeSec,
          timestamp: b.timestamp,
        })),
      },
      winners: {
        "4242": {
          agents: jobSnapshot?.winners ?? [],
          winnerCount: (jobSnapshot?.winners ?? []).length,
          winnersAt: Date.now(),
        },
      },
      agents: seededAgents,
      settlements: settledCalls.map((s, i) => ({
        settlementId: String(i + 1),
        jobId: String(s.jobId),
        totalDisbursed: 0,
        recipientCount: s.payments.length,
        settledAt: Date.now(),
      })),
      auditLog: auditLogMessages.map((m, idx) => ({
        ...m,
        id: `offline-${idx + 1}`,
        source: "offline-test",
      })),
      stats: {
        totalDiscoveries: 1,
        totalAuctions: 1,
        totalBids: (jobSnapshot?.bidders ?? []).length,
        totalSubAuctions: 0,
        totalDataSales: 0,
        totalSettlements: settledCalls.length,
      },
    };
    mkdirSync(dirname(OFFLINE_STATE_PATH), { recursive: true });
    writeFileSync(OFFLINE_STATE_PATH, JSON.stringify(offlineState, null, 2));

    console.log("✅ offline live-flow simulation passed");
    console.log(`📦 dashboard replay snapshot written: ${OFFLINE_STATE_PATH}`);
  } finally {
    CONFIG.timeouts.winnerWaitMs = originalWinnerWait;
  }
}

main().catch((err) => {
  console.error(`❌ offline live-flow simulation failed — ${err.message}`);
  process.exit(1);
});
