"use strict";

const { randomUUID } = require("crypto");

/**
 * In-memory job queue for static analysis jobs.
 * Runs one job at a time; tools are run in parallel within each job.
 */

let currentWorker = Promise.resolve();

/** @type {Map<string, StaticJob>} */
const jobs = new Map();

/**
 * @typedef {Object} StaticJob
 * @property {string} id
 * @property {string} contractAddress
 * @property {string} [sourceDir]         - path to Solidity source (optional)
 * @property {string} [chainForkUrl]
 * @property {number} budgetSeconds
 * @property {"slither"|"aderyn"|"semgrep"|"auto"} tool
 * @property {"queued"|"running"|"done"|"failed"} status
 * @property {import('./runners/types').Finding[]} findings
 * @property {number} enqueuedAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {string} [error]
 * @property {string} [toolUsed]
 */

/**
 * @param {Omit<StaticJob, "id"|"status"|"findings"|"enqueuedAt">} opts
 * @returns {string} jobId
 */
function enqueue(opts) {
  const id = randomUUID();
  /** @type {StaticJob} */
  const job = {
    id,
    contractAddress: opts.contractAddress,
    sourceDir: opts.sourceDir ?? null,
    chainForkUrl: opts.chainForkUrl,
    budgetSeconds: opts.budgetSeconds ?? 120,
    tool: opts.tool ?? "auto",
    status: "queued",
    findings: [],
    enqueuedAt: Date.now(),
  };
  jobs.set(id, job);
  scheduleWork(job);
  return id;
}

function get(id) {
  return jobs.get(id) ?? null;
}

function scheduleWork(job) {
  currentWorker = currentWorker.then(() => runJob(job)).catch(() => {});
}

async function runJob(job) {
  const { runSlither } = require("./runners/slither");
  const { runAderyn } = require("./runners/aderyn");
  const { runSemgrep } = require("./runners/semgrep");

  job.status = "running";
  job.startedAt = Date.now();

  try {
    const allFindings = [];
    const toolsUsed = [];

    const TOOL_CHECKS = [
      {
        name: "slither",
        enabled: job.tool === "slither" || job.tool === "auto",
        available: async () => isCommandAvailable("slither") || isDockerImageAvailable("trailofbits/eth-security-toolbox"),
        run: runSlither,
      },
      {
        name: "aderyn",
        enabled: job.tool === "aderyn" || job.tool === "auto",
        available: async () => isCommandAvailable("aderyn"),
        run: runAderyn,
      },
      {
        name: "semgrep",
        enabled: job.tool === "semgrep" || job.tool === "auto",
        available: async () => isCommandAvailable("semgrep"),
        run: runSemgrep,
      },
    ];

    // Run all available tools; skip those without sourceDir or that are unavailable
    for (const tool of TOOL_CHECKS) {
      if (!tool.enabled) continue;
      let avail = false;
      try { avail = await tool.available(); } catch {}
      if (!avail) {
        console.log(`[static-analysis-service] ${tool.name}: not installed — skipping`);
        continue;
      }

      console.log(`[static-analysis-service] Running ${tool.name} on ${job.contractAddress} (sourceDir: ${job.sourceDir ?? "none"})`);
      try {
        const results = await tool.run(job);
        // Merge: skip duplicates by title
        for (const f of results) {
          if (!allFindings.some(e => e.title === f.title)) allFindings.push(f);
        }
        toolsUsed.push(tool.name);
        console.log(`[static-analysis-service] ${tool.name}: ${results.length} findings`);
      } catch (err) {
        console.error(`[static-analysis-service] ${tool.name} error: ${err.message}`);
      }
    }

    job.findings = allFindings;
    job.toolUsed = toolsUsed.length > 0 ? toolsUsed.join("+") : "none";
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.findings = [];
  } finally {
    job.finishedAt = Date.now();
  }
}

function isCommandAvailable(cmd) {
  const { execSync } = require("child_process");
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isDockerImageAvailable(image) {
  const { execSync } = require("child_process");
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { enqueue, get };
