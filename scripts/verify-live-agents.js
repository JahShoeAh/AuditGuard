const fs = require("fs");
const path = require("path");
const { loadRuntimeEnv, summarizeCredentialConflict } = require("./env-policy.js");
const runtimeEnv = loadRuntimeEnv({
  allowAgentCredentialOverrides:
    String(process.env.ALLOW_AGENT_ENV_CREDENTIAL_OVERRIDE || "").toLowerCase() === "true",
});

const { ethers } = require("ethers");
const {
  AccountId,
  PrivateKey,
  Client,
  AccountBalanceQuery,
  TokenId,
} = require("@hashgraph/sdk");

const HEDERA_RPC = process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api";
const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };
const RPC_TIMEOUT_MS = Number(process.env.LIVE_PREFLIGHT_RPC_TIMEOUT_MS || "30000");
const SDK_CONFIG_PATH = path.join(__dirname, "..", "packages", "sdk", "config.json");
const AGENT_REGISTRY_ABI_PATH = path.join(__dirname, "..", "packages", "sdk", "abis", "AgentRegistry.json");

const AGENTS = [
  { prefix: "SCANNER", legacyPrefix: "SCANNER_AGENT", required: true, id: "scanner-001" },
  { prefix: "STATIC", legacyPrefix: "AUDITOR_AGENT_1", required: true, id: "static-analysis-047" },
  { prefix: "FUZZER", legacyPrefix: "AUDITOR_AGENT_2", required: true, id: "fuzzer-012" },
  { prefix: "LLM", legacyPrefix: "AUDITOR_AGENT_3", required: true, id: "llm-contextual-003" },
  { prefix: "DEPENDENCY", required: false, id: "dependency-analyzer-008" },
  { prefix: "REPORT", required: false, id: "report-aggregator-001" },
  { prefix: "ALERT", required: false, id: "alert-sentinel-001" },
];

