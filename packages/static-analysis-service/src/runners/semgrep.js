"use strict";

/**
 * Semgrep runner — pattern-matching against known DeFi exploit signatures.
 *
 * Uses Decurity's smart contract rule set which covers:
 * flash loan price manipulation, donation attacks, first-depositor issues,
 * unsafe approvals, and other known DeFi vulnerability patterns.
 *
 * Install: pip3 install semgrep
 * Rules:   git clone https://github.com/Decurity/semgrep-smart-contracts /opt/semgrep-solidity-rules
 *          OR use: --config p/smart-contracts (public registry)
 * Docs: https://github.com/Decurity/semgrep-smart-contracts
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapImpactToSeverity } = require("./types");

// Local Decurity rules take priority; fall back to public registry
const SEMGREP_RULES = fs.existsSync("/opt/semgrep-solidity-rules")
  ? "/opt/semgrep-solidity-rules"
  : "p/smart-contracts";

/**
 * @param {import('../queue').StaticJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runSemgrep(job) {
  if (!job.sourceDir || !fs.existsSync(job.sourceDir)) {
    console.log(`[semgrep] No sourceDir provided or path does not exist — skipping`);
    return [];
  }

  const outputFile = path.join("/tmp", `semgrep-${job.id}.json`);

  return new Promise((resolve) => {
    const proc = spawn("semgrep", [
      "--config", SEMGREP_RULES,
      "--json",
      "--output", outputFile,
      "--no-git-ignore",
      "--quiet",
      job.sourceDir,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), job.budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      const findings = parseSemgrepOutput(outputFile, job.contractAddress);
      try { fs.unlinkSync(outputFile); } catch {}
      resolve(findings);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[semgrep] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse Semgrep JSON output into AuditGuard Finding objects.
 *
 * Semgrep JSON schema:
 * {
 *   "results": [
 *     {
 *       "check_id": "solidity.security.reentrancy",
 *       "path": "...",
 *       "extra": {
 *         "message": "...",
 *         "severity": "WARNING",
 *         "metadata": { "impact": "HIGH", "confidence": "MEDIUM" }
 *       }
 *     }
 *   ]
 * }
 */
function parseSemgrepOutput(outputFile, contractAddress) {
  const findings = [];
  const seen = new Set();

  try {
    if (!fs.existsSync(outputFile)) return findings;
    const raw = fs.readFileSync(outputFile, "utf8");
    const obj = JSON.parse(raw);

    const results = obj.results ?? [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const checkId = r.check_id ?? "unknown";
      const message = r.extra?.message ?? r.message ?? `Semgrep: ${checkId}`;
      const semgrepSeverity = r.extra?.severity ?? r.severity ?? "WARNING";
      const metadata = r.extra?.metadata ?? {};
      const impact = metadata.impact ?? metadata.severity ?? semgrepSeverity;
      const confidence = metadata.confidence ?? "MEDIUM";

      // Deduplicate by check_id
      if (seen.has(checkId)) continue;
      seen.add(checkId);

      const title = formatSemgrepCheckId(checkId);

      findings.push({
        id: `SA-SEMG-${String(i + 1).padStart(3, "0")}`,
        severity: mapImpactToSeverity(impact),
        title: `${title} (Semgrep)`,
        description: message.trim().slice(0, 500),
        confidence: mapSemgrepConfidence(confidence),
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.error(`[semgrep] Failed to parse output: ${err.message}`);
  }

  return findings;
}

/** "solidity.security.reentrancy-eth" → "Reentrancy Eth" */
function formatSemgrepCheckId(checkId) {
  const parts = checkId.split(".");
  const last = parts[parts.length - 1] ?? checkId;
  return last
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mapSemgrepConfidence(confidence) {
  const lower = (confidence ?? "").toLowerCase();
  if (lower === "high") return 0.90;
  if (lower === "medium") return 0.72;
  if (lower === "low") return 0.58;
  return 0.65;
}

module.exports = { runSemgrep };
