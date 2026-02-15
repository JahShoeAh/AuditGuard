/**
 * AuditGuard Discovery Listener
 *
 * Subscribes to the HCS discovery topic and automatically mints
 * Audit Job iNFTs + Contract Health iNFTs when new contracts are discovered.
 *
 * This is the entry point that connects the Scanner Agent's output
 * (HCS discovery messages) to the iNFT state layer.
 *
 * Usage:
 *   node packages/inft/src/discovery-listener.js
 *
 * The listener:
 *   1. Subscribes to HCS discovery topic (0.0.XXXXXX)
 *   2. On each CONTRACT_DISCOVERY message:
 *      a. Mints an Audit Job iNFT (state: DISCOVERED)
 *      b. Mints a Contract Health iNFT (state: UNAUDITED) if first time seeing this contract
 *      c. Publishes INFT_MINTED events back to HCS auditLog topic
 *   3. Tracks which contracts already have Health iNFTs to avoid duplicates
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const {
  Client,
  AccountId,
  PrivateKey,
  TopicMessageQuery,
  Hbar,
} = require("@hashgraph/sdk");

const { INFTService } = require("./inft-service");

const CONFIG_PATH = path.join(__dirname, "..", "..", "sdk", "config.json");

/** Track contracts that already have a Contract Health iNFT (by address). */
const knownContracts = new Map(); // contractAddress -> contractHealth serial number

