"use strict";

const { spawn, execSync } = require("child_process");
const { mapBugTypeToSeverity } = require("./types");

/**
 * Run Mythril symbolic execution against a deployed contract.
 * Tries `myth` binary first, then Docker mythril/myth image.
 *
 * Mythril JSON output schema:
 *   { "success": true, "issues": [ { "title", "severity", "description", "address" } ] }
 *
 * @param {import('../queue').FuzzJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runMythril(job) {
  const rpcUrl = job.chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";
  const useDocker = !isBinaryAvailable("myth");

  return new Promise((resolve) => {
    let proc;
    const args = [
      "analyze",
      "--rpc", rpcUrl,
      "--contract-address", job.contractAddress,
      "--json",
      "--execution-timeout", String(Math.min(job.budgetSeconds - 10, 300)),
    ];

    if (useDocker) {
      proc = spawn("docker", [
        "run", "--rm",
        "mythril/myth:latest",
        ...args,
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("myth", args, { stdio: ["ignore", "pipe", "pipe"] });
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), job.budgetSeconds * 1000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const findings = parseMythrilOutput(stdout, job.contractAddress);
      resolve(findings);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[mythril] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse Mythril JSON output into AuditGuard Finding objects.
 */
function parseMythrilOutput(output, contractAddress) {
  const findings = [];

  try {
    // Mythril sometimes prepends log lines before the JSON blob
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) return findings;
    const obj = JSON.parse(output.slice(jsonStart));

    const issues = obj.issues ?? obj.results?.issues ?? [];
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const title = issue.title ?? issue.swc_title ?? "Unknown vulnerability";
      const severity = mapMythrilSeverity(issue.severity) ?? mapBugTypeToSeverity(title);
      findings.push({
        id: `FZ-MYTH-${String(i + 1).padStart(3, "0")}`,
        severity,
        title,
        description: issue.description ?? issue.description_long ?? `Mythril: ${title} in ${contractAddress}`,
        confidence: 0.85,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    // JSON parse failed — try to extract issues from plain text output
    const pattern = /SWC-\d+\s*\n.*?Title:\s*(.+?)\n.*?Severity:\s*(\w+)/gs;
    let match;
    let idx = 0;
    while ((match = pattern.exec(output)) !== null) {
      const title = match[1].trim();
      const sev = match[2].trim();
      findings.push({
        id: `FZ-MYTH-TXT-${String(++idx).padStart(3, "0")}`,
        severity: mapMythrilSeverity(sev) ?? "medium",
        title,
        description: `Mythril (text output): ${title} in ${contractAddress}`,
        confidence: 0.80,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      });
    }
  }

  return findings;
}

/** Map Mythril severity strings to AuditGuard severity levels. */
function mapMythrilSeverity(sev) {
  if (!sev) return null;
  const lower = sev.toLowerCase();
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  if (lower === "low") return "low";
  return null;
}

function isBinaryAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { runMythril };