function logEnvCredentialPolicy() {
  if (runtimeEnv.ignoredCredentialKeys.length > 0) {
    console.log(
      `• Credential authority: root .env (ignored ${runtimeEnv.ignoredCredentialKeys.length} credential override keys from agents/.env)`
    );
  } else {
    console.log("• Credential authority: root .env");
  }
  if (runtimeEnv.credentialConflicts.length > 0) {
    const rendered = runtimeEnv.credentialConflicts
      .map((entry) => summarizeCredentialConflict(entry))
      .join(" | ");
    console.log(`⚠ Credential drift detected between .env and agents/.env: ${rendered}`);
  }
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

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyFailure(reason) {
  const normalized = String(reason || "").toLowerCase();
  if (normalized.includes("all nodes are unhealthy")) return "network_unhealthy";
  if (normalized.includes("bad gateway")) return "network_unhealthy";
  if (normalized.includes("server response 502")) return "network_unhealthy";
  if (normalized.includes("service unavailable")) return "network_unhealthy";
  if (normalized.includes("timed out")) return "network_timeout";
  if (normalized.includes("network connectivity")) return "network_unhealthy";
  if (normalized.includes("insufficient funds for transfer")) return "insufficient_payer_hbar";
  if (normalized.includes("insufficient_payer_balance")) return "insufficient_payer_hbar";
  if (normalized.includes("nonce too low")) return "nonce_too_low";
  if (normalized.includes("missing_credentials")) return "missing_credentials";
  if (normalized.includes("invalid")) return "invalid_input";
  return "unknown_failure";
}

async function main() {
  logEnvCredentialPolicy();
  const sdk = loadSdkConfig();
  const guardTokenId = sdk?.guardTokenId;
  const agentRegistry = sdk?.contracts?.agentRegistry?.evmAddress;
  if (!guardTokenId) throw new Error("packages/sdk/config.json missing guardTokenId");
  if (!agentRegistry || !ethers.isAddress(agentRegistry)) {
    throw new Error("packages/sdk/config.json missing valid contracts.agentRegistry.evmAddress");
  }

  const operatorId = process.env.HEDERA_ACCOUNT_ID || process.env.OPERATOR_ACCOUNT_ID;
  const operatorKeyRaw = process.env.HEDERA_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
  if (!operatorId || !operatorKeyRaw) {
    throw new Error("Set HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY (or OPERATOR_*) in .env");
  }

  const operatorKey = parsePrivateKey(operatorKeyRaw, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const hederaClient = Client.forTestnet();
  hederaClient.setOperator(AccountId.fromString(operatorId), operatorKey);

  const provider = new ethers.JsonRpcProvider(HEDERA_RPC, HEDERA_NETWORK, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
  const registry = new ethers.Contract(agentRegistry, loadAgentRegistryAbi(), provider);
  const tokenId = TokenId.fromString(guardTokenId);

  const results = [];
  let hasFailure = false;

  console.log("Verifying live agent readiness...\n");
  for (const spec of AGENTS) {
    const creds = getAgentCredentials(spec);
    if (!creds) {
      const msg = `${spec.id}: missing ${spec.prefix}_ACCOUNT_ID/PRIVATE_KEY`;
      const reasonCode = "missing_credentials";
      if (spec.required) {
        hasFailure = true;
        results.push({ agentId: spec.id, ok: false, required: true, reasonCode, reason: `missing_credentials: ${msg}` });
      } else {
        results.push({ agentId: spec.id, ok: true, required: false, reasonCode: "skipped", reason: `skipped: ${msg}` });
      }
      continue;
    }

    try {
      const wallet = new ethers.Wallet(creds.privateKey.startsWith("0x") ? creds.privateKey : `0x${creds.privateKey}`);
      const accountId = AccountId.fromString(creds.accountId);
      const balance = await withTimeout(
        new AccountBalanceQuery().setAccountId(accountId).execute(hederaClient),
        RPC_TIMEOUT_MS,
        `balance query for ${spec.id}`
      );
      const tokenBalance = balance.tokens?.get(tokenId);
      const guardRaw = tokenBalance ? Number(tokenBalance.toString()) : 0;
      const guard = guardRaw / 1e8;
      const isActive = await withTimeout(
        registry.isActiveAgent(wallet.address),
        RPC_TIMEOUT_MS,
        `AgentRegistry.isActiveAgent for ${spec.id}`
      );
      const ok = isActive && guardRaw > 0;
      if (!ok && spec.required) hasFailure = true;
      let reasonCode = "ready";
      if (!isActive) reasonCode = "agent_inactive";
      else if (guardRaw <= 0) reasonCode = "unfunded_guard";
      const inactiveWithBalanceHint = !isActive && guardRaw > 0 ? " hint=inactive_with_balance" : "";

      results.push({
        agentId: spec.id,
        ok,
        required: !!spec.required,
        reasonCode,
        reason:
          `${reasonCode}: account=${accountId.toString()} address=${wallet.address} ` +
          `active=${isActive} guard=${guard.toFixed(4)}${inactiveWithBalanceHint}`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const reasonCode = classifyFailure(reason);
      if (spec.required) hasFailure = true;
      results.push({ agentId: spec.id, ok: false, required: !!spec.required, reasonCode, reason: `${reasonCode}: ${reason}` });
    }
  }

  for (const row of results) {
    const mark = row.ok ? "OK " : "ERR";
    console.log(`${mark}  ${row.agentId.padEnd(28)} ${row.reason}`);
  }

  const reasonSummary = new Map();
  for (const row of results) {
    const key = row.reasonCode || (row.ok ? "ready" : "unknown_failure");
    const curr = reasonSummary.get(key) || { total: 0, required: 0, agents: [] };
    curr.total += 1;
    if (!row.ok && row.required) curr.required += 1;
    curr.agents.push(row.agentId);
    reasonSummary.set(key, curr);
  }

  console.log("\nReason summary:");
  for (const [reasonCode, info] of Array.from(reasonSummary.entries()).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `• ${reasonCode.padEnd(26)} total=${String(info.total).padStart(2)} ` +
      `required_failures=${String(info.required).padStart(2)} agents=${info.agents.join(", ")}`
    );
  }

  hederaClient.close();

  if (hasFailure) {
    const requiredFailures = results.filter((row) => !row.ok && row.required);
    const detail = requiredFailures.map((row) => `${row.agentId}:${row.reasonCode}`).join(" | ");
    throw new Error(
      `verify-live-agents failed: one or more required agents are missing, unfunded, or inactive. Details: ${detail}`
    );
  }
  console.log("\nverify-live-agents passed");
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
