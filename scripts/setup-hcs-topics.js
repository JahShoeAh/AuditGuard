/**
 * Setup AuditGuard HCS topics on Hedera Testnet and persist IDs to config.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Client, AccountId, PrivateKey, TopicCreateTransaction, Hbar } = require("@hashgraph/sdk");

const CONFIG_PATH = path.join(__dirname, "..", "packages", "sdk", "config.json");

const TOPIC_DEFINITIONS = [
  {
    key: "discovery",
    label: "AuditGuard-Discovery",
    memo: "AuditGuard-Discovery",
    purpose: "Scanner Agent publishes contract discovery events",
    schema: {
      type: "CONTRACT_DISCOVERY",
      contractAddress: "0x...",
      chain: "hedera",
      discoveryTimestamp: 1700000000,
      estimatedLineCount: 3500,
      initialRiskScore: 72,
      deployerAddress: "0x...",
      contractType: "lending_protocol",
      tvlEstimate: 500000,
    },
  },
  {
    key: "auditLog",
    label: "AuditGuard-AuditLog",
    memo: "AuditGuard-AuditLog",
    purpose: "Auction lifecycle and settlement logging channel",
    schema: {
      type: "JOB_CREATED",
      jobId: 1,
      timestamp: 1700000000,
      agentAddress: "0x...",
      data: { eventSpecific: "payload" },
    },
  },
  {
    key: "agentComms",
    label: "AuditGuard-AgentComms",
    memo: "AuditGuard-AgentComms",
    purpose: "OpenClaw UCP agent-to-agent communication bus",
    schema: {
      type: "SUB_AUCTION | DATA_LISTING | MONITORING_OFFER",
      fromAgent: "0x...",
      data: { payload: "..." },
    },
  },
];

function parsePrivateKey(rawKey, keyTypeHint = "") {
  const key = String(rawKey || "").trim().replace(/^['"]|['"]$/g, "");
  if (!key) {
    throw new Error("Private key is empty");
  }

  const normalizedHint = String(keyTypeHint || "").trim().toUpperCase();
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  const isHex32 = /^[0-9a-fA-F]{64}$/.test(stripped);

  if (normalizedHint === "ECDSA") {
    return PrivateKey.fromStringECDSA(stripped);
  }
  if (normalizedHint === "ED25519") {
    return PrivateKey.fromStringED25519(stripped);
  }
  if (isHex32) {
    return PrivateKey.fromStringECDSA(stripped);
  }
  return PrivateKey.fromString(key);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    console.warn(`⚠️ Could not parse existing config; starting fresh: ${error.message}`);
    return {};
  }
}

function saveConfig(nextConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
}

async function createHcsTopicsAndSave({ quiet = false } = {}) {
  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    throw new Error("Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env");
  }

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(process.env.HEDERA_PRIVATE_KEY, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(6));

  const config = loadConfig();
  const output = { ...(config.hcsTopics || {}) };

  try {
    for (const topicDef of TOPIC_DEFINITIONS) {
      if (output[topicDef.key]) {
        if (!quiet) {
          console.log(`ℹ️  Reusing existing ${topicDef.label}: ${output[topicDef.key]}`);
        }
        continue;
      }

      if (!quiet) {
        console.log(`\n📡 Creating topic: ${topicDef.label}`);
        console.log(`   Purpose: ${topicDef.purpose}`);
        console.log(`   Submit key: none (open publishing)`);
      }

      const tx = await new TopicCreateTransaction()
        .setTopicMemo(topicDef.memo)
        .setMaxTransactionFee(new Hbar(8))
        .execute(client);

      const receipt = await tx.getReceipt(client);
      const topicId = receipt.topicId?.toString();
      if (!topicId) {
        throw new Error(`No topic ID returned for ${topicDef.label}`);
      }

      output[topicDef.key] = topicId;
      if (!quiet) {
        console.log(`   ✅ Topic ID: ${topicId}`);
        console.log(`   Schema example: ${JSON.stringify(topicDef.schema)}`);
      }
    }

    const mergedConfig = {
      ...config,
      hcsTopics: output,
    };
    saveConfig(mergedConfig);

    if (!quiet) {
      console.log(`\n✅ Saved HCS topic IDs to ${CONFIG_PATH}`);
    }

    return output;
  } finally {
    client.close();
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          AuditGuard HCS Topic Setup (Hedera Testnet)        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  try {
    const topics = await createHcsTopicsAndSave();
    console.log("\n📋 Created/available topics:");
    console.table([
      { Topic: "Discovery", TopicId: topics.discovery || "-" },
      { Topic: "Audit Log", TopicId: topics.auditLog || "-" },
      { Topic: "Agent Comms", TopicId: topics.agentComms || "-" },
    ]);
  } catch (error) {
    console.error("\n❌ HCS topic setup failed");
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createHcsTopicsAndSave,
  TOPIC_DEFINITIONS,
};

