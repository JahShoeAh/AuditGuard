import assert from "node:assert/strict";
import { ethers } from "ethers";
import { OrchestratorAgent } from "../src/orchestrator.js";
import { Roster } from "../src/roster.js";
import { MessageType, now } from "../../agents/shared/types.js";

const ADDR_JOB = "0xfeed000000000000000000000000000000000001";
const ADDR_AGENT_A = "0x00000000000000000000000000000000000000aa";
const ADDR_AGENT_B = "0x00000000000000000000000000000000000000bb";
const ADDR_ORCH = "0x0000000000000000000000000000000000000abc";

function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

function makeMocks() {
  const auditLogMessages = [];
  const agentCommsMessages = [];

  const auctionListeners = new Map();
  const auction = {
    interface: {
      parseLog: () => ({ name: "JobPosted", args: { jobId: 4242n } }),
    },
    createAuditJob: async () => ({ wait: async () => ({ logs: [{}], hash: "0xcreate" }) }),
    on: (event, handler) => {
      auctionListeners.set(event, handler);
    },
    emit: async (event, ...args) => {
      const handler = auctionListeners.get(event);
      if (!handler) throw new Error(`Missing auction listener for ${event}`);
      await handler(...args);
    },
  };

  const hcs = {
    publishAgentComms: async (msg) => agentCommsMessages.push(msg),
    publishAuditLog: async (msg) => auditLogMessages.push(msg),
    subscribeDiscovery() {},
    subscribeAgentComms() {},
    subscribeAuditLog() {},
  };
  const dataMarketplace = { purchaseData: async () => {} };
  const subAuction = { createSubAuction: async () => {}, acceptResult: async () => {} };
  const paymentSettlement = { settleJob: async () => {}, isJobSettled: async () => false };

  const contracts = {
    auction,
    createAuditJob: async (...args) => auction.createAuditJob(...args),
    selectWinners: async () => ({ hash: "0xselect", status: 1 }),
    cancelJob: async () => ({ hash: "0xcancel", status: 1 }),
    getActiveJobs: async () => [],
    getJob: async () => ({ auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 60), status: 0 }),
    dataMarketplace,
    subAuction,
    paymentSettlement,
    purchaseData: async (...args) => dataMarketplace.purchaseData(...args),
    createSubAuction: async (...args) => subAuction.createSubAuction(...args),
    acceptSubResult: async (...args) => subAuction.acceptResult(...args),
    settleJob: async (...args) => paymentSettlement.settleJob(...args),
    agentRegistry: { isActiveAgent: async () => true },
    getAddress: () => ADDR_ORCH,
  };

  return { hcs, contracts, auditLogMessages, agentCommsMessages, auction };
}

