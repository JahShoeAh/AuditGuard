"use strict";

/**
 * Heimdall runner (bytecode decompiler + static analyzer).
 *
 * Heimdall is a Rust-based EVM toolkit that can decompile bytecode and run
 * static analysis checks (reentrancy, integer overflow, access control) against
 * a deployed contract using only its on-chain bytecode — no source needed.
 *
 * Install:
 *   cargo install heimdall-rs
 *   # or: brew install Jon-Becker/homebrew-tap/heimdall-rs
 *   # or: docker pull ghcr.io/jon-becker/heimdall-rs:latest
 *
 * Docs: https://github.com/Jon-Becker/heimdall-rs
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapBugTypeToSeverity } = require("./types");

/**
 * @param {import('../queue').FuzzJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runHeimdall(job) {
  const rpcUrl = job.chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";
  const outputDir = path.join("/tmp", `heimdall-${job.id}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const useDocker = !isBinaryAvailable("heimdall");

  // Run both `heimdall inspect` (vulnerability patterns) and `heimdall decompile`
  // (produces pseudo-Solidity which can reveal logic bugs).
  const inspectFindings = await runHeimdallInspect({ job, rpcUrl, outputDir, useDocker });
  const decompileFindings = await runHeimdallDecompile({ job, rpcUrl, outputDir, useDocker });

  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}

  // Deduplicate by title
  const all = [...inspectFindings];
  for (const f of decompileFindings) {
    if (!all.some(e => e.title === f.title)) all.push(f);
  }
  return all;
}

/**
 * heimdall inspect — runs known vulnerability detectors against bytecode.
 */
function runHeimdallInspect({ job, rpcUrl, outputDir, useDocker }) {
  return spawnHeimdall({
    subcommand: "inspect",
    args: [
      job.contractAddress,
      "--rpc-url", rpcUrl,
      "--output", path.join(outputDir, "inspect"),
      "--json",
      "--verbose",
    ],
    budgetSeconds: Math.floor(job.budgetSeconds * 0.5),
    outputDir: path.join(outputDir, "inspect"),
    contractAddress: job.contractAddress,
    useDocker,
    parseOutput: parseHeimdallInspectOutput,
  });
}

/**
 * heimdall decompile — decompiles bytecode to pseudo-Solidity.
 * We parse the output for known dangerous patterns.
 */
function runHeimdallDecompile({ job, rpcUrl, outputDir, useDocker }) {
  return spawnHeimdall({
    subcommand: "decompile",
    args: [
      job.contractAddress,
      "--rpc-url", rpcUrl,
      "--output", path.join(outputDir, "decompile"),
      "--include-sol",
    ],
    budgetSeconds: Math.floor(job.budgetSeconds * 0.5),
    outputDir: path.join(outputDir, "decompile"),
    contractAddress: job.contractAddress,
    useDocker,
    parseOutput: parseHeimdallDecompileOutput,
  });
}

