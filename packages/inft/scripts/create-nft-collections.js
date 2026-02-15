/**
 * One-time setup: Create HTS NFT collections for the three AuditGuard iNFT types.
 *
 * Creates:
 *   1. AuditGuard-AuditJob   — minted per discovered contract / audit job
 *   2. AuditGuard-AgentProfile — minted per registered auditor agent
 *   3. AuditGuard-ContractHealth — minted per audited smart contract
 *
 * Persists collection token IDs to packages/sdk/config.json under "inftCollections".
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const {
  Client,
  AccountId,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  Hbar,
} = require("@hashgraph/sdk");

const CONFIG_PATH = path.join(__dirname, "..", "..", "sdk", "config.json");

const COLLECTIONS = [
  {
    key: "auditJob",
    name: "AuditGuard Audit Job iNFT",
    symbol: "AG-JOB",
    memo: "Evolving iNFT tracking autonomous audit job lifecycle",
  },
  {
    key: "agentProfile",
    name: "AuditGuard Agent Profile iNFT",
    symbol: "AG-AGENT",
    memo: "Evolving iNFT representing auditor agent identity and reputation",
  },
  {
    key: "contractHealth",
    name: "AuditGuard Contract Health iNFT",
    symbol: "AG-HEALTH",
    memo: "Evolving iNFT tracking smart contract security health",
  },
];

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
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       AuditGuard iNFT Collection Setup (Hedera Testnet)     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    throw new Error("Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env");
  }

  const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const operatorKey = parsePrivateKey(
    process.env.HEDERA_PRIVATE_KEY,
    process.env.HEDERA_PRIVATE_KEY_TYPE
  );

  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(20));

  const config = readConfig();
  config.inftCollections = config.inftCollections || {};

  try {
    for (const col of COLLECTIONS) {
      // Skip if already created
      if (config.inftCollections[col.key]) {
        console.log(`  Reusing existing ${col.symbol}: ${config.inftCollections[col.key].tokenId}`);
        continue;
      }

      console.log(`\n  Creating collection: ${col.name} (${col.symbol})`);

      const tx = await new TokenCreateTransaction()
        .setTokenName(col.name)
        .setTokenSymbol(col.symbol)
        .setTokenMemo(col.memo)
        .setTokenType(TokenType.NonFungibleUnique)
        .setSupplyType(TokenSupplyType.Infinite)
        .setInitialSupply(0)
        .setDecimals(0)
        .setTreasuryAccountId(operatorId)
        .setAdminKey(operatorKey.publicKey)
        .setSupplyKey(operatorKey.publicKey)
        .setMaxTransactionFee(new Hbar(20))
        .freezeWith(client);

      const signed = await tx.sign(operatorKey);
      const response = await signed.execute(client);
      const receipt = await response.getReceipt(client);
      const tokenId = receipt.tokenId;

      if (!tokenId) {
        throw new Error(`No token ID returned for ${col.name}`);
      }

      const evmAddress = `0x${tokenId.toSolidityAddress()}`;
      config.inftCollections[col.key] = {
        tokenId: tokenId.toString(),
        evmAddress,
      };

      console.log(`    Token ID: ${tokenId.toString()}`);
      console.log(`    EVM Address: ${evmAddress}`);

      writeConfig(config);
    }

    console.log("\n  iNFT collections summary:");
    console.log("  ┌──────────────────┬──────────────────┐");
    console.log("  │ Collection       │ Token ID         │");
    console.log("  ├──────────────────┼──────────────────┤");
    for (const col of COLLECTIONS) {
      const info = config.inftCollections[col.key];
      const id = info ? info.tokenId : "-";
      console.log(`  │ ${col.symbol.padEnd(16)} │ ${id.padEnd(16)} │`);
    }
    console.log("  └──────────────────┴──────────────────┘");
    console.log(`\n  Config saved to ${CONFIG_PATH}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n  Failed: ${error.message}`);
  process.exit(1);
});
