const path = require("path");
const { config: dotenvConfig } = require("dotenv");
const { ethers } = require("ethers");
const { createRequire } = require("module");

const ROOT_ENV = path.join(__dirname, "..", ".env");
const AGENTS_ENV = path.join(__dirname, "..", "agents", ".env");
dotenvConfig({ path: ROOT_ENV });
dotenvConfig({ path: AGENTS_ENV, override: true });

const DEFAULT_TIMEOUT_MS = Number(process.env.ZG_HEALTHCHECK_TIMEOUT_MS || "15000");
const REQUEST_TIMEOUT_MS = Number(process.env.ZG_REQUEST_TIMEOUT_MS || process.env.ZG_TIMEOUT_MS || "30000");
const DEPOSIT_AMOUNT = Number(process.env.ZG_DEPOSIT_AMOUNT || "5");
const MIN_LEDGER_CREDITS = Number(process.env.ZG_MIN_LEDGER_CREDITS || "1");
const PROVIDER_MODE = String(process.env.ZG_PROVIDER_MODE || "pinned").trim().toLowerCase();
const CANONICAL_MODEL_ALIASES = {
  "qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
  "qwen/qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
};

function fail(reasonCode, message, hint = "") {
  const hintLine = hint ? `\nHint: ${hint}` : "";
  throw new Error(`${reasonCode}: ${message}${hintLine}`);
}

