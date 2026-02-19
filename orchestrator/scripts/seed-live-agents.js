import { ethers } from "ethers";
import { HCSClient } from "../src/hcs-client.js";
import { MessageType, now } from "../../agents/shared/types.js";

const AGENTS = [
  {
    prefix: "SCANNER",
    legacyPrefix: "SCANNER_AGENT",
    required: true,
    agentId: "scanner-001",
    specializations: ["lending", "dex", "bridge", "staking", "vault"],
    stake: 100,
    reputation: 90,
  },
  {
    prefix: "STATIC",
    legacyPrefix: "AUDITOR_AGENT_1",
    required: true,
    agentId: "static-analysis-047",
    specializations: ["lending", "vault", "staking"],
    stake: 80,
    reputation: 92,
  },
  {
    prefix: "FUZZER",
    legacyPrefix: "AUDITOR_AGENT_2",
    required: true,
    agentId: "fuzzer-012",
    specializations: ["dex", "bridge", "any"],
    stake: 70,
    reputation: 86,
  },
  {
    prefix: "LLM",
    legacyPrefix: "AUDITOR_AGENT_3",
    required: true,
    agentId: "llm-contextual-003",
    specializations: ["any"],
    stake: 60,
    reputation: 84,
  },
  {
    prefix: "DEPENDENCY",
    required: false,
    agentId: "dependency-analyzer-008",
    specializations: ["dependency_analysis", "any"],
    stake: 45,
    reputation: 75,
  },
  {
    prefix: "REPORT",
    required: false,
    agentId: "report-aggregator-001",
    specializations: ["reporting", "aggregation"],
    stake: 40,
    reputation: 78,
  },
  {
    prefix: "ALERT",
    required: false,
    agentId: "alert-sentinel-001",
    specializations: ["alerting", "monitoring"],
    stake: 35,
    reputation: 72,
  },
];

function getEnvValue(prefix, legacyPrefix, suffix) {
  return process.env[`${prefix}_${suffix}`] || (legacyPrefix ? process.env[`${legacyPrefix}_${suffix}`] : undefined);
}

function resolveAddress(spec) {
  const pk = getEnvValue(spec.prefix, spec.legacyPrefix, "PRIVATE_KEY");
  if (!pk) {
    if (spec.required) {
      throw new Error(`Missing ${spec.prefix}_PRIVATE_KEY for required agent ${spec.agentId}`);
    }
    return null;
  }
  const formatted = pk.startsWith("0x") ? pk : `0x${pk}`;
  return new ethers.Wallet(formatted).address;
}

async function run() {
  const hcs = new HCSClient();
  let seeded = 0;

  for (const agent of AGENTS) {
    const evmAddress = resolveAddress(agent);
    if (!evmAddress) {
      console.log(`⚠️ Skipping ${agent.agentId}: missing wallet key`);
      continue;
    }

    await hcs.publishAuditLog({
      type: MessageType.AGENT_REGISTERED,
      agentId: agent.agentId,
      timestamp: now(),
      payload: {
        evmAddress,
        stake: agent.stake,
        reputation: agent.reputation,
        specializations: agent.specializations,
      },
    });
    seeded += 1;
    console.log(`✅ Registered ${agent.agentId} (${evmAddress})`);
  }

  console.log(`Seeded ${seeded} live agents`);
}

run().catch((err) => {
  console.error(`❌ Failed to seed live agents: ${err.message}`);
  process.exit(1);
});
