const fs = require("fs");
const path = require("path");
const { loadRuntimeEnv, summarizeCredentialConflict } = require("./env-policy.js");
const { verifyAccountKeyPair } = require("./account-identity.js");
const runtimeEnv = loadRuntimeEnv({
  allowAgentCredentialOverrides:
    String(process.env.ALLOW_AGENT_ENV_CREDENTIAL_OVERRIDE || "").toLowerCase() === "true",
});

const { ethers } = require("ethers");
const {
  AccountId,
  ContractId,
  Hbar,
  PrivateKey,
  Client,
  AccountBalanceQuery,
  ContractExecuteTransaction,
  TokenAssociateTransaction,
  TransferTransaction,
  TokenId,
  Status,
} = require("@hashgraph/sdk");

const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };
const SDK_CONFIG_PATH = path.join(__dirname, "..", "packages", "sdk", "config.json");
const AGENT_REGISTRY_ABI_PATH = path.join(__dirname, "..", "packages", "sdk", "abis", "AgentRegistry.json");
const HTS_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000167";
const HTS_PRECOMPILE_ABI = ["function associateToken(address account, address token) external returns (int64)"];
const GUARD_DECIMALS = 8;
const RPC_TIMEOUT_MS = Number(process.env.LIVE_PREFLIGHT_RPC_TIMEOUT_MS || "15000");
const DEFAULT_RPC_URL = "https://testnet.hashio.io/api";
const MIN_ACTIVATION_PAYER_HBAR = Number(process.env.MIN_ACTIVATION_PAYER_HBAR || "0.5");
const OPERATOR_HBAR_TARGET = Number(process.env.OPERATOR_HBAR_TARGET || "2.5");
const OPERATOR_TOPUP_DONOR_MIN_HBAR = Number(process.env.OPERATOR_TOPUP_DONOR_MIN_HBAR || "1.5");
const ENABLE_OPERATOR_HBAR_AUTOTOPUP = process.env.ENABLE_OPERATOR_HBAR_AUTOTOPUP !== "false";
const MIN_REGISTRY_HBAR = Number(process.env.MIN_REGISTRY_HBAR || "2");
const MIN_AGENT_PAYER_HBAR = Number(process.env.MIN_AGENT_PAYER_HBAR || "0.25");
const TARGET_AGENT_PAYER_HBAR = Number(process.env.TARGET_AGENT_PAYER_HBAR || "1.0");
const AGENT_ACTIVATION_RETRY_MAX = Number(process.env.AGENT_ACTIVATION_RETRY_MAX || "3");
const AGENT_ACTIVATION_RETRY_BASE_MS = Number(process.env.AGENT_ACTIVATION_RETRY_BASE_MS || "1200");
const ACTIVATE_GUARD_TRANSFER_RETRY_MAX = Number(process.env.ACTIVATE_GUARD_TRANSFER_RETRY_MAX || "3");
const ACTIVATE_GUARD_TRANSFER_RETRY_BASE_MS = Number(process.env.ACTIVATE_GUARD_TRANSFER_RETRY_BASE_MS || "900");
const ACTIVATE_GUARD_TRANSFER_GAS_LIMIT = BigInt(process.env.ACTIVATE_GUARD_TRANSFER_GAS_LIMIT || "250000");
const ACTIVATE_GUARD_FALLBACK_HAPI_TRANSFER = process.env.ACTIVATE_GUARD_FALLBACK_HAPI_TRANSFER !== "false";
const MIRROR_TIMEOUT_MS = Number(process.env.LIVE_PREFLIGHT_MIRROR_TIMEOUT_MS || "8000");
const DEFAULT_MIRROR_BASE_URL = "https://testnet.mirrornode.hedera.com";

const GUARD_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const DATA_MARKETPLACE_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function agentRegistry() view returns (address)",
  "function setAgentRegistry(address _agentRegistry)",
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

function sourceForKey(key) {
  return runtimeEnv.keySources[key] || "process";
}

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

function deriveAddressFromPrivateKey(rawKey) {
  return new ethers.Wallet(normalizeEvmPrivateKey(rawKey)).address.toLowerCase();
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

function warnOnSharedOperatorAndScannerPayer(operatorAccountIdRaw) {
  const scannerSpec = AGENTS.find((spec) => spec.agentId === "scanner-001");
  if (!scannerSpec) return;
  const scannerCreds = getAgentCredentials(scannerSpec);
  if (!scannerCreds?.accountId) return;
  if (String(scannerCreds.accountId) !== String(operatorAccountIdRaw)) return;
  console.warn(
    "⚠ scanner-001 shares payer account with orchestrator/operator. " +
    "This can cause nonce contention and intermittent invite/bid failures."
  );
}

function getAgentKeyTypeHint(spec) {
  return (
    getEnvValue(spec.prefix, spec.legacyPrefix, "PRIVATE_KEY_TYPE") ||
    process.env.AGENT_PRIVATE_KEY_TYPE ||
    process.env.HEDERA_PRIVATE_KEY_TYPE
  );
}

async function checkAgentIdentityPair(spec, creds) {
  const allowMismatch = String(process.env.ALLOW_ACCOUNT_KEY_MISMATCH || "").toLowerCase() === "true";
  const result = await verifyAccountKeyPair({
    accountId: creds.accountId,
    privateKey: creds.privateKey,
    mirrorBaseUrl: process.env.HEDERA_MIRROR_URL || DEFAULT_MIRROR_BASE_URL,
    timeoutMs: MIRROR_TIMEOUT_MS,
  });

  const mirrorDisplay = result.mirrorAddress || "unavailable";
  const derivedDisplay = result.derivedAddress || "unavailable";
  if (result.ok) {
    console.log(
      `    • ${spec.agentId}: identity verified account=${result.accountId} ` +
      `derived=${derivedDisplay} mirror=${mirrorDisplay}`
    );
    return { ok: true, reasonCode: "account_key_pair_ok", detail: result.detail };
  }

  if (result.reasonCode === "account_key_pair_mismatch") {
    const message =
      `account_key_pair_mismatch: account=${result.accountId} derived=${derivedDisplay} mirror=${mirrorDisplay}`;
    if (allowMismatch) {
      console.log(`    ⚠ ${spec.agentId}: ${message} (ALLOW_ACCOUNT_KEY_MISMATCH=true)`);
      return { ok: true, reasonCode: "account_key_pair_mismatch_bypassed", detail: message };
    }
    return { ok: false, reasonCode: "account_key_pair_mismatch", detail: message };
  }

  console.log(
    `    ⚠ ${spec.agentId}: identity unverified (${result.reasonCode}) ` +
    `account=${result.accountId} derived=${derivedDisplay} detail=${result.detail}`
  );
  return { ok: true, reasonCode: result.reasonCode, detail: result.detail };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRpcCandidates() {
  const primary =
    process.env.HEDERA_JSON_RPC_URL ||
    process.env.HEDERA_RPC_URL ||
    DEFAULT_RPC_URL;
  const fallbackRaw = process.env.HEDERA_JSON_RPC_FALLBACK_URLS || "";
  const fallbacks = fallbackRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set([primary, ...fallbacks]));
}

function isNetworkLikeError(reason) {
  const normalized = String(reason || "").toLowerCase();
  return (
    normalized.includes("enotfound") ||
    normalized.includes("name resolution failed") ||
    normalized.includes("all nodes are unhealthy") ||
    normalized.includes("network connectivity") ||
    normalized.includes("fetch failed") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("bad gateway") ||
    normalized.includes("server response 502") ||
    normalized.includes("server response 503") ||
    normalized.includes("server response 504") ||
    normalized.includes("gateway") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("429")
  );
}

function getOwnerCredentialCandidates() {
  return [
    {
      label: "AGENT_REGISTRY_OWNER_PRIVATE_KEY",
      privateKey: process.env.AGENT_REGISTRY_OWNER_PRIVATE_KEY,
      accountId: process.env.AGENT_REGISTRY_OWNER_ACCOUNT_ID,
    },
    {
      label: "ORCHESTRATOR_PRIVATE_KEY",
      privateKey: process.env.ORCHESTRATOR_PRIVATE_KEY,
      accountId: process.env.ORCHESTRATOR_ACCOUNT_ID,
    },
    {
      label: "OPERATOR_PRIVATE_KEY",
      privateKey: process.env.OPERATOR_PRIVATE_KEY,
      accountId: process.env.OPERATOR_ACCOUNT_ID,
    },
    {
      label: "HEDERA_PRIVATE_KEY",
      privateKey: process.env.HEDERA_PRIVATE_KEY,
      accountId: process.env.HEDERA_ACCOUNT_ID,
    },
  ].filter((item) => item.privateKey);
}

function normalizeHtsCode(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    if (!Number.isNaN(parsed)) return parsed;
  }
  return NaN;
}

