#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const OUTPUT_PATH = path.join(__dirname, "..", "recon", "test-logs", "runtime_readiness.json");
const KNOWN_REASON_CODES = new Set([
  "network_timeout",
  "network_unhealthy",
  "account_key_pair_mismatch",
  "identity_mismatch",
  "inactive_onchain",
  "agent_inactive",
  "unfunded_guard",
  "insufficient_payer_hbar",
  "missing_credentials",
]);

function runNodeScript(scriptPath, extraEnv = {}) {
  const result = spawnSync("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output,
  };
}

function parseReasonSummary(output) {
  const reasons = {};
  const regex = /^•\s+([a-z_]+)\s+total=\s*(\d+)\s+required_failures=\s*(\d+)/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    reasons[match[1]] = {
      total: Number(match[2]),
      requiredFailures: Number(match[3]),
    };
  }
  return reasons;
}

function classify(reasons, output) {
  const keys = Object.keys(reasons);
  if (!keys.length) {
    if (/verify-live-agents passed/i.test(output)) return "ready";
    if (/network/i.test(output) && /timeout|unhealthy/i.test(output)) return "network_unhealthy";
    return "unknown";
  }
  if (reasons.network_timeout || reasons.network_unhealthy) return "network_unhealthy";
  if (reasons.account_key_pair_mismatch || reasons.identity_mismatch) return "identity_mismatch";
  if (reasons.agent_inactive || reasons.inactive_onchain) return "inactive_onchain";
  if (reasons.unfunded_guard) return "unfunded_guard";
  if (reasons.insufficient_payer_hbar) return "insufficient_payer_hbar";
  return keys[0];
}

function extractKnownFailureCode(output) {
  const patterns = [
    /❌ [^:]+: ([a-z_]+)/i,
    /\b(account_key_pair_mismatch|network_timeout|network_unhealthy|inactive_onchain|unfunded_guard)\b/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return String(match[1]).toLowerCase();
  }
  return null;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const verifyTimeoutMs = String(process.env.LIVE_PREFLIGHT_RPC_TIMEOUT_MS || "3000");

  const preflight = runNodeScript("scripts/preflight-runtime.js");
  const verify = runNodeScript("scripts/verify-live-agents.js", {
    LIVE_PREFLIGHT_RPC_TIMEOUT_MS: verifyTimeoutMs,
  });

  const reasonSummary = parseReasonSummary(verify.output);
  const classification = classify(reasonSummary, verify.output);
  const knownPreflightCode = extractKnownFailureCode(preflight.output);
  const knownVerifyCode = extractKnownFailureCode(verify.output);

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: { verifyTimeoutMs: Number(verifyTimeoutMs) },
    preflight: {
      ok: preflight.ok,
      status: preflight.status,
      knownFailureCode: knownPreflightCode,
    },
    verify: {
      ok: verify.ok,
      status: verify.status,
      reasonSummary,
      classification,
      knownFailureCode: knownVerifyCode,
    },
  };

  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log(`Runtime diagnostics written: ${OUTPUT_PATH}`);
  console.log(JSON.stringify(report, null, 2));

  if (!preflight.ok && (!knownPreflightCode || !KNOWN_REASON_CODES.has(knownPreflightCode))) {
    console.error("Unclassified preflight failure; failing diagnostics gate.");
    process.exit(1);
  }
  if (!verify.ok && classification === "unknown") {
    console.error("Unclassified verify failure; failing diagnostics gate.");
    process.exit(1);
  }
}

main();