function assertAddress(value, label) {
  assert.ok(ethers.isAddress(String(value || "")), `${label} must be a valid EVM address`);
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must be non-empty`);
}

function assertFiniteNumber(value, label) {
  const n = Number(value);
  assert.ok(Number.isFinite(n), `${label} must be a finite number`);
}

function validateJobCreatedPayload(payload) {
  assertFiniteNumber(payload.jobId, "JOB_CREATED.payload.jobId");
  assertAddress(payload.contractAddress, "JOB_CREATED.payload.contractAddress");
  assertNonEmptyString(payload.contractType, "JOB_CREATED.payload.contractType");
  assertFiniteNumber(payload.budget, "JOB_CREATED.payload.budget");
  assertFiniteNumber(payload.riskScore, "JOB_CREATED.payload.riskScore");
  assertFiniteNumber(payload.estimatedLOC, "JOB_CREATED.payload.estimatedLOC");
  assert.equal(typeof payload.onChain, "boolean", "JOB_CREATED.payload.onChain must be boolean");
  if (payload.classifier != null) {
    assert.equal(typeof payload.classifier, "object", "JOB_CREATED.payload.classifier must be object");
  }
}

function validateAuctionInvitePayload(payload) {
  assertFiniteNumber(payload.jobId, "AUCTION_INVITE.payload.jobId");
  assertAddress(payload.contractAddress, "AUCTION_INVITE.payload.contractAddress");
  assertNonEmptyString(payload.contractType, "AUCTION_INVITE.payload.contractType");
  assertFiniteNumber(payload.budget, "AUCTION_INVITE.payload.budget");
  assertFiniteNumber(payload.riskScore, "AUCTION_INVITE.payload.riskScore");
  assertFiniteNumber(payload.estimatedLOC, "AUCTION_INVITE.payload.estimatedLOC");
  assertNonEmptyString(payload.inviteBatchId, "AUCTION_INVITE.payload.inviteBatchId");
  assert.ok(Array.isArray(payload.eligibleAgentIds), "eligibleAgentIds must be an array");
  assert.ok(Array.isArray(payload.eligibleEvmAddresses), "eligibleEvmAddresses must be an array");
  assert.equal(
    payload.eligibleAgentIds.length,
    payload.eligibleEvmAddresses.length,
    "eligible id/address list lengths must match"
  );
  if (payload.classifierHints != null) {
    assert.equal(typeof payload.classifierHints, "object", "classifierHints must be an object when present");
  }
}

function validateBidSubmittedPayload(payload) {
  assertFiniteNumber(payload.jobId, "BID_SUBMITTED.payload.jobId");
  assertAddress(payload.contractAddress, "BID_SUBMITTED.payload.contractAddress");
  assertFiniteNumber(payload.bidAmount, "BID_SUBMITTED.payload.bidAmount");
  assertFiniteNumber(payload.collateral, "BID_SUBMITTED.payload.collateral");
  assertFiniteNumber(payload.estimatedTimeSec, "BID_SUBMITTED.payload.estimatedTimeSec");
}

function validateWinnerSelectedPayload(payload) {
  assertFiniteNumber(payload.jobId, "WINNER_SELECTED.payload.jobId");
  assert.ok(Array.isArray(payload.winners), "WINNER_SELECTED.payload.winners must be an array");
  payload.winners.forEach((winner, idx) =>
    assertAddress(winner, `WINNER_SELECTED.payload.winners[${idx}]`)
  );
}

function validateJobCancelledPayload(payload) {
  assertFiniteNumber(payload.jobId, "JOB_CANCELLED.payload.jobId");
  assertNonEmptyString(payload.phase, "JOB_CANCELLED.payload.phase");
  assertNonEmptyString(payload.reasonCode, "JOB_CANCELLED.payload.reasonCode");
}

function validateJobCompletedEntry(entry) {
  assert.equal(entry.type, "JobCompleted", "JobCompleted entry must have type=JobCompleted");
  assertNonEmptyString(entry.jobId, "JobCompleted.jobId");
  assertNonEmptyString(entry.source, "JobCompleted.source");
}

async function testEventContractPayloads() {
  const log = mockLog();
  const roster = new Roster(log);
  roster.upsert({
    agentId: "agent-a",
    evmAddress: ADDR_AGENT_A,
    stake: 100,
    reputation: 90,
    specializations: ["lending", "any"],
  });
  roster.upsert({
    agentId: "agent-b",
    evmAddress: ADDR_AGENT_B,
    stake: 90,
    reputation: 85,
    specializations: ["lending"],
  });

  const { hcs, contracts, auditLogMessages, agentCommsMessages, auction } = makeMocks();
  const orch = new OrchestratorAgent({ log, roster, hcs, contracts, enablePing: false });

  await orch.handleDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner",
    timestamp: now(),
    payload: {
      contractAddress: ADDR_JOB,
      contractType: "lending",
      budget: 100,
      riskScore: 71,
      estimatedLOC: 1800,
      classifier: {
        riskSource: "0g",
        riskModel: "qwen/qwen-2.5-7b-instruct",
        topRiskFactors: ["unsafe delegatecall"],
        evmType: "erc20",
        isProxy: false,
      },
    },
  });

  const jobCreated = auditLogMessages.find((m) => m.type === "JOB_CREATED");
  assert.ok(jobCreated, "expected JOB_CREATED audit log");
  validateJobCreatedPayload(jobCreated.payload || {});

  const invite = agentCommsMessages.find((m) => m.type === MessageType.AUCTION_INVITE);
  assert.ok(invite, "expected AUCTION_INVITE agentComms message");
  validateAuctionInvitePayload(invite.payload || {});
  assert.equal(invite.payload?.classifierHints?.riskSource, "0g");
  assert.equal(invite.payload?.classifierHints?.riskModel, "qwen/qwen-2.5-7b-instruct");

  const summary = auditLogMessages.find((m) => m.type === "AUCTION_INVITE_SUMMARY");
  assert.ok(summary, "expected AUCTION_INVITE_SUMMARY audit log");
  assert.equal(
    (summary.payload?.eligibleAgents || []).length,
    (invite.payload?.eligibleAgentIds || []).length,
    "invite summary eligible count must match invite payload eligible count"
  );

  orch.setJobByKey("4242", {
    contractAddress: ADDR_JOB,
    contractType: "lending",
    bidders: [
      {
        agentId: "agent-a",
        evmAddress: ADDR_AGENT_A,
        bidAmount: 20,
        estimatedTimeSec: 100,
        reputation: 90,
      },
      {
        agentId: "agent-b",
        evmAddress: ADDR_AGENT_B,
        bidAmount: 22,
        estimatedTimeSec: 130,
        reputation: 85,
      },
    ],
    winners: [],
    findings: [],
    reportPublished: false,
  });

  orch.subscribeContractEvents();
  await auction.emit("WinnersSelected", 4242n, [ADDR_AGENT_A, ADDR_AGENT_B], 100000000n, 2000000n);
  const winnerSelected = auditLogMessages.find((m) => m.type === "WINNER_SELECTED");
  assert.ok(winnerSelected, "expected WINNER_SELECTED audit log");
  validateWinnerSelectedPayload(winnerSelected.payload || {});

  await orch.closeExpiredAuction("4242", "test_close_contract");
  const cancelled = auditLogMessages.find((m) => m.type === "JOB_CANCELLED");
  assert.ok(cancelled, "expected JOB_CANCELLED audit log");
  validateJobCancelledPayload(cancelled.payload || {});

  validateBidSubmittedPayload({
    jobId: "4242",
    contractAddress: ADDR_JOB,
    bidAmount: 12.4,
    collateral: 6.2,
    estimatedTimeSec: 240,
  });

  validateJobCompletedEntry({
    type: "JobCompleted",
    source: "contract",
    jobId: "4242",
  });
}

async function run() {
  try {
    await testEventContractPayloads();
    console.log("✅ event contract payload compatibility");
    console.log("1/1 tests passed");
  } catch (err) {
    console.error(`❌ event contract payload compatibility — ${err.message}`);
    process.exit(1);
  }
}

run();