function isHtsAssociateOk(code) {
  return code === 0 || code === 194; // SUCCESS or TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
}

function htsStatusName(code) {
  for (const key of Object.keys(Status)) {
    const val = Status[key];
    if (val && typeof val === "object" && "_code" in val && val._code === code) {
      return val.toString();
    }
  }
  return `UNKNOWN_STATUS_${code}`;
}

function isNumericEntityId(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || ""));
}

function resolveRegistryIdCandidates(sdkRegistryId, _agentRegistryAddress) {
  const out = new Set();
  if (isNumericEntityId(sdkRegistryId)) out.add(String(sdkRegistryId));
  return Array.from(out);
}

function toSolidityAddressFromContractId(contractIdLike) {
  if (!contractIdLike) return null;
  try {
    const cid = ContractId.fromString(String(contractIdLike));
    return `0x${cid.toSolidityAddress()}`;
  } catch {
    return null;
  }
}

async function withFetchTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRegistryIdViaMirror(agentRegistryAddress) {
  const base = (process.env.HEDERA_MIRROR_NODE_URL || DEFAULT_MIRROR_BASE_URL).replace(/\/+$/, "");
  const target = String(agentRegistryAddress || "").toLowerCase();
  if (!target) return null;
  try {
    const payload = await withFetchTimeout(`${base}/api/v1/contracts/${target}`, MIRROR_TIMEOUT_MS);
    if (payload?.contract_id) return String(payload.contract_id);
  } catch {
    // mirror lookup is best effort
  }
  return null;
}

async function inspectAccountTokenRelation(client, accountIdLike, tokenId) {
  try {
    const accountId = AccountId.fromString(String(accountIdLike));
    const balance = await withTimeout(
      new AccountBalanceQuery().setAccountId(accountId).execute(client),
      RPC_TIMEOUT_MS,
      `AccountBalanceQuery for ${accountIdLike}`
    );
    const tokenMap = balance?.tokens;
    const keys = Array.from(tokenMap?.keys?.() ?? []);
    const matched = keys.find((id) => String(id) === String(tokenId));
    const associated = Boolean(matched);
    const tokenBalance = matched ? tokenMap.get(matched) : null;
    return {
      accountId: String(accountIdLike),
      associated,
      tokenBalance: tokenBalance != null ? String(tokenBalance) : null,
      error: null,
    };
  } catch (err) {
    return {
      accountId: String(accountIdLike),
      associated: null,
      tokenBalance: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pickNumericRegistryId(registryIdCandidates) {
  return (registryIdCandidates || []).find((value) => isNumericEntityId(value));
}

async function executeAssociateViaHapi(ownerAccountIdRaw, ownerPrivateKeyRaw, registryContractIdRaw, gasLimit) {
  const ownerAccountId = AccountId.fromString(ownerAccountIdRaw);
  const ownerPrivateKey = parsePrivateKey(ownerPrivateKeyRaw, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const registryContractId = ContractId.fromString(registryContractIdRaw);
  const client = createHederaClient(ownerAccountId, ownerPrivateKey);
  try {
    const tx = await new ContractExecuteTransaction()
      .setContractId(registryContractId)
      .setGas(Number(gasLimit))
      .setFunction("associateGuardToken")
      .freezeWith(client);
    const signed = await tx.sign(ownerPrivateKey);
    const submit = await signed.execute(client);
    const receipt = await submit.getReceipt(client);
    return String(receipt.status);
  } finally {
    client.close();
  }
}

async function probeRegistryGuardTransfer(client, tokenId, operatorId, operatorKey, registryAccountIdRaw, amount = 1) {
  const registryAccountId = AccountId.fromString(registryAccountIdRaw);
  const tx = await new TransferTransaction()
    .addTokenTransfer(tokenId, operatorId, -Number(amount))
    .addTokenTransfer(tokenId, registryAccountId, Number(amount))
    .freezeWith(client);
  const signed = await tx.sign(operatorKey);
  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);
  return String(receipt.status);
}

async function ensureRegistryHbar(client, operatorId, operatorKey, registryAccountIdRaw, minHbar = MIN_REGISTRY_HBAR) {
  const registryAccountId = AccountId.fromString(registryAccountIdRaw);
  const bal = await withTimeout(
    new AccountBalanceQuery().setAccountId(registryAccountId).execute(client),
    RPC_TIMEOUT_MS,
    `registry HBAR balance query (${registryAccountIdRaw})`
  );
  const currentTinybars = BigInt(bal?.hbars?.toTinybars?.().toString?.() ?? "0");
  const minTinybars = BigInt(Math.floor(Number(minHbar) * 1e8));
  if (currentTinybars >= minTinybars) {
    console.log(`• Registry HBAR balance OK (${Number(currentTinybars) / 1e8} HBAR)`);
    return;
  }
  const topupTinybars = minTinybars - currentTinybars;
  const tx = await new TransferTransaction()
    .addHbarTransfer(operatorId, Hbar.fromTinybars(-topupTinybars))
    .addHbarTransfer(registryAccountId, Hbar.fromTinybars(topupTinybars))
    .freezeWith(client);
  const signed = await tx.sign(operatorKey);
  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);
  console.log(
    `✓ Registry HBAR topped up by ${(Number(topupTinybars) / 1e8).toFixed(4)} HBAR (status=${String(receipt.status)})`
  );
}

function logInvalidOwnerKeyWarnings() {
  const raw = process.env.AGENT_REGISTRY_OWNER_PRIVATE_KEY;
  if (!raw) return;
  try {
    normalizeEvmPrivateKey(raw);
  } catch {
    console.log(
      "⚠ AGENT_REGISTRY_OWNER_PRIVATE_KEY is set but is not a valid 32-byte ECDSA private key; " +
      "ignoring it and falling back to other owner-key env vars."
    );
  }
}

function resolveRegistryOwnerSigner(ownerAddress, provider) {
  const ownerLower = String(ownerAddress || "").toLowerCase();
  for (const candidate of getOwnerCredentialCandidates()) {
    try {
      const derivedAddress = deriveAddressFromPrivateKey(candidate.privateKey);
      if (derivedAddress === ownerLower) {
        return {
          label: candidate.label,
          wallet: new ethers.Wallet(normalizeEvmPrivateKey(candidate.privateKey), provider),
          accountId: candidate.accountId ? String(candidate.accountId) : null,
          privateKeyRaw: candidate.privateKey,
        };
      }
    } catch {
      // ignore invalid key candidates
    }
  }
  return null;
}

async function resolveReachableRpcUrl() {
  const attempts = [];
  for (const rpcUrl of parseRpcCandidates()) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, HEDERA_NETWORK, {
        batchMaxCount: 1,
        staticNetwork: true,
      });
      await withTimeout(provider.send("eth_chainId", []), RPC_TIMEOUT_MS, `eth_chainId on ${rpcUrl}`);
      return rpcUrl;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push(`${rpcUrl} -> ${reason}`);
    }
  }
  throw new Error(
    `No reachable Hedera JSON-RPC endpoint. Tried: ${attempts.join(" | ")}. ` +
    `Set HEDERA_JSON_RPC_URL (and optionally HEDERA_JSON_RPC_FALLBACK_URLS).`
  );
}

