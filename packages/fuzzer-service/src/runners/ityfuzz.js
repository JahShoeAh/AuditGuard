"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { mapBugTypeToSeverity } = require("./types");

const CORPUS_DIR = process.env.ITYFUZZ_CORPUS_DIR ?? path.join(__dirname, "../../../.corpus/ityfuzz");

/**
 * Run ItyFuzz against a deployed contract.
 * Tries the `ityfuzz` binary first, then Docker.
 *
 * @param {import('../queue').FuzzJob} job
 * @returns {Promise<import('./types').Finding[]>}
 */
async function runItyFuzz(job) {
  const corpusPath = path.join(CORPUS_DIR, job.contractAddress.toLowerCase().replace(/^0x/, ""));
  fs.mkdirSync(corpusPath, { recursive: true });

  const outputDir = path.join("/tmp", `ityfuzz-${job.id}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const rpcUrl = job.chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";

  // Determine whether to use native binary or Docker
  const useDocker = !isBinaryAvailable("ityfuzz");

  const args = buildItyFuzzArgs({
    contractAddress: job.contractAddress,
    chainId: job.chainId ?? "296",
    rpcUrl,
    outputDir,
    corpusPath,
  });

  const findings = await spawnFuzzer({
    useDocker,
    args,
    budgetSeconds: job.budgetSeconds,
    outputDir,
    contractAddress: job.contractAddress,
    corpusPath,
  });

  // Clean up tmp output
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}

  return findings;
}

function buildItyFuzzArgs({ contractAddress, chainId, rpcUrl, outputDir, corpusPath }) {
  return [
    "evm",
    "--onchain-block-number", "0",
    "--chain-id", chainId,
    "--onchain-rpc", rpcUrl,
    "--target", contractAddress,
    "--run-forever",
    "--output-dir", outputDir,
    "--corpus-dir", corpusPath,
    "--bug-oracle", "all",
  ];
}

/**
 * @returns {Promise<import('./types').Finding[]>}
 */
function spawnFuzzer({ useDocker, args, budgetSeconds, outputDir, contractAddress, corpusPath }) {
  return new Promise((resolve) => {
    const findings = [];
    let proc;

    if (useDocker) {
      // Mount output dir and corpus into container
      const dockerArgs = [
        "run", "--rm",
        "-v", `${outputDir}:/output`,
        "-v", `${corpusPath}:/corpus`,
        "fuzzland/ityfuzz:latest",
        ...args.map(a => {
          if (a === outputDir) return "/output";
          if (a === corpusPath) return "/corpus";
          return a;
        }),
      ];
      proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("ityfuzz", args, { stdio: ["ignore", "pipe", "pipe"] });
    }

    function onData(data) {
      parseItyFuzzOutput(data.toString(), findings, contractAddress);
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, budgetSeconds * 1000);

    proc.on("close", () => {
      clearTimeout(timer);
      // Also parse any JSON output files left in outputDir
      const extra = parseOutputDir(outputDir, contractAddress);
      extra.forEach(f => {
        if (!findings.some(e => e.id === f.id)) findings.push(f);
      });
      resolve(findings);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[ityfuzz] spawn error: ${err.message}`);
      resolve(findings);
    });
  });
}

/**
 * Parse ItyFuzz stdout/stderr for bug report lines.
 * ItyFuzz outputs lines like:
 *   [BUG] reentrancy detected at 0x... via 0x...
 *   BUG FOUND: overflow at 0x...
 */
function parseItyFuzzOutput(output, findings, contractAddress) {
  // Pattern 1: "[BUG] <type> at <addr>"
  const pattern1 = /\[BUG\]\s+(\w[\w\s]+?)\s+(?:detected\s+)?at\s+(0x[\da-fA-F]+)/g;
  // Pattern 2: "BUG FOUND: <type> at <addr>"
  const pattern2 = /BUG FOUND:\s+([\w\s]+?)\s+at\s+(0x[\da-fA-F]+)/gi;
  // Pattern 3: ItyFuzz JSON output lines
  const pattern3 = /\{.*?"bug_type"\s*:\s*"([^"]+)".*?"addr"\s*:\s*"(0x[\da-fA-F]+)".*?\}/g;

  for (const pattern of [pattern1, pattern2, pattern3]) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const bugType = match[1].trim();
      const addr = match[2];
      const id = `FZ-ITYF-${bugType.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`;
      if (!findings.some(f => f.title.includes(bugType))) {
        findings.push({
          id,
          severity: mapBugTypeToSeverity(bugType),
          title: `${capitalize(bugType)} vulnerability`,
          description: `ItyFuzz detected ${bugType} at address ${addr} in contract ${contractAddress}`,
          confidence: 0.92,
          agentId: "fuzzer-012",
          timestamp: Date.now(),
        });
      }
    }
  }
}

/**
 * Parse any JSON result files ItyFuzz writes to the output directory.
 */
function parseOutputDir(outputDir, contractAddress) {
  const findings = [];
  try {
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(outputDir, file), "utf8");
        const obj = JSON.parse(raw);
        const bugs = Array.isArray(obj) ? obj : (obj.bugs ?? obj.findings ?? []);
        for (const bug of bugs) {
          const bugType = bug.bug_type ?? bug.type ?? bug.name ?? "unknown";
          findings.push({
            id: `FZ-ITYF-FILE-${bugType.toUpperCase()}-${Date.now()}`,
            severity: mapBugTypeToSeverity(bugType),
            title: `${capitalize(bugType)} vulnerability`,
            description: `ItyFuzz output file: ${bugType} in ${contractAddress}`,
            confidence: 0.90,
            agentId: "fuzzer-012",
            timestamp: Date.now(),
          });
        }
      } catch {}
    }
  } catch {}
  return findings;
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

module.exports = { runItyFuzz };