function spawnHeimdall({ subcommand, args, budgetSeconds, outputDir, contractAddress, useDocker, parseOutput }) {
  return new Promise((resolve) => {
    fs.mkdirSync(outputDir, { recursive: true });

    let proc;
    const fullArgs = [subcommand, ...args];

    if (useDocker) {
      proc = spawn("docker", [
        "run", "--rm",
        "-v", `${outputDir}:/output`,
        "ghcr.io/jon-becker/heimdall-rs:latest",
        ...fullArgs.map(a => a.startsWith(outputDir) ? a.replace(outputDir, "/output") : a),
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("heimdall", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGTERM"), budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      const streamFindings = parseOutput(stdout + stderr, contractAddress);
      const fileFindings = parseHeimdallOutputDir(outputDir, contractAddress);

      const all = [...streamFindings];
      for (const f of fileFindings) {
        if (!all.some(e => e.title === f.title)) all.push(f);
      }
      resolve(all);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[heimdall:${subcommand}] spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Parse `heimdall inspect` stdout/stderr.
 *
 * Heimdall inspect outputs lines like:
 *   [HIGH] Reentrancy: external call before state update at 0x...
 *   [MEDIUM] Integer Overflow: unchecked arithmetic at 0x...
 *   [LOW] tx.origin used for authorization
 */
function parseHeimdallInspectOutput(output, contractAddress) {
  const findings = [];

  const pattern = /\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+([\w\s]+?):\s*(.+?)(?:\s+at\s+0x[\da-fA-F]+)?$/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const sev = match[1].toLowerCase();
    const issueType = match[2].trim();
    const detail = match[3].trim();
    if (!findings.some(f => f.title.includes(issueType))) {
      findings.push({
        id: `FZ-HEIM-INSP-${issueType.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`,
        severity: mapHeimdallSeverity(sev),
        title: `${issueType} (Heimdall inspect)`,
        description: `Heimdall: ${detail} in ${contractAddress}`,
        confidence: 0.87,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      });
    }
  }

  return findings;
}

/**
 * Parse `heimdall decompile` output for dangerous patterns in the pseudo-Solidity.
 *
 * We scan for common Solidity vulnerability patterns in the decompiled source:
 *   - call{value:...}() before state update (reentrancy)
 *   - tx.origin auth
 *   - delegatecall
 *   - selfdestruct
 *   - block.timestamp comparison
 */
function parseHeimdallDecompileOutput(output, contractAddress) {
  const findings = [];

  const checks = [
    {
      pattern: /\.call\{value:/g,
      title: "Potential reentrancy",
      description: "External call with ETH value transfer detected in decompiled bytecode",
      severity: "high",
    },
    {
      pattern: /tx\.origin/g,
      title: "tx.origin authorization",
      description: "tx.origin used for authorization — vulnerable to phishing attacks",
      severity: "medium",
    },
    {
      pattern: /delegatecall/g,
      title: "delegatecall usage",
      description: "delegatecall found in decompiled bytecode — can lead to storage corruption",
      severity: "high",
    },
    {
      pattern: /selfdestruct/g,
      title: "selfdestruct present",
      description: "selfdestruct found — contract can be destroyed, draining all ETH",
      severity: "critical",
    },
    {
      pattern: /block\.timestamp/g,
      title: "Block timestamp dependency",
      description: "block.timestamp used in logic — miners can manipulate within ~15s",
      severity: "low",
    },
    {
      pattern: /assembly\s*\{/g,
      title: "Inline assembly",
      description: "Inline assembly detected — bypasses Solidity safety checks",
      severity: "info",
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(output)) {
      findings.push({
        id: `FZ-HEIM-DECOMP-${check.title.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`,
        severity: check.severity,
        title: `${check.title} (Heimdall decompile)`,
        description: `${check.description} in ${contractAddress}`,
        confidence: 0.75,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      });
    }
  }

  return findings;
}

/**
 * Parse any JSON files Heimdall writes to its output directory.
 */
function parseHeimdallOutputDir(outputDir, contractAddress) {
  const findings = [];
  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(full, "utf8");
          const obj = JSON.parse(raw);
          const issues = Array.isArray(obj) ? obj : (obj.findings ?? obj.vulnerabilities ?? obj.issues ?? []);
          for (let i = 0; i < issues.length; i++) {
            const issue = issues[i];
            const bugType = issue.type ?? issue.kind ?? issue.name ?? "unknown";
            const sev = issue.severity ?? mapBugTypeToSeverity(bugType);
            findings.push({
              id: `FZ-HEIM-FILE-${String(i + 1).padStart(3, "0")}`,
              severity: typeof sev === "string" && ["critical","high","medium","low","info"].includes(sev.toLowerCase())
                ? sev.toLowerCase()
                : mapBugTypeToSeverity(bugType),
              title: `${capitalize(bugType)} (Heimdall)`,
              description: issue.description ?? `Heimdall: ${bugType} in ${contractAddress}`,
              confidence: 0.85,
              agentId: "fuzzer-012",
              timestamp: Date.now(),
            });
          }
        } catch {}
      }
    };
    walk(outputDir);
  } catch {}
  return findings;
}

function mapHeimdallSeverity(sev) {
  const lower = (sev ?? "").toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  if (lower === "low") return "low";
  return "info";
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

module.exports = { runHeimdall };
