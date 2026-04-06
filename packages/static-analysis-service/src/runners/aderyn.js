"use strict";

/**
 * Aderyn runner — fast static analysis for Solidity source code.
 *
 * Aderyn is a Rust-based analyzer from Cyfrin — fastest source-based tool,
 * with 50+ detectors covering modern Solidity patterns.
 *
 * Install: cargo install aderyn   OR   brew install cyfrin/tap/aderyn
 * Docs: https://github.com/Cyfrin/aderyn
 *
 * JSON output schema:
 * {
 *   "high_issues": { "issues": [ { "title", "description", "severity" } ] },
 *   "low_issues":  { "issues": [ ... ] },
 *   "medium_issues": { ... },
 *   "nc_issues": { ... }
 * }
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapImpactToSeverity } = require("./types");

/**
 * @param {import('../queue').StaticJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runAderyn(job) {
  if (!job.sourceDir || !fs.existsSync(job.sourceDir)) {
    console.log(`[aderyn] No sourceDir provided or path does not exist — skipping`);
    return [];
  }

  const outputFile = path.join("/tmp", `aderyn-${job.id}.json`);

  return new Promise((resolve) => {
    const proc = spawn("aderyn", [
      job.sourceDir,
      "--output", outputFile,
      "--skip-update-check",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: job.sourceDir,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), job.budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      const findings = parseAderynOutput(outputFile, job.contractAddress);
      try { fs.unlinkSync(outputFile); } catch {}
      resolve(findings);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[aderyn] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse Aderyn JSON output into AuditGuard Finding objects.
 */
function parseAderynOutput(outputFile, contractAddress) {
  const findings = [];
  try {
    if (!fs.existsSync(outputFile)) return findings;
    const raw = fs.readFileSync(outputFile, "utf8");
    const obj = JSON.parse(raw);

    // Aderyn groups issues by severity bucket
    const buckets = [
      { key: "high_issues", severity: "high", confidence: 0.88 },
      { key: "medium_issues", severity: "medium", confidence: 0.82 },
      { key: "low_issues", severity: "low", confidence: 0.75 },
      { key: "nc_issues", severity: "info", confidence: 0.65 },
    ];

    let idx = 0;
    for (const bucket of buckets) {
      const issues = obj[bucket.key]?.issues ?? [];
      for (const issue of issues) {
        const title = issue.title ?? issue.name ?? "Unknown issue";
        const description = issue.description ?? issue.detail ?? `Aderyn: ${title}`;
        findings.push({
          id: `SA-ADERYN-${String(++idx).padStart(3, "0")}`,
          severity: issue.severity ? mapImpactToSeverity(issue.severity) : bucket.severity,
          title: `${title} (Aderyn)`,
          description: description.trim().slice(0, 500),
          confidence: bucket.confidence,
          agentId: "static-analysis-047",
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error(`[aderyn] Failed to parse output: ${err.message}`);
  }
  return findings;
}

module.exports = { runAderyn };
