"use strict";

/**
 * Slither runner — static analysis for Solidity source code.
 *
 * Slither requires source code (Solidity files or a Hardhat/Foundry project).
 * If only a contract address is provided and no sourceDir, this runner skips.
 *
 * Install: pip3 install slither-analyzer
 * Docs: https://github.com/crytic/slither
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapSlitherSeverity } = require("./types");

/**
 * @param {import('../queue').StaticJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runSlither(job) {
  // Slither requires source code — skip if no sourceDir provided
  if (!job.sourceDir || !fs.existsSync(job.sourceDir)) {
    console.log(`[slither] No sourceDir provided or path does not exist — skipping`);
    return [];
  }

  const useDocker = !isBinaryAvailable("slither");
  const outputFile = path.join("/tmp", `slither-${job.id}.json`);

  const args = [
    job.sourceDir,
    "--json", outputFile,
    "--no-fail-pedantic",
    "--exclude-informational",  // keep output focused on real issues
  ];

  return new Promise((resolve) => {
    let proc;

    if (useDocker) {
      proc = spawn("docker", [
        "run", "--rm",
        "-v", `${job.sourceDir}:/src`,
        "-v", `/tmp:/tmp`,
        "trailofbits/eth-security-toolbox",
        "slither", "/src",
        "--json", outputFile,
        "--no-fail-pedantic",
        "--exclude-informational",
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("slither", args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: job.sourceDir,
      });
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), job.budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      const findings = parseSlitherOutput(outputFile, job.contractAddress);
      try { fs.unlinkSync(outputFile); } catch {}
      resolve(findings);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[slither] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse Slither JSON output file into AuditGuard Finding objects.
 *
 * Slither JSON schema:
 * {
 *   "success": true,
 *   "error": null,
 *   "results": {
 *     "detectors": [
 *       {
 *         "check": "reentrancy-eth",
 *         "impact": "High",
 *         "confidence": "Medium",
 *         "description": "...",
 *         "elements": [...]
 *       }
 *     ]
 *   }
 * }
 */
function parseSlitherOutput(outputFile, contractAddress) {
  const findings = [];
  try {
    if (!fs.existsSync(outputFile)) return findings;
    const raw = fs.readFileSync(outputFile, "utf8");
    const obj = JSON.parse(raw);

    const detectors = obj.results?.detectors ?? [];
    for (let i = 0; i < detectors.length; i++) {
      const d = detectors[i];
      const check = d.check ?? "unknown";
      const impact = d.impact ?? "Medium";
      const confidence = d.confidence ?? "Medium";
      const description = d.description ?? `Slither: ${check}`;

      // Build a human-readable title from the check name
      const title = formatSlitherCheckName(check);

      findings.push({
        id: `SA-SLTH-${String(i + 1).padStart(3, "0")}`,
        severity: mapSlitherSeverity(impact, confidence),
        title: `${title} (Slither)`,
        description: description.trim().slice(0, 500),
        confidence: mapConfidenceToFloat(confidence),
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.error(`[slither] Failed to parse output: ${err.message}`);
  }
  return findings;
}

/** Convert "reentrancy-eth" → "Reentrancy (ETH)" style titles */
function formatSlitherCheckName(check) {
  return check
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Map Slither confidence strings to 0–1 float */
function mapConfidenceToFloat(confidence) {
  const lower = (confidence ?? "").toLowerCase();
  if (lower === "high") return 0.92;
  if (lower === "medium") return 0.78;
  if (lower === "low") return 0.60;
  return 0.70;
}

function isBinaryAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { runSlither };
