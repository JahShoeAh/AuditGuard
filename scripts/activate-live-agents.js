const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { ethers } = require("ethers");
const {
  AccountId,
  PrivateKey,
  Client,
  TokenAssociateTransaction,
  TransferTransaction,
  TokenId,
} = require("@hashgraph/sdk");

const HEDERA_RPC = process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api";
const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };
const SDK_CONFIG_PATH = path.join(__dirname, "..", "packages", "sdk", "config.json");
const AGENT_REGISTRY_ABI_PATH = path.join(__dirname, "..", "packages", "sdk", "abis", "AgentRegistry.json");
const GUARD_DECIMALS = 8;

const GUARD_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const AGENTS = [
  {
    prefix: "SCANNER",
    legacyPrefix: "SCANNER_AGENT",
    required: true,
    agentId: "scanner-001",
    endpointEnv: "SCANNER_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://scanner-001",
    specializations: ["lending", "dex", "bridge", "staking", "vault"],
    stakeGuard: 100,
    minLiquidGuard: 150,
  },
  {
    prefix: "STATIC",
    legacyPrefix: "AUDITOR_AGENT_1",
    required: true,
    agentId: "static-analysis-047",
    endpointEnv: "STATIC_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://static-analysis-047",
    specializations: ["static_analysis", "lending", "vault", "staking"],
    stakeGuard: 100,
    minLiquidGuard: 200,
  },
  {
    prefix: "FUZZER",
    legacyPrefix: "AUDITOR_AGENT_2",
    required: true,
    agentId: "fuzzer-012",
    endpointEnv: "FUZZER_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://fuzzer-012",
    specializations: ["fuzzing", "dex", "bridge"],
    stakeGuard: 100,
    minLiquidGuard: 200,
  },
  {
    prefix: "LLM",
    legacyPrefix: "AUDITOR_AGENT_3",
    required: true,
    agentId: "llm-contextual-003",
    endpointEnv: "LLM_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://llm-contextual-003",
    specializations: ["llm_contextual", "lending", "bridge"],
    stakeGuard: 100,
    minLiquidGuard: 200,
  },
  {
    prefix: "DEPENDENCY",
    required: false,
    agentId: "dependency-analyzer-008",
    endpointEnv: "DEPENDENCY_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://dependency-analyzer-008",
    specializations: ["dependency_analysis"],
    stakeGuard: 100,
    minLiquidGuard: 120,
  },
  {
    prefix: "REPORT",
    required: false,
    agentId: "report-aggregator-001",
    endpointEnv: "REPORT_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://report-aggregator-001",
    specializations: ["reporting", "aggregation"],
    stakeGuard: 100,
    minLiquidGuard: 120,
  },
  {
    prefix: "ALERT",
    required: false,
    agentId: "alert-sentinel-001",
    endpointEnv: "ALERT_UCP_ENDPOINT",
    defaultEndpoint: "openclaw://alert-sentinel-001",
    specializations: ["alerting", "monitoring"],
    stakeGuard: 100,
    minLiquidGuard: 120,
  },
];

function toTokenUnits(amountGuard) {
  return BigInt(Math.floor(Number(amountGuard) * 10 ** GUARD_DECIMALS));
}

function fromTokenUnits(amountWei) {
  return Number(amountWei) / 10 ** GUARD_DECIMALS;
}

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