function parsePrivateKey(rawKey, keyTypeHint = "") {
  const key = String(rawKey || "").trim().replace(/^['"]|['"]$/g, "");
  if (!key) throw new Error("Private key is empty");
  const normalizedHint = String(keyTypeHint || "").trim().toUpperCase();
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  const isHex32 = /^[0-9a-fA-F]{64}$/.test(stripped);
  if (normalizedHint === "ECDSA") return PrivateKey.fromStringECDSA(stripped);
  if (normalizedHint === "ED25519") return PrivateKey.fromStringED25519(stripped);
  if (isHex32) return PrivateKey.fromStringECDSA(stripped);
  return PrivateKey.fromString(key);
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/**
 * Parse an HCS message payload into a discovery event object.
 * Handles both Buffer and Uint8Array message contents.
 */
function parseDiscoveryMessage(message) {
  let content;
  if (message.contents instanceof Uint8Array || Buffer.isBuffer(message.contents)) {
    content = Buffer.from(message.contents).toString("utf8");
  } else {
    content = String(message.contents);
  }

  const parsed = JSON.parse(content);
  if (parsed.type !== "CONTRACT_DISCOVERY") {
    return null;
  }

  return {
    contractAddress: parsed.contractAddress,
    chain: parsed.chain || "hedera",
    contractType: parsed.contractType || "unknown",
    estimatedLineCount: parsed.estimatedLineCount || 0,
    initialRiskScore: parsed.initialRiskScore || 50,
    deployerAddress: parsed.deployerAddress || null,
    discoveryTimestamp: parsed.discoveryTimestamp || Math.floor(Date.now() / 1000),
    tvlEstimate: parsed.tvlEstimate || 0,
    scannerAgentId: parsed.scannerAgentId || "scanner-default",
    hcsMessageId: message.sequenceNumber?.toString() || null,
    codeHash: parsed.codeHash || null,
    jobId: parsed.jobId || 0,
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║      AuditGuard iNFT Discovery Listener (Hedera Testnet)    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    throw new Error("Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env");
  }

  const config = readConfig();
  const discoveryTopicId = config.hcsTopics?.discovery;
  if (!discoveryTopicId) {
    throw new Error("No discovery HCS topic found in config. Run setup-hcs-topics.js first.");
  }

  if (!config.inftCollections?.auditJob || !config.inftCollections?.contractHealth) {
    throw new Error("iNFT collections not found in config. Run create-nft-collections.js first.");
  }

  // Initialize iNFT service for minting
  const inftService = new INFTService({
    operatorId: process.env.HEDERA_ACCOUNT_ID,
    operatorKey: process.env.HEDERA_PRIVATE_KEY,
    keyType: process.env.HEDERA_PRIVATE_KEY_TYPE,
  });

  // Separate client for HCS subscription (mirror node)
  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(
    process.env.HEDERA_PRIVATE_KEY,
    process.env.HEDERA_PRIVATE_KEY_TYPE
  );
  const mirrorClient = Client.forTestnet().setOperator(operatorId, operatorKey);
  mirrorClient.setDefaultMaxTransactionFee(new Hbar(5));

  console.log(`  Subscribing to discovery topic: ${discoveryTopicId}`);
  console.log(`  Audit Job collection: ${config.inftCollections.auditJob.tokenId}`);
  console.log(`  Contract Health collection: ${config.inftCollections.contractHealth.tokenId}`);
  console.log("\n  Waiting for CONTRACT_DISCOVERY events...\n");

  let messageCount = 0;

  new TopicMessageQuery()
    .setTopicId(discoveryTopicId)
    .subscribe(mirrorClient, null, async (message) => {
      messageCount++;
      const seqNum = message.sequenceNumber?.toString() || "?";
      console.log(`\n  --- HCS Message #${seqNum} received ---`);

      let discoveryEvent;
      try {
        discoveryEvent = parseDiscoveryMessage(message);
      } catch (err) {
        console.log(`  [SKIP] Could not parse message: ${err.message}`);
        return;
      }

      if (!discoveryEvent) {
        console.log("  [SKIP] Not a CONTRACT_DISCOVERY message");
        return;
      }

      console.log(`  Contract: ${discoveryEvent.contractAddress}`);
      console.log(`  Chain: ${discoveryEvent.chain}`);
      console.log(`  Type: ${discoveryEvent.contractType}`);
      console.log(`  Risk: ${discoveryEvent.initialRiskScore}/100`);

      try {
        // 1. Mint Audit Job iNFT
        const { serialNumber: jobSerial, metadata: jobMeta } =
          await inftService.mintAuditJobINFT(discoveryEvent);

        // Publish minting event to HCS
        await inftService.publishToAuditLog("INFT_MINTED", {
          collection: "auditJob",
          serialNumber: jobSerial,
          contractAddress: discoveryEvent.contractAddress,
          state: "DISCOVERED",
        });

        // 2. Mint Contract Health iNFT (if first time for this contract)
        const addr = discoveryEvent.contractAddress.toLowerCase();
        if (!knownContracts.has(addr)) {
          const { serialNumber: healthSerial } = await inftService.mintContractHealthINFT({
            contractAddress: discoveryEvent.contractAddress,
            chain: discoveryEvent.chain,
            contractType: discoveryEvent.contractType,
            deployer: discoveryEvent.deployerAddress,
            currentCodeHash: discoveryEvent.codeHash,
            initialRiskScore: discoveryEvent.initialRiskScore,
          });

          knownContracts.set(addr, healthSerial);

          await inftService.publishToAuditLog("INFT_MINTED", {
            collection: "contractHealth",
            serialNumber: healthSerial,
            contractAddress: discoveryEvent.contractAddress,
            state: "UNAUDITED",
          });

          console.log(`  [NEW] Contract Health iNFT created for ${discoveryEvent.contractAddress}`);
        } else {
          console.log(`  [EXISTS] Contract Health iNFT already exists (serial #${knownContracts.get(addr)})`);
        }

        console.log(`  --- Processing complete (${messageCount} total messages) ---`);
      } catch (err) {
        console.error(`  [ERROR] Failed to process discovery: ${err.message}`);
      }
    });

  // Keep the process running
  console.log("  Listener active. Press Ctrl+C to stop.\n");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Shutting down listener...");
    inftService.close();
    mirrorClient.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    inftService.close();
    mirrorClient.close();
    process.exit(0);
  });
}

module.exports = { parseDiscoveryMessage, knownContracts };

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n  Fatal: ${error.message}`);
    process.exit(1);
  });
}
