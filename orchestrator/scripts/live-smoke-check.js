import crypto from "node:crypto";
import { HCSClient } from "../src/hcs-client.js";
import { CONFIG } from "../src/config.js";
import { MessageType, now } from "../../agents/shared/types.js";

const WAIT_MS = 30_000;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomAddress() {
  return `0x${randomHex(20)}`;
}

async function run() {
  const hcs = new HCSClient();
  const contractAddress = randomAddress();
  const testAgentId = `live-smoke-${randomHex(4)}`;

  console.log(`Using discovery topic: ${CONFIG.hcsTopics.discovery}`);
  console.log(`Using auditLog topic: ${CONFIG.hcsTopics.auditLog}`);
  console.log(`Using agentComms topic: ${CONFIG.hcsTopics.agentComms}`);
  console.log(`Smoke contractAddress: ${contractAddress}`);
  console.log(`Smoke agentId: ${testAgentId}`);
  console.log("Waiting for AUCTION_INVITE from orchestrator...");

  const invitePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for AUCTION_INVITE"));
    }, WAIT_MS);

    hcs.subscribeAgentComms((msg) => {
      if (msg?.type !== MessageType.AUCTION_INVITE) return;
      if (msg?.payload?.contractAddress !== contractAddress) return;
      clearTimeout(timeout);
      resolve(msg);
    });
  });

  // Register one eligible agent so orchestrator has someone to invite.
  await hcs.publishAuditLog({
    type: MessageType.AGENT_REGISTERED,
    agentId: testAgentId,
    timestamp: now(),
    payload: {
      evmAddress: randomAddress(),
      stake: 50,
      reputation: 80,
      specializations: ["lending"],
    },
  });

  await hcs.publishDiscovery({
    type: MessageType.CONTRACT_DISCOVERED,
    agentId: "scanner-live-smoke",
    timestamp: now(),
    payload: {
      contractAddress,
      chain: "hedera",
      contractType: "lending",
      budget: 100,
      riskScore: 70,
      initialRiskScore: 70,
      estimatedLOC: 1200,
      estimatedLineCount: 1200,
      discoveryTimestamp: new Date().toISOString(),
    },
  });

  const invite = await invitePromise;
  console.log("✅ Live smoke passed");
  console.log(`Received ${invite.type} for ${invite.payload.contractAddress}`);
}

run().catch((err) => {
  console.error(`❌ Live smoke failed: ${err.message}`);
  process.exit(1);
});
