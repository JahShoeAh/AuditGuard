const path = require("path");
const { createRequire } = require("module");
const { ethers } = require("ethers");
const { loadRuntimeEnv, summarizeCredentialConflict } = require("./env-policy.js");
const { verifyAccountKeyPair, normalizeAccountId } = require("./account-identity.js");

const runtimeEnv = loadRuntimeEnv({
  allowAgentCredentialOverrides:
    String(process.env.ALLOW_AGENT_ENV_CREDENTIAL_OVERRIDE || "").toLowerCase() === "true",
});

const CANONICAL_MODEL_ALIASES = {
  "qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
  "qwen/qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
};
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = Number(process.env.ZG_HEALTHCHECK_TIMEOUT_MS || "15000");

function fail(message, remediation = []) {
  console.error(`\n❌ preflight-runtime failed: ${message}`);
  if (remediation.length > 0) {
    console.error("\nSuggested fixes:");
    for (const item of remediation) {
      console.error(`  - ${item}`);
    }
  }
  process.exit(1);
}

function info(message) {
  console.log(`• ${message}`);
}

function warn(message) {
  console.warn(`⚠ ${message}`);
}

function resolveAgentsRequire() {
  const agentsPkg = path.join(__dirname, "..", "agents", "package.json");
  return createRequire(agentsPkg);
}

function checkScannerOptionalDependencies() {
  const classifierMode = boolFromEnv("SCANNER_CLASSIFIER_PIPELINE", false);
  const deps = [
    {
      pkg: "evmdecoder",
      purpose: "scanner classifier contract decoding",
    },
    {
      pkg: "@anthropic-ai/sdk",
      purpose: "scanner classifier risk inference fallback",
    },
  ];

  const agentsRequire = resolveAgentsRequire();
  const missing = [];

  for (const dep of deps) {
    try {
      const resolved = agentsRequire.resolve(dep.pkg);
      info(`scanner optional dependency resolved (${dep.pkg}): ${resolved}`);
    } catch {
      missing.push(dep);
    }
  }

  if (missing.length === 0) return;

  const details = missing.map((entry) => `${entry.pkg} (${entry.purpose})`);
  if (classifierMode) {
    fail(
      `scanner classifier pipeline enabled but optional dependency missing: ${details.join(", ")}`,
      [
        "Install missing dependencies in agents workspace",
        "npm --prefix agents install",
        "Or set SCANNER_CLASSIFIER_PIPELINE=false for baseline scanner mode",
      ]
    );
  }

  warn(
    `scanner classifier optional dependencies missing (baseline mode continues): ${details.join(", ")}`
  );
}

function checkBrokerDependency() {
  const agentsRequire = resolveAgentsRequire();
  let resolved = "";
  try {
    resolved = agentsRequire.resolve("@0glabs/0g-serving-broker");
    info(`0g broker dependency resolved: ${resolved}`);
  } catch {
    fail(
      "missing runtime dependency '@0glabs/0g-serving-broker' in agents workspace",
      [
        "npm --workspace agents install",
        "npm --workspace agents ls @0glabs/0g-serving-broker",
      ]
    );
  }
  return { agentsRequire, resolved };
}

async function checkBrokerRuntimeLoadability() {
  const { agentsRequire, resolved } = checkBrokerDependency();
  const pkgName = "@0glabs/0g-serving-broker";
  let esmOk = false;
  let esmError = null;

  try {
    const esmModule = await import(pkgName);
    if (typeof esmModule?.createZGComputeNetworkBroker === "function") {
      esmOk = true;
      info("0g broker ESM import probe passed");
    } else {
      esmError = "ESM import succeeded but createZGComputeNetworkBroker export is missing";
    }
  } catch (err) {
    esmError = err instanceof Error ? err.message : String(err);
  }

  let cjsOk = false;
  let cjsError = null;
  try {
    const cjsModule = agentsRequire(pkgName);
    if (typeof cjsModule?.createZGComputeNetworkBroker === "function") {
      cjsOk = true;
      info("0g broker CJS require probe passed");
    } else {
      cjsError = "CJS require succeeded but createZGComputeNetworkBroker export is missing";
    }
  } catch (err) {
    cjsError = err instanceof Error ? err.message : String(err);
  }

  if (esmOk || cjsOk) return;

  fail(
    "0g broker package is installed but runtime loading failed in both ESM and CJS modes",
    [
      `Resolved path: ${resolved}`,
      `ESM error: ${esmError || "unknown"}`,
      `CJS error: ${cjsError || "unknown"}`,
      "npm --workspace agents install",
      "npm --workspace agents ls @0glabs/0g-serving-broker",
      "Try setting ZG_BROKER_LOADER_MODE=auto",
    ]
  );
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return String(raw).toLowerCase() !== "false";
}