function normalizeKey(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function buildCompletionUrl(endpoint) {
  const base = String(endpoint || "").replace(/\/$/, "");
  if (!base) return "";
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function extractRequestId(response, payload) {
  return (
    response.headers.get("ZG-Res-Key") ||
    response.headers.get("zg-res-key") ||
    response.headers.get("x-request-id") ||
    payload?.id ||
    undefined
  );
}

function canonicalizeModelId(model) {
  const trimmed = String(model || "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  return CANONICAL_MODEL_ALIASES[normalized] || trimmed;
}

function modelsEquivalent(a, b) {
  const aa = canonicalizeModelId(a);
  const bb = canonicalizeModelId(b);
  if (!aa || !bb) return false;
  return aa.toLowerCase() === bb.toLowerCase();
}

function resolveInferenceModel(requestedModel, providerModel) {
  const requested = canonicalizeModelId(requestedModel);
  const provider = canonicalizeModelId(providerModel);
  const mode = PROVIDER_MODE === "auto" || PROVIDER_MODE === "hybrid" ? PROVIDER_MODE : "pinned";

  if (!provider) {
    fail("zg_provider_metadata_failed", "Provider metadata missing model", "Verify provider registration and model config");
  }

  if (mode === "auto") {
    return { model: provider, corrected: Boolean(requested) && !modelsEquivalent(requested, provider), mode };
  }

  if (!requested) {
    return { model: provider, corrected: false, mode };
  }

  if (modelsEquivalent(requested, provider)) {
    return { model: provider, corrected: requested.toLowerCase() !== provider.toLowerCase(), mode };
  }

  if (mode === "hybrid") {
    return { model: provider, corrected: true, mode };
  }

  fail(
    "zg_model_mismatch",
    `Configured model '${requestedModel}' does not match provider model '${provider}' in pinned mode`,
    "Set ZG_MODEL to the provider model or switch ZG_PROVIDER_MODE=hybrid/auto"
  );
}

function extractSupportedModelFromHttpError(body) {
  const raw = String(body || "");
  const singleQuoted = raw.match(/only\s+'([^']+)'\s+is available/i);
  if (singleQuoted?.[1]) return canonicalizeModelId(singleQuoted[1]);
  const doubleQuoted = raw.match(/only\s+\"([^\"]+)\"\s+is available/i);
  if (doubleQuoted?.[1]) return canonicalizeModelId(doubleQuoted[1]);
  return "";
}

async function withTimeout(promise, ms, label, reasonCode) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${reasonCode}: ${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  if (typeof response.text === "function") {
    return response.text();
  }
  if (typeof response.json === "function") {
    const payload = await response.json();
    return JSON.stringify(payload || {});
  }
  return "";
}

async function main() {
  const privateKey = normalizeKey(process.env.ZG_PRIVATE_KEY);
  const rpcUrl = (process.env.ZG_RPC_URL || "").trim();
  const providerAddress = (process.env.ZG_PROVIDER_ADDRESS || "").trim();
  const requestedModel = (process.env.ZG_MODEL || "").trim();

  if (!privateKey) {
    fail("zg_not_configured", "Missing ZG_PRIVATE_KEY", "Set ZG_PRIVATE_KEY in .env");
  }
  if (!rpcUrl) {
    fail("zg_not_configured", "Missing ZG_RPC_URL", "Set ZG_RPC_URL in .env");
  }
  if (!providerAddress) {
    fail("zg_not_configured", "Missing ZG_PROVIDER_ADDRESS", "Set ZG_PROVIDER_ADDRESS in .env");
  }
  if (!requestedModel && PROVIDER_MODE === "pinned") {
    fail("zg_not_configured", "Missing ZG_MODEL in pinned mode", "Set ZG_MODEL or use ZG_PROVIDER_MODE=auto/hybrid");
  }

  console.log("verify-zg-compute: starting preflight");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  let broker;
  try {
    const rootRequire = createRequire(__filename);
    const agentsRequire = createRequire(path.join(__dirname, "..", "agents", "package.json"));
    let createZGComputeNetworkBroker;
    try {
      ({ createZGComputeNetworkBroker } = rootRequire("@0glabs/0g-serving-broker"));
    } catch {
      ({ createZGComputeNetworkBroker } = agentsRequire("@0glabs/0g-serving-broker"));
    }
    broker = await withTimeout(
      createZGComputeNetworkBroker(wallet),
      DEFAULT_TIMEOUT_MS,
      "broker initialization",
      "zg_broker_init_failed"
    );
  } catch (err) {
    fail("zg_broker_init_failed", err.message, "Verify ZG_RPC_URL connectivity and wallet validity");
  }

  try {
    let ledger;
    try {
      ledger = await withTimeout(
        broker.ledger.getLedger(),
        DEFAULT_TIMEOUT_MS,
        "ledger read",
        "zg_ledger_unfunded"
      );
    } catch {
      ledger = null;
    }

    const availableBefore = BigInt(ledger?.availableBalance ?? 0n);
    if (availableBefore <= 0n) {
      await withTimeout(
        broker.ledger.depositFund(Math.max(DEPOSIT_AMOUNT, MIN_LEDGER_CREDITS)),
        DEFAULT_TIMEOUT_MS,
        "ledger deposit",
        "zg_ledger_unfunded"
      );
    }

    const ledgerAfter = await withTimeout(
      broker.ledger.getLedger(),
      DEFAULT_TIMEOUT_MS,
      "ledger read after deposit",
      "zg_ledger_unfunded"
    );

    const availableAfter = BigInt(ledgerAfter?.availableBalance ?? 0n);
    if (availableAfter <= 0n) {
      fail("zg_ledger_unfunded", "Ledger available balance is still zero after deposit", "Fund your 0g account/wallet before live run");
    }

    await withTimeout(
      broker.inference.acknowledgeProviderSigner(providerAddress),
      DEFAULT_TIMEOUT_MS,
      "provider acknowledgement",
      "zg_provider_ack_failed"
    );

    const metadata = await withTimeout(
      broker.inference.getServiceMetadata(providerAddress),
      DEFAULT_TIMEOUT_MS,
      "provider metadata",
      "zg_provider_metadata_failed"
    );

    const endpoint = String(metadata?.endpoint || "").trim();
    const providerModel = String(metadata?.model || "").trim();
    const resolved = resolveInferenceModel(requestedModel, providerModel);
    let model = resolved.model;
    if (!endpoint || !model) {
      fail("zg_provider_metadata_failed", "Provider metadata missing endpoint/model", "Verify ZG_PROVIDER_ADDRESS points to an active provider");
    }
    if (resolved.corrected) {
      console.log(`verify-zg-compute: model auto-corrected (${requestedModel || "unset"} -> ${model}, mode=${resolved.mode})`);
    }

    const headers = await withTimeout(
      broker.inference.getRequestHeaders(providerAddress, "health-check"),
      DEFAULT_TIMEOUT_MS,
      "request headers",
      "zg_request_headers_failed"
    );

    const completionUrl = buildCompletionUrl(endpoint);
    if (!completionUrl) {
      fail("zg_provider_metadata_failed", "Unable to build completion endpoint URL", "Verify provider metadata endpoint");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    let raw = "";
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        response = await fetch(completionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "health-check" }],
            temperature: 0,
            max_tokens: 32,
          }),
          signal: controller.signal,
        });
        raw = await readResponseBody(response);
        if (response.ok) break;
        const hintedModel = response.status === 400 ? extractSupportedModelFromHttpError(raw) : "";
        if (attempt === 1 && hintedModel && !modelsEquivalent(model, hintedModel)) {
          model = hintedModel;
          console.log(`verify-zg-compute: retrying probe with provider-supported model '${model}'`);
          continue;
        }
        break;
      }
    } catch (err) {
      if (String(err?.name || "").toLowerCase().includes("abort")) {
        fail("zg_timeout", `Inference probe timed out after ${REQUEST_TIMEOUT_MS}ms`, "Increase ZG_REQUEST_TIMEOUT_MS or check provider/network health");
      }
      fail("zg_http_error", `Inference probe request failed: ${err.message}`, "Check RPC/network and provider endpoint reachability");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      fail("zg_http_error", `Provider returned ${response.status}: ${raw.slice(0, 220)}`, "Verify provider is healthy and request headers are valid");
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      fail("zg_response_invalid", "Provider returned non-JSON payload", "Check provider model endpoint compatibility");
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      fail("zg_response_invalid", "Provider returned empty completion content", "Provider may be unhealthy or rejecting prompt format");
    }

    const requestId = extractRequestId(response, payload);
    const usage = payload?.usage ? JSON.stringify(payload.usage) : undefined;

    const verification = await withTimeout(
      broker.inference.processResponse(providerAddress, requestId, usage),
      DEFAULT_TIMEOUT_MS,
      "response verification",
      "zg_response_invalid"
    );

    if (verification === false) {
      fail("zg_response_invalid", "Provider response signature verification failed", "Check provider signer acknowledgement and integrity");
    }

    console.log(`verify-zg-compute: ok (provider=${providerAddress}, model=${model})`);
  } catch (err) {
    throw err;
  }
}

main().catch((err) => {
  console.error(`\n❌ verify-zg-compute failed`);
  console.error(err.message || String(err));
  process.exit(1);
});