async function associateTokenForAgent(client, tokenId, accountId, privateKey, label) {
  const associationPrecheck = await withTimeout(
    new AccountBalanceQuery().setAccountId(accountId).execute(client),
    RPC_TIMEOUT_MS,
    `${label} token association precheck`
  );
  const alreadyAssociated = Array.from(associationPrecheck.tokens?.keys?.() ?? [])
    .some((id) => String(id) === String(tokenId));
  if (alreadyAssociated) {
    console.log(`    • ${label}: token already associated`);
    return;
  }

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

function createHederaClient(accountId, privateKey) {
  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);
  client.setRequestTimeout(RPC_TIMEOUT_MS);
  return client;
}

async function forceAssociateGuardToken(registryContract, contractAddress, gasLimit = 1_500_000n) {
  const data = registryContract.interface.encodeFunctionData("associateGuardToken", []);
  console.log(`• Manual associate calldata: ${data}`);
  const tx = await registryContract.runner.sendTransaction({
    to: contractAddress,
    data,
    gasLimit,
  });
  const receipt = await tx.wait();
  if (!receipt || (receipt.status != null && receipt.status !== 1)) {
    throw new Error(`force associate tx failed (hash=${tx.hash}, status=${receipt?.status ?? "unknown"})`);
  }
  return { txHash: tx.hash, data };
}

async function forceAssociateGuardTokenViaHts(ownerWallet, contractAddress, tokenAddress, gasLimit = 1_500_000n) {
  const hts = new ethers.Contract(HTS_PRECOMPILE_ADDRESS, HTS_PRECOMPILE_ABI, ownerWallet);
  let previewCode = NaN;
  try {
    const preview = await hts.getFunction("associateToken").staticCall(contractAddress, tokenAddress);
    previewCode = normalizeHtsCode(preview);
    if (!Number.isNaN(previewCode) && !isHtsAssociateOk(previewCode)) {
      throw new Error(`HTS preview response ${previewCode} (${htsStatusName(previewCode)})`);
    }
  } catch (err) {
    // Hedera JSON-RPC can return 0x for precompile eth_call responses.
    // Do not fail fast; still submit a real transaction and verify downstream.
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`⚠ HTS preview unavailable for ${contractAddress}: ${msg}`);
  }
  console.log(`• HTS associateToken call: precompile=${HTS_PRECOMPILE_ADDRESS} target=${contractAddress} token=${tokenAddress}`);
  const tx = await hts.associateToken(contractAddress, tokenAddress, { gasLimit });
  const receipt = await tx.wait();
  if (!receipt || (receipt.status != null && receipt.status !== 1)) {
    throw new Error(`direct HTS associateToken tx failed (hash=${tx.hash}, status=${receipt?.status ?? "unknown"})`);
  }
  return { txHash: tx.hash, previewCode };
}

async function forceAssociateViaHtsCandidates(ownerWallet, accountAddresses, tokenAddress, gasLimit = 1_500_000n) {
  const attempted = [];
  const uniqueTargets = Array.from(
    new Set(
      (accountAddresses || [])
        .map((addr) => String(addr || "").trim())
        .filter((addr) => ethers.isAddress(addr))
    )
  );
  for (const target of uniqueTargets) {
    try {
      const result = await forceAssociateGuardTokenViaHts(ownerWallet, target, tokenAddress, gasLimit);
      return { ...result, associatedAccount: target };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempted.push(`${target}: ${msg}`);
    }
  }
  throw new Error(`all HTS account-address attempts failed: ${attempted.join(" | ")}`);
}

function buildRegisterAgentCalldata(registryContract, agentId, endpoint, specializations, stakeWei) {
  const data = registryContract.interface.encodeFunctionData("registerAgent", [
    agentId,
    endpoint,
    specializations,
    stakeWei,
  ]);
  if (!data || data === "0x") {
    throw new Error("registerAgent calldata encoding failed (check AgentRegistry ABI)");
  }
  return data;
}

async function submitRegisterAgentTx(agentWallet, registryAddress, calldata) {
  const tx = await agentWallet.sendTransaction({
    to: registryAddress,
    data: calldata,
  });
  const fromAddress = String(tx.from || agentWallet.address).toLowerCase();
  if (fromAddress !== agentWallet.address.toLowerCase()) {
    throw new Error(
      `registerAgent sender mismatch: expected ${agentWallet.address}, got ${tx.from || "<unknown>"}`
    );
  }
  await tx.wait();
  return tx;
}