function canonicalizeModelId(model) {
  const trimmed = String(model || "").trim();
  if (!trimmed) return "";
  return CANONICAL_MODEL_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function modelsEquivalent(a, b) {
  const aa = canonicalizeModelId(a);
  const bb = canonicalizeModelId(b);
  if (!aa || !bb) return false;
  return aa.toLowerCase() === bb.toLowerCase();
}

function resolveProviderMode() {
  const raw = String(process.env.ZG_PROVIDER_MODE || "pinned").trim().toLowerCase();
  if (raw === "auto" || raw === "hybrid") return raw;
  return "pinned";
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

function checkCredentialEnvConsistency() {
  const allowDrift = boolFromEnv("ALLOW_ENV_CREDENTIAL_DRIFT", false);
  const conflicts = runtimeEnv.credentialConflicts;
  if (!conflicts.length) {
    info("Credential env consistency passed (.env authoritative)");
    return;
  }

  const rendered = conflicts.map((entry) => summarizeCredentialConflict(entry));
  if (allowDrift) {
    warn(
      "Credential drift detected between .env and agents/.env; continuing because ALLOW_ENV_CREDENTIAL_DRIFT=true:\n" +
      rendered.map((line) => `  - ${line}`).join("\n")
    );
    return;
  }

  fail(
    "credential drift detected between root .env and agents/.env",
    [
      `Root env: ${runtimeEnv.rootPath}`,
      `Agents env: ${runtimeEnv.agentsPath}`,
      ...rendered.map((line) => `Resolve mismatch: ${line}`),
      "Use root .env as credential source of truth, or set ALLOW_ENV_CREDENTIAL_DRIFT=true for temporary bypass",
    ]
  );
}

function checkScannerEcdsaCredential() {
  const scannerAccountId =
    normalizeAccountId(process.env.SCANNER_ACCOUNT_ID) ||
    normalizeAccountId(process.env.SCANNER_AGENT_ACCOUNT_ID);
  const scannerPrivateKeyRaw =
    String(process.env.SCANNER_PRIVATE_KEY || process.env.SCANNER_AGENT_PRIVATE_KEY || "")
      .trim()
      .replace(/^['"]|['"]$/g, "");

  if (!scannerAccountId || !scannerPrivateKeyRaw) {
    fail("missing scanner credentials (SCANNER_ACCOUNT_ID/SCANNER_PRIVATE_KEY)", [
      "Set SCANNER_ACCOUNT_ID and SCANNER_PRIVATE_KEY in root .env",
      "Do not rely on agents/.env for credential overrides",
    ]);
  }

  if (!/^0\.0\.\d+$/.test(scannerAccountId)) {
    fail(`invalid SCANNER_ACCOUNT_ID format: ${scannerAccountId}`, [
      "Expected Hedera account format like 0.0.12345",
    ]);
  }

  const stripped = scannerPrivateKeyRaw.startsWith("0x")
    ? scannerPrivateKeyRaw.slice(2)
    : scannerPrivateKeyRaw;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    fail("scanner private key is not valid 32-byte hex (ECDSA expected)", [
      "Create/import an ECDSA scanner key and set SCANNER_PRIVATE_KEY",
      "If key is ED25519, replace with ECDSA for EVM-compatible runtime paths",
    ]);
  }

  try {
    const wallet = new ethers.Wallet(`0x${stripped}`);
    info(`Scanner credential format check passed (account=${scannerAccountId}, evm=${wallet.address})`);
  } catch (err) {
    fail(
      `scanner private key failed ECDSA wallet derivation: ${err instanceof Error ? err.message : String(err)}`,
      ["Set a valid ECDSA private key for scanner in root .env"]
    );
  }
}

async function checkAccountKeyPairIntegrity() {
  const allowMismatch = boolFromEnv("ALLOW_ACCOUNT_KEY_MISMATCH", false);
  const mirrorBaseUrl = process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com";
  const timeoutMs = Number(process.env.LIVE_PREFLIGHT_MIRROR_TIMEOUT_MS || "8000");

  const pairs = [
    {
      label: "scanner",
      accountId:
        normalizeAccountId(process.env.SCANNER_ACCOUNT_ID) ||
        normalizeAccountId(process.env.SCANNER_AGENT_ACCOUNT_ID),
      privateKey: process.env.SCANNER_PRIVATE_KEY || process.env.SCANNER_AGENT_PRIVATE_KEY || "",
      required: true,
    },
    {
      label: "orchestrator",
      accountId:
        normalizeAccountId(process.env.ORCHESTRATOR_ACCOUNT_ID) ||
        normalizeAccountId(process.env.OPERATOR_ACCOUNT_ID) ||
        normalizeAccountId(process.env.HEDERA_ACCOUNT_ID),
      privateKey:
        process.env.ORCHESTRATOR_PRIVATE_KEY ||
        process.env.OPERATOR_PRIVATE_KEY ||
        process.env.HEDERA_PRIVATE_KEY ||
        "",
      required: false,
    },
  ];

  for (const pair of pairs) {
    if (!pair.accountId || !pair.privateKey) {
      if (pair.required) {
        fail(`missing credentials for ${pair.label} identity check`, [
          `Set ${pair.label.toUpperCase()}_ACCOUNT_ID and ${pair.label.toUpperCase()}_PRIVATE_KEY in root .env`,
        ]);
      }
      continue;
    }

    const result = await verifyAccountKeyPair({
      accountId: pair.accountId,
      privateKey: pair.privateKey,
      mirrorBaseUrl,
      timeoutMs,
    });

    if (result.ok) {
      info(
        `${pair.label} account/key pair check passed ` +
        `(account=${result.accountId}, evm=${result.derivedAddress})`
      );
      continue;
    }

    if (result.reasonCode === "account_key_pair_mismatch") {
      const message =
        `account_key_pair_mismatch: ${pair.label} account ${result.accountId} does not match configured private key ` +
        `(derived=${result.derivedAddress}, mirror=${result.mirrorAddress})`;
      if (allowMismatch) {
        warn(`${message} (continuing because ALLOW_ACCOUNT_KEY_MISMATCH=true)`);
      } else {
        fail(message, [
          `Update ${pair.label.toUpperCase()}_ACCOUNT_ID or ${pair.label.toUpperCase()}_PRIVATE_KEY to a matching pair`,
          "Or set ALLOW_ACCOUNT_KEY_MISMATCH=true for temporary bypass",
        ]);
      }
      continue;
    }

    warn(
      `${pair.label} account/key pair could not be fully verified ` +
      `(reasonCode=${result.reasonCode}, detail=${result.detail})`
    );
  }
}

function checkStrictPayerSeparation() {
  const allowSharedPayer = boolFromEnv("ALLOW_SHARED_PAYER", false);
  if (allowSharedPayer) {
    info("ALLOW_SHARED_PAYER=true; skipping payer-separation enforcement");
    return;
  }

  const orchestratorAccountId =
    normalizeAccountId(process.env.ORCHESTRATOR_ACCOUNT_ID) ||
    normalizeAccountId(process.env.OPERATOR_ACCOUNT_ID) ||
    normalizeAccountId(process.env.HEDERA_ACCOUNT_ID);
  const scannerAccountId =
    normalizeAccountId(process.env.SCANNER_ACCOUNT_ID) ||
    normalizeAccountId(process.env.SCANNER_AGENT_ACCOUNT_ID);

  if (!orchestratorAccountId || !scannerAccountId) {
    info("Payer-separation check skipped: missing ORCHESTRATOR/SCANNER account IDs");
    return;
  }

  if (orchestratorAccountId === scannerAccountId) {
    fail(
      `runtime requires unique payer accounts, but scanner and orchestrator are both ${orchestratorAccountId}`,
      [
        "Set SCANNER_ACCOUNT_ID/SCANNER_PRIVATE_KEY to a dedicated scanner payer account",
        "Keep ORCHESTRATOR_ACCOUNT_ID/ORCHESTRATOR_PRIVATE_KEY (or OPERATOR_*) separate",
        "Set ALLOW_SHARED_PAYER=true only for temporary local debugging (not recommended)",
      ]
    );
  }

  info("Payer-separation check passed");
}

function checkZgRequiredEnv() {
  const strictLive = boolFromEnv("STRICT_LIVE", true);
  const noFallbackMode = boolFromEnv("NO_FALLBACK_MODE", true);
  const demoMode = boolFromEnv("DEMO_MODE", false);
  const zgEnabled = boolFromEnv("ZG_ENABLED", true);
  const zgRequiredInLive = boolFromEnv("ZG_REQUIRED_IN_LIVE", true);
  const strictLiveZgRequired = noFallbackMode || (strictLive && !demoMode && zgRequiredInLive);

  if (!strictLiveZgRequired) {
    info("Strict 0g requirement disabled; skipping ZG_* env validation");
    return { strictLiveZgRequired, zgEnabled };
  }

  if (!zgEnabled) {
    fail(
      "strict runtime requires 0g inference, but ZG_ENABLED=false",
      ["Set ZG_ENABLED=true or relax NO_FALLBACK_MODE/STRICT_LIVE for non-strict runs"]
    );
  }

  const missing = [];
  if (!String(process.env.ZG_PRIVATE_KEY || "").trim()) missing.push("ZG_PRIVATE_KEY");
  if (!String(process.env.ZG_PROVIDER_ADDRESS || "").trim()) missing.push("ZG_PROVIDER_ADDRESS");
  if (missing.length > 0) {
    fail(
      `strict runtime requires configured 0g env vars: missing ${missing.join(", ")}`,
      ["Set required ZG_* vars in .env and re-run preflight"]
    );
  }
  info("Strict 0g env validation passed");
  return { strictLiveZgRequired, zgEnabled };
}

async function checkZgModelConsistency(strictLiveZgRequired) {
  const zgEnabled = boolFromEnv("ZG_ENABLED", true);
  if (!strictLiveZgRequired || !zgEnabled) {
    return;
  }

  const providerMode = resolveProviderMode();
  const requestedModelRaw = String(process.env.ZG_MODEL || "").trim();
  const requestedModel = canonicalizeModelId(requestedModelRaw);
  const providerAddress = String(process.env.ZG_PROVIDER_ADDRESS || "").trim();
  const privateKeyRaw = String(process.env.ZG_PRIVATE_KEY || "").trim();
  const rpcUrl = String(process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai").trim();
  const healthTimeout = Number(process.env.ZG_HEALTHCHECK_TIMEOUT_MS || DEFAULT_HEALTHCHECK_TIMEOUT_MS);

  if (providerMode === "pinned" && !requestedModelRaw) {
    fail("strict runtime uses ZG_PROVIDER_MODE=pinned but ZG_MODEL is empty", [
      "Set ZG_MODEL to provider's supported model (for this provider: qwen/qwen-2.5-7b-instruct)",
      "or set ZG_PROVIDER_MODE=hybrid/auto",
    ]);
  }

  if (!requestedModelRaw && (providerMode === "auto" || providerMode === "hybrid")) {
    info(`ZG_MODEL not set; continuing with provider metadata model (${providerMode} mode)`);
  }

  if (!providerAddress || !privateKeyRaw || !rpcUrl) {
    warn("Skipping 0g model consistency probe: missing one of ZG_PROVIDER_ADDRESS/ZG_PRIVATE_KEY/ZG_RPC_URL");
    return;
  }

  try {
    const { agentsRequire } = checkBrokerDependency();
    const createZGComputeNetworkBroker = agentsRequire("@0glabs/0g-serving-broker").createZGComputeNetworkBroker;
    if (typeof createZGComputeNetworkBroker !== "function") {
      warn("Skipping model consistency probe: createZGComputeNetworkBroker export missing");
      return;
    }

    const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const broker = await withTimeout(
      createZGComputeNetworkBroker(wallet),
      healthTimeout,
      "0g broker initialization"
    );
    const metadata = await withTimeout(
      broker.inference.getServiceMetadata(providerAddress),
      healthTimeout,
      "0g provider metadata"
    );
    const providerModel = canonicalizeModelId(metadata?.model || "");
    if (!providerModel) {
      warn("0g model consistency probe returned empty provider model; skipping strict comparison");
      return;
    }

    if (providerMode === "pinned" && requestedModel && !modelsEquivalent(requestedModel, providerModel)) {
      fail(
        `ZG model mismatch in pinned mode: requested='${requestedModelRaw}' provider='${providerModel}'`,
        [
          `Set ZG_MODEL=${providerModel}`,
          "or set ZG_PROVIDER_MODE=hybrid/auto to allow provider metadata model selection",
        ]
      );
    }

    if (requestedModel && !modelsEquivalent(requestedModel, providerModel)) {
      info(
        `0g model mismatch detected but accepted in ${providerMode} mode: requested='${requestedModelRaw}' provider='${providerModel}'`
      );
      return;
    }

    info(`0g model consistency check passed (mode=${providerMode}, model=${providerModel})`);
  } catch (err) {
    warn(`0g model consistency probe skipped due to runtime/network issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log("Running runtime preflight checks...\n");
  checkCredentialEnvConsistency();
  checkScannerEcdsaCredential();
  await checkAccountKeyPairIntegrity();
  checkScannerOptionalDependencies();
  await checkBrokerRuntimeLoadability();
  const { strictLiveZgRequired } = checkZgRequiredEnv();
  await checkZgModelConsistency(strictLiveZgRequired);
  checkStrictPayerSeparation();
  console.log("\npreflight-runtime passed");
}

main().catch((err) => {
  fail(`unexpected preflight error: ${err instanceof Error ? err.message : String(err)}`);
});
