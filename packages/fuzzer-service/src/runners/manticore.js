"use strict";

/**
 * Manticore runner (Trail of Bits symbolic execution engine).
 *
 * Manticore performs symbolic execution on EVM bytecode, exhaustively
 * exploring execution paths to find bugs — complementary to fuzzing.
 *
 * Install:
 *   pip3 install manticore[native]
 *   docker pull trailofbits/manticore:latest
 *
 * Docs: https://github.com/trailofbits/manticore
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapBugTypeToSeverity } = require("./types");

/**
 * @param {import('../queue').FuzzJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runManticore(job) {
  const rpcUrl = job.chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";
  const outputDir = path.join("/tmp", `manticore-${job.id}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const useDocker = !isBinaryAvailable("manticore");

  return new Promise((resolve) => {
    let proc;

    // Manticore EVM mode: analyze a contract at an RPC endpoint by address.
    // --rpc points to the JSON-RPC node, --contract is the target address.
    // --workspace stores results (traces, findings JSON).
    const args = [
      "--evm",
      "--rpc", rpcUrl,
      "--contract", job.contractAddress,
      "--workspace", outputDir,
      "--timeout", String(Math.min(job.budgetSeconds - 5, 600)),
      "--outputspace", outputDir,
    ];

    if (useDocker) {
      proc = spawn("docker", [
        "run", "--rm",
        "-v", `${outputDir}:/workspace`,
        "trailofbits/manticore:latest",
        ...args.map(a => a === outputDir ? "/workspace" : a),
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("manticore", args, { stdio: ["ignore", "pipe", "pipe"] });
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), job.budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      const streamFindings = parseManticoreOutput(stdout + stderr, job.contractAddress);
      const fileFindings = parseManticoreWorkspace(outputDir, job.contractAddress);

      const all = [...streamFindings];
      for (const f of fileFindings) {
        if (!all.some(e => e.title === f.title)) all.push(f);
      }

      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
      resolve(all);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[manticore] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse Manticore's stdout/stderr for finding lines.
 *
 * Manticore emits lines like:
 *   [<timestamp>][manticore.ethereum.manticore] WARNING:Potential integer overflow ...
 *   [<timestamp>][manticore.ethereum.detectors] BUG: Reentrancy at PC=0x...
 */
function parseManticoreOutput(output, contractAddress) {
  const findings = [];

  // Pattern: WARNING:Potential <bug_type>
  const warnPattern = /WARNING:\s*Potential\s+([\w\s]+?)(?:\s+at|$)/gm;
  let match;
  while ((match = warnPattern.exec(output)) !== null) {
    const bugType = match[1].trim();
    if (!findings.some(f => f.title.includes(bugType))) {
      findings.push(makeManticoreFinding(bugType, contractAddress, output));
    }
  }

  // Pattern: BUG: <type>
  const bugPattern = /BUG:\s*([\w\s]+?)(?:\s+at\s+PC=[\w]+)?$/gm;
  while ((match = bugPattern.exec(output)) !== null) {
    const bugType = match[1].trim();
    if (!findings.some(f => f.title.includes(bugType))) {
      findings.push(makeManticoreFinding(bugType, contractAddress, output));
    }
  }

  // Detector output: "Detector <Name>: <message>"
  const detectorPattern = /Detector\s+([\w]+):\s*(.+)/gm;
  while ((match = detectorPattern.exec(output)) !== null) {
    const detectorName = match[1].trim();
    const msg = match[2].trim();
    if (!findings.some(f => f.title.includes(detectorName))) {
      findings.push({
        id: `FZ-MANT-DET-${detectorName.toUpperCase()}-${Date.now()}`,
        severity: mapBugTypeToSeverity(detectorName),
        title: `${detectorName} (Manticore detector)`,
        description: `Manticore detector ${detectorName}: ${msg} in ${contractAddress}`,
        confidence: 0.88,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      });
    }
  }

  return findings;
}

/**
 * Parse Manticore workspace JSON files.
 * Manticore writes <workspace>/global.findings or per-state JSON files.
 */
function parseManticoreWorkspace(outputDir, contractAddress) {
  const findings = [];
  try {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (!file.endsWith(".json") && file !== "global.findings") continue;
      try {
        const raw = fs.readFileSync(path.join(outputDir, file), "utf8");
        const obj = JSON.parse(raw);
        const issues = Array.isArray(obj) ? obj : (obj.findings ?? obj.issues ?? []);
        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          const bugType = issue.type ?? issue.kind ?? issue.name ?? "unknown";
          findings.push({
            id: `FZ-MANT-FILE-${String(i + 1).padStart(3, "0")}`,
            severity: mapBugTypeToSeverity(bugType),
            title: `${capitalize(bugType)} (Manticore)`,
            description: issue.description ?? `Manticore: ${bugType} in ${contractAddress}`,
            confidence: 0.88,
            agentId: "fuzzer-012",
            timestamp: Date.now(),
          });
        }
      } catch {}
    }
  } catch {}
  return findings;
}

function makeManticoreFinding(bugType, contractAddress, context) {
  return {
    id: `FZ-MANT-${bugType.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`,
    severity: mapBugTypeToSeverity(bugType),
    title: `${capitalize(bugType)} (Manticore)`,
    description: `Manticore symbolic execution: ${bugType} detected in ${contractAddress}`,
    confidence: 0.88,
    agentId: "fuzzer-012",
    timestamp: Date.now(),
  };
}

function isBinaryAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

module.exports = { runManticore };
