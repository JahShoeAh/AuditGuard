#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "recon", "test-logs");
const OFFLINE_STATE = path.join(ROOT, "packages", "dashboard", "public", "offline-state.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runToLog(logName, command, args = [], options = {}) {
  const logPath = path.join(LOG_DIR, logName);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 40,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(logPath, output);
  return { ok: result.status === 0, status: result.status ?? 1, logPath, output };
}

function assertOfflineState() {
  if (!fs.existsSync(OFFLINE_STATE)) {
    throw new Error(`offline state missing: ${OFFLINE_STATE}`);
  }
  const snapshot = JSON.parse(fs.readFileSync(OFFLINE_STATE, "utf8"));
  const activeJobs = snapshot.activeJobs || {};
  const bids = snapshot.bids || {};
  const winners = snapshot.winners || {};
  const auditLog = snapshot.auditLog || [];

  const jobIds = Object.keys(activeJobs);
  if (jobIds.length === 0) throw new Error("offline snapshot has zero active jobs");
  if (Object.keys(bids).length === 0) throw new Error("offline snapshot has zero bid sets");
  if (Object.keys(winners).length === 0) throw new Error("offline snapshot has zero winner sets");

  const requiredAuditTypes = ["JOB_CREATED", "AUCTION_INVITE_SUMMARY", "REPORT_PUBLISHED"];
  for (const eventType of requiredAuditTypes) {
    if (!auditLog.some((entry) => entry?.type === eventType)) {
      throw new Error(`offline snapshot missing audit event: ${eventType}`);
    }
  }
}

function main() {
  ensureDir(LOG_DIR);

  const backend = runToLog("backend.log", "npm", ["--prefix", "orchestrator", "run", "test:offline"]);
  if (!backend.ok) {
    console.error(`Backend smoke failed. See ${backend.logPath}`);
    process.exit(1);
  }

  const agents = runToLog("agents.log", "npm", [
    "--workspace",
    "agents",
    "run",
    "test",
    "--",
    "tests/e2e-flow.test.ts",
    "tests/auction-invite.test.ts",
  ]);
  if (!agents.ok) {
    console.error(`Agents smoke failed. See ${agents.logPath}`);
    process.exit(1);
  }

  const dashboard = runToLog("dashboard.log", "npm", [
    "--prefix",
    "packages/dashboard",
    "run",
    "test",
    "--",
    "src/__tests__/event-listener.test.js",
    "src/__tests__/event-contract-compat.test.js",
    "src/__tests__/use-auction-data.test.js",
  ]);
  if (!dashboard.ok) {
    console.error(`Dashboard smoke failed. See ${dashboard.logPath}`);
    process.exit(1);
  }

  const lifecycle = runToLog("lifecycle_parser.log", "node", [
    "scripts/parse-lifecycle-log.js",
    backend.logPath,
    agents.logPath,
    dashboard.logPath,
  ]);
  if (!lifecycle.ok) {
    console.error(`Lifecycle parser failed. See ${lifecycle.logPath}`);
    process.exit(1);
  }

  const diagnostics = runToLog("runtime_diagnostics.log", "node", [
    "scripts/runtime-readiness-diagnostics.js",
  ]);
  if (!diagnostics.ok) {
    console.error(`Runtime diagnostics failed. See ${diagnostics.logPath}`);
    process.exit(1);
  }

  assertOfflineState();

  console.log("✅ stack smoke passed");
  console.log(`- backend log: ${backend.logPath}`);
  console.log(`- agents log: ${agents.logPath}`);
  console.log(`- dashboard log: ${dashboard.logPath}`);
  console.log(`- lifecycle parser log: ${lifecycle.logPath}`);
  console.log(`- runtime diagnostics log: ${diagnostics.logPath}`);
}

main();