function normalizeEvmPrivateKey(rawKey) {
  const key = String(rawKey || "").trim().replace(/^['"]|['"]$/g, "");
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error("Expected ECDSA private key in 32-byte hex format");
  }
  return `0x${stripped}`;
}

function getEnvValue(prefix, legacyPrefix, suffix) {
  return process.env[`${prefix}_${suffix}`] || (legacyPrefix ? process.env[`${legacyPrefix}_${suffix}`] : undefined);
}

function getAgentCredentials(spec) {
  const accountId = getEnvValue(spec.prefix, spec.legacyPrefix, "ACCOUNT_ID");
  const privateKey = getEnvValue(spec.prefix, spec.legacyPrefix, "PRIVATE_KEY");
  if (!accountId || !privateKey) return null;
  return { accountId, privateKey };
}

function loadSdkConfig() {
  if (!fs.existsSync(SDK_CONFIG_PATH)) {
    throw new Error(`Missing SDK config at ${SDK_CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(SDK_CONFIG_PATH, "utf8"));
}

function loadAgentRegistryAbi() {
  const raw = JSON.parse(fs.readFileSync(AGENT_REGISTRY_ABI_PATH, "utf8"));
  return raw.abi || raw;
}

async function associateTokenForAgent(client, tokenId, accountId, privateKey, label) {
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .freezeWith(client);
    const signed = await tx.sign(privateKey);
    const res = await signed.execute(client);
    await res.getReceipt(client);
    console.log(`    ✓ ${label}: token association complete`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const normalized = msg.toLowerCase();
    if (
      normalized.includes("token already associated") ||
      normalized.includes("already associated") ||
      normalized.includes("token_already_associated_to_account")
    ) {
      console.log(`    • ${label}: token already associated`);
      return;
    }
    throw err;
  }
}

async function transferGuard(client, tokenId, operatorId, targetId, amountWei, label) {
  if (amountWei <= 0n) return;
  const amountInt64 = Number(amountWei);
  const tx = await new TransferTransaction()
    .addTokenTransfer(tokenId, operatorId, -amountInt64)
    .addTokenTransfer(tokenId, targetId, amountInt64)
    .freezeWith(client);
  const res = await tx.execute(client);
  await res.getReceipt(client);
  console.log(`    ✓ ${label}: funded +${fromTokenUnits(amountWei).toFixed(4)} GUARD`);
}

async function main() {
  const sdk = loadSdkConfig();
  const guardTokenId = sdk?.guardTokenId;
  const guardTokenEvm = sdk?.guardTokenEvmAddress;
  const agentRegistryAddress = sdk?.contracts?.agentRegistry?.evmAddress;

  if (!guardTokenId) throw new Error("packages/sdk/config.json missing guardTokenId");
  if (!guardTokenEvm || !ethers.isAddress(guardTokenEvm)) {
    throw new Error("packages/sdk/config.json missing valid guardTokenEvmAddress");
  }
  if (!agentRegistryAddress || !ethers.isAddress(agentRegistryAddress)) {
    throw new Error("packages/sdk/config.json missing valid contracts.agentRegistry.evmAddress");
  }

  const operatorIdRaw = process.env.HEDERA_ACCOUNT_ID || process.env.OPERATOR_ACCOUNT_ID;
  const operatorKeyRaw = process.env.HEDERA_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
  if (!operatorIdRaw || !operatorKeyRaw) {
    throw new Error("Set HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY (or OPERATOR_*) in .env");
  }

  const operatorId = AccountId.fromString(operatorIdRaw);
  const operatorKey = parsePrivateKey(operatorKeyRaw, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const hederaClient = Client.forTestnet();
  hederaClient.setOperator(operatorId, operatorKey);

  const provider = new ethers.JsonRpcProvider(HEDERA_RPC, HEDERA_NETWORK, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
  const operatorEvmWallet = new ethers.Wallet(normalizeEvmPrivateKey(operatorKeyRaw), provider);
  const registry = new ethers.Contract(agentRegistryAddress, loadAgentRegistryAbi(), operatorEvmWallet);
  const guardToken = new ethers.Contract(guardTokenEvm, GUARD_ABI, operatorEvmWallet);
  const tokenId = TokenId.fromString(guardTokenId);

  let hasFailure = false;
  console.log("Activating live agents against current deployment...\n");

  // AgentRegistry.registerAgent() uses HTS.transferToken(..., to=AgentRegistry).
  // Ensure registry contract is token-associated first, otherwise all registrations revert.
  try {
    const tx = await registry.associateGuardToken();
    await tx.wait();
    console.log("✓ AgentRegistry: GUARD token associated");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const normalized = msg.toLowerCase();
    if (
      normalized.includes("already associated") ||
      normalized.includes("token_already_associated_to_account")
    ) {
      console.log("• AgentRegistry: GUARD token already associated");
    } else {
      throw new Error(`AgentRegistry.associateGuardToken failed: ${msg}`);
    }
  }

  for (const spec of AGENTS) {
    const creds = getAgentCredentials(spec);
    if (!creds) {
      const msg = `${spec.agentId}: missing ${spec.prefix}_ACCOUNT_ID/PRIVATE_KEY`;
      if (spec.required) {
        hasFailure = true;
        console.log(`ERR  ${msg}`);
      } else {
        console.log(`SKIP ${msg}`);
      }
      continue;
    }

    try {
      const agentAccountId = AccountId.fromString(creds.accountId);
      const agentHederaKey = parsePrivateKey(
        creds.privateKey,
        process.env[`${spec.prefix}_PRIVATE_KEY_TYPE`] || process.env.AGENT_PRIVATE_KEY_TYPE
      );
      const agentEvmWallet = new ethers.Wallet(normalizeEvmPrivateKey(creds.privateKey), provider);
      const registryFromAgent = registry.connect(agentEvmWallet);
      const guardFromAgent = guardToken.connect(agentEvmWallet);
      const stakeWei = toTokenUnits(spec.stakeGuard);
      const minLiquidWei = toTokenUnits(spec.minLiquidGuard);
      const minTotalWei = stakeWei + minLiquidWei;
      const endpoint = process.env[spec.endpointEnv] || spec.defaultEndpoint;

      console.log(`• ${spec.agentId} (${agentEvmWallet.address})`);

      await associateTokenForAgent(hederaClient, tokenId, agentAccountId, agentHederaKey, spec.agentId);

      let balanceWei = await guardToken.balanceOf(agentEvmWallet.address);
      if (balanceWei < minTotalWei) {
        const topup = minTotalWei - balanceWei;
        await transferGuard(hederaClient, tokenId, operatorId, agentAccountId, topup, spec.agentId);
        balanceWei = await guardToken.balanceOf(agentEvmWallet.address);
      } else {
        console.log(`    • ${spec.agentId}: balance ok (${fromTokenUnits(balanceWei).toFixed(4)} GUARD)`);
      }

      try {
        const allowance = await guardFromAgent.allowance(agentEvmWallet.address, agentRegistryAddress);
        if (allowance < stakeWei) {
          const tx = await guardFromAgent.approve(agentRegistryAddress, stakeWei);
          await tx.wait();
          console.log(`    ✓ ${spec.agentId}: approved ${spec.stakeGuard} GUARD to AgentRegistry`);
        } else {
          console.log(`    • ${spec.agentId}: allowance already set`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    ⚠ ${spec.agentId}: approve skipped (${msg})`);
      }

      let active = await registry.isActiveAgent(agentEvmWallet.address);
      if (!active) {
        try {
          const tx = await registryFromAgent.registerAgent(
            spec.agentId,
            endpoint,
            spec.specializations,
            stakeWei
          );
          await tx.wait();
          console.log(`    ✓ ${spec.agentId}: on-chain registration succeeded`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`    ⚠ ${spec.agentId}: registerAgent attempt returned: ${msg}`);
        }
        active = await registry.isActiveAgent(agentEvmWallet.address);
      } else {
        console.log(`    • ${spec.agentId}: already active`);
      }

      const finalBalanceWei = await guardToken.balanceOf(agentEvmWallet.address);
      const ok = active && finalBalanceWei > 0n;
      if (!ok && spec.required) hasFailure = true;
      console.log(
        `${ok ? "OK " : "ERR"}  ${spec.agentId.padEnd(28)} active=${active} guard=${fromTokenUnits(finalBalanceWei).toFixed(4)}`
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (spec.required) hasFailure = true;
      console.log(`ERR  ${spec.agentId.padEnd(28)} ${reason}`);
    }
  }

  hederaClient.close();

  if (hasFailure) {
    throw new Error("activate-live-agents failed: one or more required agents are still inactive or unfunded");
  }

  console.log("\nactivate-live-agents completed");
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