function classifyGuardTransferError(reason) {
  const normalized = String(reason || "").toLowerCase();
  if (normalized.includes("insufficient funds")) {
    return { code: "guard_transfer_operator_insufficient", retryable: false };
  }
  if (normalized.includes("execution reverted") && normalized.includes("require(false)") && normalized.includes("estimategas")) {
    return { code: "guard_transfer_estimate_or_rpc_failure", retryable: true };
  }
  if (
    normalized.includes("nonce too low") ||
    normalized.includes("replacement fee too low") ||
    normalized.includes("already known")
  ) {
    return { code: "guard_transfer_nonce_conflict", retryable: true };
  }
  if (isNetworkLikeError(reason)) {
    return { code: "guard_transfer_network_failure", retryable: true };
  }
  return { code: "guard_transfer_unknown_failure", retryable: false };
}

function toSafeTokenTransferAmount(amountWei) {
  if (amountWei > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("token transfer amount exceeds JS safe integer range");
  }
  return Number(amountWei);
}

async function transferGuardResilient({
  guardTokenContract,
  targetEvmAddress,
  targetAccountId,
  tokenId,
  operatorId,
  operatorKey,
  hederaClient,
  amountWei,
  label,
}) {
  if (amountWei <= 0n) return { path: "noop" };

  const initialBalance = await guardTokenContract.balanceOf(targetEvmAddress);
  const expectedMinBalance = initialBalance + amountWei;
  let lastFailure = null;

  for (let attempt = 1; attempt <= ACTIVATE_GUARD_TRANSFER_RETRY_MAX; attempt++) {
    try {
      const before = await guardTokenContract.balanceOf(targetEvmAddress);
      if (before >= expectedMinBalance) {
        console.log(`    • ${label}: funding already satisfied before transfer retry`);
        return { path: "already_funded" };
      }

      await guardTokenContract.transfer.staticCall(targetEvmAddress, amountWei);
      const tx = await guardTokenContract.transfer(targetEvmAddress, amountWei, {
        gasLimit: ACTIVATE_GUARD_TRANSFER_GAS_LIMIT,
      });
      const receipt = await tx.wait();
      if (!receipt || (receipt.status != null && receipt.status !== 1)) {
        throw new Error(`tx failed (hash=${tx.hash}, status=${receipt?.status ?? "unknown"})`);
      }

      const after = await guardTokenContract.balanceOf(targetEvmAddress);
      if (after < before + amountWei) {
        throw new Error(
          `post-transfer balance verification failed (before=${before.toString()} after=${after.toString()} expectedDelta=${amountWei.toString()})`
        );
      }
      console.log(`    ✓ ${label}: funded +${fromTokenUnits(amountWei).toFixed(4)} GUARD (evm transfer)`);
      return { path: "evm" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const classification = classifyGuardTransferError(reason);
      lastFailure = { reason, code: classification.code };
      if (classification.retryable && attempt < ACTIVATE_GUARD_TRANSFER_RETRY_MAX) {
        const waitMs = ACTIVATE_GUARD_TRANSFER_RETRY_BASE_MS * attempt;
        console.log(
          `    ⚠ ${label}: ${classification.code} during GUARD funding ` +
          `(attempt ${attempt}/${ACTIVATE_GUARD_TRANSFER_RETRY_MAX}): ${reason}`
        );
        console.log(`    • ${label}: retrying GUARD funding in ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      break;
    }
  }

  if (!ACTIVATE_GUARD_FALLBACK_HAPI_TRANSFER) {
    const detail = lastFailure ? `${lastFailure.code}:${lastFailure.reason}` : "unknown";
    throw new Error(`guard_transfer_failed_no_fallback:${detail}`);
  }

  try {
    const before = await guardTokenContract.balanceOf(targetEvmAddress);
    if (before >= expectedMinBalance) {
      console.log(`    • ${label}: funding already satisfied before HAPI fallback`);
      return { path: "already_funded" };
    }

    const transferAmount = toSafeTokenTransferAmount(amountWei);
    const tx = await new TransferTransaction()
      .addTokenTransfer(tokenId, operatorId, -transferAmount)
      .addTokenTransfer(targetAccountId, transferAmount)
      .freezeWith(hederaClient);
    const signed = await tx.sign(operatorKey);
    const submit = await signed.execute(hederaClient);
    const receipt = await submit.getReceipt(hederaClient);
    const statusText = String(receipt.status);
    if (statusText !== "SUCCESS") {
      throw new Error(`HAPI transfer failed with status ${statusText}`);
    }

    const after = await guardTokenContract.balanceOf(targetEvmAddress);
    if (after < before + amountWei) {
      throw new Error(
        `HAPI post-transfer balance verification failed (before=${before.toString()} after=${after.toString()} expectedDelta=${amountWei.toString()})`
      );
    }
    console.log(`    ✓ ${label}: funded +${fromTokenUnits(amountWei).toFixed(4)} GUARD (hapi fallback)`);
    return { path: "hapi_fallback" };
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err);
    const prior = lastFailure ? `${lastFailure.code}:${lastFailure.reason}` : "unknown";
    throw new Error(`guard_transfer_hapi_fallback_failed:${fallbackReason}; prior=${prior}`);
  }
}

async function maybeSyncDataMarketplaceRegistry(sdk, ownerSignerWallet, expectedRegistryAddress) {
  const marketplaceAddress = sdk?.contracts?.dataMarketplace?.evmAddress;
  if (!marketplaceAddress || !ethers.isAddress(marketplaceAddress)) return;
  const marketplace = new ethers.Contract(
    marketplaceAddress,
    DATA_MARKETPLACE_ADMIN_ABI,
    ownerSignerWallet
  );
  const currentRegistry = String(await marketplace.agentRegistry()).toLowerCase();
  const desiredRegistry = String(expectedRegistryAddress).toLowerCase();
  if (currentRegistry === desiredRegistry) {
    console.log(`• DataMarketplace registry already aligned: ${currentRegistry}`);
    return;
  }

  const ownerAddress = String(await marketplace.owner()).toLowerCase();
  if (ownerAddress !== ownerSignerWallet.address.toLowerCase()) {
    console.log(
      `⚠ DataMarketplace registry mismatch (${currentRegistry} != ${desiredRegistry}) but owner is ${ownerAddress}; ` +
      `cannot auto-sync with signer ${ownerSignerWallet.address}`
    );
    return;
  }

  const tx = await marketplace.setAgentRegistry(expectedRegistryAddress);
  await tx.wait();
  const postRegistry = String(await marketplace.agentRegistry()).toLowerCase();
  if (postRegistry === desiredRegistry) {
    console.log(`✓ DataMarketplace registry synced to ${postRegistry}`);
    return;
  }
  throw new Error(`DataMarketplace registry sync did not persist (post=${postRegistry}, expected=${desiredRegistry})`);
}

async function getHbarBalance(client, accountId, label) {
  const balance = await withTimeout(
    new AccountBalanceQuery().setAccountId(accountId).execute(client),
    RPC_TIMEOUT_MS,
    `${label} HBAR balance`
  );
  return Number(balance?.hbars?.toTinybars?.().toString?.() ?? "0") / 1e8;
}

async function ensureAgentHbarMinimum(client, operatorId, operatorKey, agentAccountId, label) {
  const current = await getHbarBalance(client, agentAccountId, `${label} payer`);
  if (current >= MIN_AGENT_PAYER_HBAR) {
    console.log(`    • ${label}: HBAR payer balance ok (${current.toFixed(4)} HBAR)`);
    return current;
  }

  const deficit = TARGET_AGENT_PAYER_HBAR - current;
  if (deficit <= 0) return current;
  if (agentAccountId.toString() === operatorId.toString()) {
    console.log(
      `    ⚠ ${label}: HBAR payer balance low (${current.toFixed(4)} < ${MIN_AGENT_PAYER_HBAR.toFixed(4)}), ` +
      "but account equals operator so top-up is skipped"
    );
    return current;
  }

  const sendTinybars = Math.max(1, Math.ceil(deficit * 1e8));
  const tx = await new TransferTransaction()
    .addHbarTransfer(operatorId, Hbar.fromTinybars(-sendTinybars))
    .addHbarTransfer(agentAccountId, Hbar.fromTinybars(sendTinybars))
    .freezeWith(client);
  const signed = await tx.sign(operatorKey);
  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);
  console.log(
    `    ✓ ${label}: HBAR top-up +${(sendTinybars / 1e8).toFixed(4)} (status=${String(receipt.status)})`
  );
  return await getHbarBalance(client, agentAccountId, `${label} payer post-topup`);
}

async function maybeTopupOperatorHbar(operatorId, minimumHbar) {
  if (!ENABLE_OPERATOR_HBAR_AUTOTOPUP) return;
  const targetHbar = Math.max(OPERATOR_HBAR_TARGET, minimumHbar);
  const operatorIdText = operatorId.toString();

  for (const spec of AGENTS) {
    const creds = getAgentCredentials(spec);
    if (!creds) continue;
    if (String(creds.accountId) === operatorIdText) continue;

    const donorId = AccountId.fromString(creds.accountId);
    const donorKey = parsePrivateKey(creds.privateKey, getAgentKeyTypeHint(spec));
    const donorClient = createHederaClient(donorId, donorKey);
    try {
      const donorHbar = await getHbarBalance(donorClient, donorId, `${spec.agentId} donor`);
      const maxSend = donorHbar - OPERATOR_TOPUP_DONOR_MIN_HBAR;
      if (maxSend <= 0) continue;

      const operatorBefore = await getHbarBalance(donorClient, operatorId, "operator pre-topup");
      const needed = targetHbar - operatorBefore;
      if (needed <= 0) return;

      const sendHbar = Math.min(maxSend, needed);
      const sendTinybars = Math.max(1, Math.ceil(sendHbar * 1e8));
      const tx = await new TransferTransaction()
        .addHbarTransfer(donorId, Hbar.fromTinybars(-sendTinybars))
        .addHbarTransfer(operatorId, Hbar.fromTinybars(sendTinybars))
        .freezeWith(donorClient);
      const signed = await tx.sign(donorKey);
      const submit = await signed.execute(donorClient);
      const receipt = await submit.getReceipt(donorClient);
      console.log(
        `✓ Operator HBAR top-up: ${spec.agentId} sent ${(sendTinybars / 1e8).toFixed(4)} HBAR ` +
        `(status=${String(receipt.status)})`
      );

      const operatorAfter = await getHbarBalance(donorClient, operatorId, "operator post-topup");
      if (operatorAfter >= minimumHbar) return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`⚠ Operator top-up attempt via ${spec.agentId} failed: ${msg}`);
    } finally {
      donorClient.close();
    }
  }
}

async function main() {
  logEnvCredentialPolicy();
  const sdk = loadSdkConfig();
  const guardTokenId = sdk?.guardTokenId;
  const guardTokenEvm = sdk?.guardTokenEvmAddress;
  const agentRegistryAddress = sdk?.contracts?.agentRegistry?.evmAddress;
  const sdkRegistryId = sdk?.contracts?.agentRegistry?.id;

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
  warnOnSharedOperatorAndScannerPayer(operatorIdRaw);

  const scannerSpec = AGENTS.find((spec) => spec.agentId === "scanner-001");
  if (scannerSpec) {
    const scannerCreds = getAgentCredentials(scannerSpec);
    if (scannerCreds?.privateKey && scannerCreds.accountId) {
      try {
        const scannerAddress = deriveAddressFromPrivateKey(scannerCreds.privateKey);
        console.log(
          `• scanner-001 resolved credentials: account=${scannerCreds.accountId} evm=${scannerAddress} ` +
          `(account source=${sourceForKey("SCANNER_ACCOUNT_ID")}, key source=${sourceForKey("SCANNER_PRIVATE_KEY")})`
        );
      } catch (err) {
        console.log(
          `⚠ scanner-001 credential derivation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  const operatorId = AccountId.fromString(operatorIdRaw);
  const operatorKey = parsePrivateKey(operatorKeyRaw, process.env.HEDERA_PRIVATE_KEY_TYPE);
  const hederaClient = createHederaClient(operatorId, operatorKey);

  try {
    let operatorHbar = await getHbarBalance(hederaClient, operatorId, "operator preflight");
    if (operatorHbar < MIN_ACTIVATION_PAYER_HBAR) {
      await maybeTopupOperatorHbar(operatorId, MIN_ACTIVATION_PAYER_HBAR);
      operatorHbar = await getHbarBalance(hederaClient, operatorId, "operator after auto-topup");
      if (operatorHbar < MIN_ACTIVATION_PAYER_HBAR) {
        throw new Error(
          `operator payer HBAR too low (${operatorHbar.toFixed(4)} < ${MIN_ACTIVATION_PAYER_HBAR.toFixed(4)})`
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Hedera SDK preflight failed: ${reason}. ` +
      `If this is ENOTFOUND/name-resolution, fix DNS/network access to Hedera testnet nodes first.`
    );
  }

  const rpcUrl = await resolveReachableRpcUrl();
  console.log(`Using JSON-RPC endpoint: ${rpcUrl}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl, HEDERA_NETWORK, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
  logInvalidOwnerKeyWarnings();
  const operatorEvmWallet = new ethers.Wallet(normalizeEvmPrivateKey(operatorKeyRaw), provider);
  const registryRead = new ethers.Contract(agentRegistryAddress, loadAgentRegistryAbi(), provider);
  const registryCodeAtConfigured = await withTimeout(
    provider.getCode(agentRegistryAddress),
    RPC_TIMEOUT_MS,
    `getCode(${agentRegistryAddress})`
  );
  if (!registryCodeAtConfigured || registryCodeAtConfigured === "0x") {
    throw new Error(`No contract bytecode at configured AgentRegistry address ${agentRegistryAddress}`);
  }
  const onChainGuardToken = String(
    await withTimeout(registryRead.guardToken(), RPC_TIMEOUT_MS, "AgentRegistry.guardToken")
  );
  if (onChainGuardToken.toLowerCase() !== guardTokenEvm.toLowerCase()) {
    throw new Error(
      `GUARD token mismatch: AgentRegistry.guardToken()=${onChainGuardToken} but packages/sdk/config.json has ${guardTokenEvm}. ` +
      "Update SDK config (or redeploy contracts) so activation funds/associations target the same token."
    );
  }
  const ownerAddress = String(await withTimeout(registryRead.owner(), RPC_TIMEOUT_MS, "AgentRegistry.owner"));
  const ownerSigner = resolveRegistryOwnerSigner(ownerAddress, provider);
  if (!ownerSigner) {
    throw new Error(
      `AgentRegistry owner is ${ownerAddress}, but no matching private key was found in env ` +
      `(AGENT_REGISTRY_OWNER_PRIVATE_KEY, ORCHESTRATOR_PRIVATE_KEY, OPERATOR_PRIVATE_KEY, HEDERA_PRIVATE_KEY).`
    );
  }
  const registry = new ethers.Contract(agentRegistryAddress, loadAgentRegistryAbi(), ownerSigner.wallet);
  let associateCalldata = "";
  try {
    associateCalldata = registry.interface.encodeFunctionData("associateGuardToken", []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`AgentRegistry ABI is missing associateGuardToken(): ${msg}`);
  }
  console.log(`associateGuardToken calldata template: ${associateCalldata}`);
  const guardToken = new ethers.Contract(guardTokenEvm, GUARD_ABI, operatorEvmWallet);
  const tokenId = TokenId.fromString(guardTokenId);
  const registryIdCandidates = resolveRegistryIdCandidates(sdkRegistryId, agentRegistryAddress);
  const mirrorRegistryId = await resolveRegistryIdViaMirror(agentRegistryAddress);
  if (mirrorRegistryId) {
    registryIdCandidates.unshift(mirrorRegistryId);
  }
  const uniqueRegistryIdCandidates = Array.from(new Set(registryIdCandidates));
  const registryAddressCandidatesForHts = [agentRegistryAddress];
  const mirrorLongZeroAddress = toSolidityAddressFromContractId(mirrorRegistryId);
  if (mirrorLongZeroAddress && mirrorLongZeroAddress.toLowerCase() !== agentRegistryAddress.toLowerCase()) {
    registryAddressCandidatesForHts.push(mirrorLongZeroAddress);
    try {
      const codeAtLongZero = await withTimeout(
        provider.getCode(mirrorLongZeroAddress),
        RPC_TIMEOUT_MS,
        `getCode(${mirrorLongZeroAddress})`
      );
      console.log(
        `• Bytecode check long-zero registry alias ${mirrorLongZeroAddress}: ` +
        `${codeAtLongZero && codeAtLongZero !== "0x" ? "present" : "empty"}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`⚠ Long-zero bytecode check failed (${mirrorLongZeroAddress}): ${msg}`);
    }
  }
  const requiredAgentIds = AGENTS.filter((spec) => spec.required).map((spec) => spec.agentId);
  const htsTransferFailedAgents = new Set();

  let hasFailure = false;
  const requiredFailures = [];
  console.log("Activating live agents against current deployment...\n");
  console.log(`AgentRegistry owner: ${ownerAddress}`);
  console.log(`Owner signer chosen: ${ownerSigner.wallet.address} (${ownerSigner.label})`);
  if (ownerSigner.accountId) {
    console.log(`Owner Hedera account candidate: ${ownerSigner.accountId}`);
  }
  if (uniqueRegistryIdCandidates.length > 0) {
    console.log(`Registry ID candidates for HAPI checks: ${uniqueRegistryIdCandidates.join(", ")}`);
  }
  if (registryAddressCandidatesForHts.length > 0) {
    console.log(`Registry address candidates for HTS association: ${registryAddressCandidatesForHts.join(", ")}`);
  }
  const numericRegistryIdForFunding = pickNumericRegistryId(uniqueRegistryIdCandidates);
  if (numericRegistryIdForFunding) {
    try {
      await ensureRegistryHbar(
        hederaClient,
        operatorId,
        operatorKey,
        numericRegistryIdForFunding,
        MIN_REGISTRY_HBAR
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`⚠ Registry HBAR pre-funding check failed: ${msg}`);
    }
  }

  // AgentRegistry.registerAgent() uses HTS.transferToken(..., to=AgentRegistry).
  // Ensure registry contract is token-associated first, otherwise all registrations revert.
  let associationState = "unknown";
  try {
    const tx = await registry.associateGuardToken();
    console.log(`• AgentRegistry.associateGuardToken tx.to=${tx.to} tx.data=${tx.data || "<empty>"}`);
    await tx.wait();
    console.log(`✓ AgentRegistry: GUARD token associated (owner signer: ${ownerSigner.label})`);
    associationState = "associated_now";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const normalized = msg.toLowerCase();
    if (
      normalized.includes("already associated") ||
      normalized.includes("token_already_associated_to_account")
    ) {
      console.log("• AgentRegistry: GUARD token already associated");
      associationState = "already_associated";
    } else if (
      normalized.includes("estimate") ||
      normalized.includes("require(false)") ||
      normalized.includes("no data present") ||
      normalized.includes("missing revert data")
    ) {
      console.log(
        `⚠ AgentRegistry.associateGuardToken estimate reverted generically; ` +
        `retrying with manual gas send as owner signer (${ownerSigner.label})`
      );
      try {
        const result = await forceAssociateGuardToken(
          registry,
          agentRegistryAddress,
          BigInt(process.env.AGENT_REGISTRY_ASSOCIATE_GAS_LIMIT || "1500000")
        );
        console.log(`✓ AgentRegistry: manual-gas association tx confirmed (${result.txHash})`);
        associationState = "associated_now_manual";
      } catch (forceErr) {
        const forceMsg = forceErr instanceof Error ? forceErr.message : String(forceErr);
        console.log(
          `⚠ AgentRegistry.associateGuardToken manual-gas retry failed with owner signer ` +
          `(${ownerSigner.label}): ${forceMsg}`
        );
        console.log("⚠ Retrying registry association via direct HTS tokenAssociate precompile call...");
        try {
          const result = await forceAssociateViaHtsCandidates(
            ownerSigner.wallet,
            registryAddressCandidatesForHts,
            guardTokenEvm,
            BigInt(process.env.AGENT_REGISTRY_ASSOCIATE_GAS_LIMIT || "1500000")
          );
          console.log(
            `✓ AgentRegistry: direct HTS tokenAssociate confirmed (${result.txHash}, preview=${result.previewCode}, target=${result.associatedAccount})`
          );
          associationState = "associated_now_hts_direct";
        } catch (htsErr) {
          const htsMsg = htsErr instanceof Error ? htsErr.message : String(htsErr);
          console.log(
            `⚠ AgentRegistry direct HTS tokenAssociate failed with owner signer ` +
            `(${ownerSigner.label}): ${htsMsg}`
          );
          associationState = "uncertain_generic_revert";
        }
      }
    } else {
      // Hedera precompile calls can return generic CALL_EXCEPTION/require(false)
      // even when the token is already associated on some deployments.
      // Continue and verify via per-agent register/isActive checks below.
      console.log(
        `⚠ AgentRegistry.associateGuardToken returned a generic revert with owner signer ` +
        `(${ownerSigner.label}): ${msg}`
      );
      console.log("⚠ Retrying registry association via direct HTS tokenAssociate precompile call...");
      try {
        const result = await forceAssociateViaHtsCandidates(
          ownerSigner.wallet,
          registryAddressCandidatesForHts,
          guardTokenEvm,
          BigInt(process.env.AGENT_REGISTRY_ASSOCIATE_GAS_LIMIT || "1500000")
        );
        console.log(
          `✓ AgentRegistry: direct HTS tokenAssociate confirmed (${result.txHash}, preview=${result.previewCode}, target=${result.associatedAccount})`
        );
        associationState = "associated_now_hts_direct";
      } catch (htsErr) {
        const htsMsg = htsErr instanceof Error ? htsErr.message : String(htsErr);
        console.log(
          `⚠ AgentRegistry direct HTS tokenAssociate failed with owner signer ` +
          `(${ownerSigner.label}): ${htsMsg}`
        );
        associationState = "uncertain_generic_revert";
      }
    }
  }

  let confirmedRegistryAssociation = false;
  let registryAssociationCheckHadReadableData = false;
  if (uniqueRegistryIdCandidates.length > 0) {
    const checks = [];
    for (const candidateId of uniqueRegistryIdCandidates) {
      const res = await inspectAccountTokenRelation(hederaClient, candidateId, tokenId);
      checks.push(res);
      if (res.error) {
        console.log(`⚠ Registry relation check failed for ${res.accountId}: ${res.error}`);
      } else {
        registryAssociationCheckHadReadableData = true;
        console.log(
          `• Registry relation ${res.accountId}: associated=${res.associated} balance=${res.tokenBalance ?? "0"}`
        );
      }
      if (res.associated === true) confirmedRegistryAssociation = true;
    }
    if (!confirmedRegistryAssociation && registryAssociationCheckHadReadableData) {
      const numericRegistryId = pickNumericRegistryId(uniqueRegistryIdCandidates);
      const hapiGasLimit = BigInt(process.env.AGENT_REGISTRY_ASSOCIATE_GAS_LIMIT || "1500000");
      let hapiAttempted = false;

      if (numericRegistryId && ownerSigner.accountId && ownerSigner.privateKeyRaw) {
        hapiAttempted = true;
        console.log(
          `⚠ Registry association not visible yet; retrying via Hedera SDK ContractExecuteTransaction ` +
          `(contract=${numericRegistryId}, ownerAccount=${ownerSigner.accountId})...`
        );
        try {
          const status = await executeAssociateViaHapi(
            ownerSigner.accountId,
            ownerSigner.privateKeyRaw,
            numericRegistryId,
            hapiGasLimit
          );
          console.log(`• HAPI associateGuardToken() receipt status: ${status}`);

          const postCheck = await inspectAccountTokenRelation(hederaClient, numericRegistryId, tokenId);
          if (!postCheck.error) {
            console.log(
              `• Registry relation ${postCheck.accountId} after HAPI retry: associated=${postCheck.associated} ` +
              `balance=${postCheck.tokenBalance ?? "0"}`
            );
          } else {
            console.log(`⚠ Post-HAPI relation check failed for ${numericRegistryId}: ${postCheck.error}`);
          }
          if (postCheck.associated === true) {
            confirmedRegistryAssociation = true;
            associationState = "associated_now_hapi";
          } else {
            associationState = "association_not_verified_after_hapi";
          }
        } catch (hapiErr) {
          const hapiMsg = hapiErr instanceof Error ? hapiErr.message : String(hapiErr);
          console.log(`⚠ HAPI associateGuardToken retry failed: ${hapiMsg}`);
          associationState = "association_not_verified_after_hapi";
        }
      }

      if (!confirmedRegistryAssociation) {
        const numericRegistryId = pickNumericRegistryId(uniqueRegistryIdCandidates);
        if (numericRegistryId) {
          try {
            const probeStatus = await probeRegistryGuardTransfer(
              hederaClient,
              tokenId,
              operatorId,
              operatorKey,
              numericRegistryId,
              1
            );
            console.log(`• Registry GUARD transfer probe status: ${probeStatus}`);
            if (probeStatus === "SUCCESS" || probeStatus === "OK") {
              confirmedRegistryAssociation = true;
              associationState = "associated_confirmed_by_probe";
            }
          } catch (probeErr) {
            const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
            console.log(`⚠ Registry GUARD transfer probe failed: ${probeMsg}`);
          }
        }
      }

      if (!confirmedRegistryAssociation) {
        const checkedIds = checks.filter((c) => !c.error).map((c) => c.accountId).join(", ");
        const hapiHint = hapiAttempted
          ? "HAPI retry was attempted and association is still not visible."
          : "HAPI retry was skipped (missing numeric contract ID or owner account mapping).";
        throw new Error(
          "activate-live-agents failed: AgentRegistry GUARD association is still not visible in HAPI token relationships " +
          `(checked: ${checkedIds}). ${hapiHint} ` +
          "This is why registerAgent transfers are failing."
        );
      }
    }
  }

  try {
    await maybeSyncDataMarketplaceRegistry(sdk, ownerSigner.wallet, agentRegistryAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`⚠ DataMarketplace registry sync failed: ${msg}`);
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

    let completed = false;
    for (let attempt = 1; attempt <= AGENT_ACTIVATION_RETRY_MAX; attempt++) {
      let agentClient = null;
      try {
        const agentAccountId = AccountId.fromString(creds.accountId);
        const agentHederaKey = parsePrivateKey(
          creds.privateKey,
          process.env[`${spec.prefix}_PRIVATE_KEY_TYPE`] || process.env.AGENT_PRIVATE_KEY_TYPE
        );
        agentClient = createHederaClient(agentAccountId, agentHederaKey);
        const agentEvmWallet = new ethers.Wallet(normalizeEvmPrivateKey(creds.privateKey), provider);
        const registryFromAgent = registry.connect(agentEvmWallet);
        const guardFromAgent = guardToken.connect(agentEvmWallet);
        const stakeWei = toTokenUnits(spec.stakeGuard);
        const minLiquidWei = toTokenUnits(spec.minLiquidGuard);
        const minTotalWei = stakeWei + minLiquidWei;
        const endpoint = process.env[spec.endpointEnv] || spec.defaultEndpoint;

        console.log(`• ${spec.agentId} (${agentEvmWallet.address})`);
        const identityCheck = await checkAgentIdentityPair(spec, creds);
        if (!identityCheck.ok) {
          throw new Error(`${identityCheck.reasonCode}:${identityCheck.detail}`);
        }

        const finalHbar = await ensureAgentHbarMinimum(
          hederaClient,
          operatorId,
          operatorKey,
          agentAccountId,
          spec.agentId
        );
        if (finalHbar < MIN_AGENT_PAYER_HBAR && spec.required) {
          hasFailure = true;
          requiredFailures.push(
            `${spec.agentId}:insufficient_payer_hbar_after_topup:${finalHbar.toFixed(4)}<${MIN_AGENT_PAYER_HBAR.toFixed(4)}`
          );
        }

        await associateTokenForAgent(agentClient, tokenId, agentAccountId, agentHederaKey, spec.agentId);

        let balanceWei = await guardToken.balanceOf(agentEvmWallet.address);
        if (balanceWei < minTotalWei) {
          const topup = minTotalWei - balanceWei;
          if (agentAccountId.toString() === operatorId.toString()) {
            console.log(
              `    ⚠ ${spec.agentId}: balance below desired target (${fromTokenUnits(balanceWei).toFixed(4)} < ` +
              `${fromTokenUnits(minTotalWei).toFixed(4)} GUARD), but account equals operator so top-up is skipped`
            );
          } else {
            const operatorGuardBalanceWei = await guardToken.balanceOf(operatorEvmWallet.address);
            if (operatorGuardBalanceWei < topup) {
              throw new Error(
                `operator_guard_insufficient: need=${fromTokenUnits(topup).toFixed(4)} ` +
                `have=${fromTokenUnits(operatorGuardBalanceWei).toFixed(4)}`
              );
            }
            await transferGuardResilient({
              guardTokenContract: guardToken,
              targetEvmAddress: agentEvmWallet.address,
              targetAccountId: agentAccountId,
              tokenId,
              operatorId,
              operatorKey,
              hederaClient,
              amountWei: topup,
              label: spec.agentId,
            });
            balanceWei = await guardToken.balanceOf(agentEvmWallet.address);
          }
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

        let registerErrorMessage = "";
        let active = await registry.isActiveAgent(agentEvmWallet.address);
        if (!active) {
          try {
            const registerCalldata = buildRegisterAgentCalldata(
              registryFromAgent,
              spec.agentId,
              endpoint,
              spec.specializations,
              stakeWei
            );
            const tx = await submitRegisterAgentTx(agentEvmWallet, agentRegistryAddress, registerCalldata);
            console.log(`    • ${spec.agentId}: registerAgent tx.to=${tx.to} tx.data=${tx.data || "<empty>"}`);
            console.log(`    ✓ ${spec.agentId}: on-chain registration succeeded`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            registerErrorMessage = msg;
            if (msg.toLowerCase().includes("agentregistry: hts transfer failed")) {
              htsTransferFailedAgents.add(spec.agentId);
            }
            console.log(`    ⚠ ${spec.agentId}: registerAgent attempt returned: ${msg}`);
          }
          active = await registry.isActiveAgent(agentEvmWallet.address);
        } else {
          console.log(`    • ${spec.agentId}: already active`);
        }

        const finalBalanceWei = await guardToken.balanceOf(agentEvmWallet.address);
        const ok = active && finalBalanceWei > 0n;
        if (!ok && spec.required) {
          hasFailure = true;
          const reason = !active
            ? (
              registerErrorMessage
                ? `inactive_agent_after_registration:register_error:${registerErrorMessage}`
                : "inactive_agent_after_registration"
            )
            : "zero_guard_balance_after_topup";
          requiredFailures.push(`${spec.agentId}:${reason}`);
        }
        console.log(
          `${ok ? "OK " : "ERR"}  ${spec.agentId.padEnd(28)} active=${active} guard=${fromTokenUnits(finalBalanceWei).toFixed(4)}`
        );
        completed = true;
        break;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const transient = isNetworkLikeError(reason);
        if (transient && attempt < AGENT_ACTIVATION_RETRY_MAX) {
          const waitMs = AGENT_ACTIVATION_RETRY_BASE_MS * attempt;
          console.log(
            `    ⚠ ${spec.agentId}: transient RPC error during activation ` +
            `(attempt ${attempt}/${AGENT_ACTIVATION_RETRY_MAX}): ${reason}`
          );
          console.log(`    • ${spec.agentId}: retrying activation in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }

        if (spec.required) hasFailure = true;
        if (spec.required) {
          const lowerReason = reason.toLowerCase();
          const category = transient
            ? "network_or_dns_failure"
            : lowerReason.includes("account_key_pair_mismatch")
              ? "account_key_pair_mismatch"
              : lowerReason.includes("operator_guard_insufficient")
                ? "operator_guard_insufficient"
                : "activation_error";
          requiredFailures.push(`${spec.agentId}:${category}:${reason}`);
        }
        console.log(`ERR  ${spec.agentId.padEnd(28)} ${reason}`);
        break;
      } finally {
        agentClient?.close();
      }
    }
    if (!completed && !spec.required) {
      console.log(`SKIP ${spec.agentId}: activation not completed (optional agent)`);
    }
  }

  hederaClient.close();

  if (
    associationState !== "associated_now" &&
    htsTransferFailedAgents.size > 0 &&
    requiredAgentIds.every((agentId) => htsTransferFailedAgents.has(agentId))
  ) {
    throw new Error(
      "activate-live-agents failed: AgentRegistry token association is likely missing. " +
      "All required agents failed registration with 'AgentRegistry: HTS transfer failed' " +
      `after associateGuardToken() state '${associationState}'. Verify guard token association on ` +
      `${agentRegistryAddress} and confirm AGENT_REGISTRY_OWNER_PRIVATE_KEY controls owner ${ownerAddress}.`
    );
  }

  if (hasFailure) {
    const detail = requiredFailures.length
      ? ` Details: ${requiredFailures.join(" | ")}`
      : "";
    throw new Error(
      "activate-live-agents failed: one or more required agents are still inactive or unfunded." +
      detail
    );
  }

  console.log("\nactivate-live-agents completed");
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
