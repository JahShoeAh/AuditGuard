import crypto from "node:crypto";
import { HCSClient } from "../src/hcs-client.js";
import { MessageType, now } from "../../agents/shared/types.js";

function randomAddress() {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

const AGENTS = [
  {
    agentId: "static-analysis-047",
    specializations: ["lending", "vault", "staking"],
    stake: 80,
    reputation: 92,
  },
  {
    agentId: "fuzzer-012",
    specializations: ["dex", "bridge", "any"],
    stake: 70,
    reputation: 86,
  },
  {
    agentId: "llm-contextual-003",
    specializations: ["any"],
    stake: 60,
    reputation: 84,
  },
  {
    agentId: "dependency-008",
    specializations: ["dependency_analysis", "any"],
    stake: 45,
    reputation: 75,
  },
];

async function run() {
  const hcs = new HCSClient();

  for (const agent of AGENTS) {
    await hcs.publishAuditLog({
      type: MessageType.AGENT_REGISTERED,
      agentId: agent.agentId,
      timestamp: now(),
      payload: {
        evmAddress: randomAddress(),
        stake: agent.stake,
        reputation: agent.reputation,
        specializations: agent.specializations,
      },
    });
    console.log(`✅ Registered ${agent.agentId}`);
  }

  console.log(`Seeded ${AGENTS.length} live agents`);
}

run().catch((err) => {
  console.error(`❌ Failed to seed live agents: ${err.message}`);
  process.exit(1);
});
