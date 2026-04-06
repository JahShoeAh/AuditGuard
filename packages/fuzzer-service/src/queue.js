"use strict";

const { randomUUID } = require("crypto");

/**
 * In-memory job queue with single worker processing one job at a time.
 * Corpus is persisted per-contract in CORPUS_DIR for progressive coverage.
 */

let currentWorker = Promise.resolve();

/** @type {Map<string, FuzzJob>} */
const jobs = new Map();

/**
 * @typedef {Object} FuzzJob
 * @property {string} id
 * @property {string} contractAddress
 * @property {string} [chainForkUrl]
 * @property {string} [chainId]
 * @property {number} budgetSeconds
 * @property {"ityfuzz"|"mythril"|"auto"} tool
 * @property {"queued"|"running"|"done"|"failed"} status
 * @property {import('./runners/types').Finding[]} findings
 * @property {number} enqueuedAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {string} [error]
 * @property {string} [toolUsed]
 */

/**
 * @param {Omit<FuzzJob, "id"|"status"|"findings"|"enqueuedAt">} opts
 * @returns {string} jobId
 */
function enqueue(opts) {
  const id = randomUUID();
  /** @type {FuzzJob} */
  const job = {
    id,
    contractAddress: opts.contractAddress,
    chainForkUrl: opts.chainForkUrl,
    chainId: opts.chainId ?? "296",
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
  const { runItyFuzz } = require("./runners/ityfuzz");
  const { runMythril } = require("./runners/mythril");
  const { runManticore } = require("./runners/manticore");
  const { runHeimdall } = require("./runners/heimdall");

  job.status = "running";
  job.startedAt = Date.now();

  try {
    // In "auto" mode, run ALL available tools and merge findings.
    // When a specific tool is requested, run only that one.
    const allFindings = [];
    const toolsUsed = [];

    const TOOL_CHECKS = [
      {
        name: "ityfuzz",
        enabled: job.tool === "ityfuzz" || job.tool === "auto",
        available: async () =>
          (await isCommandAvailable("ityfuzz")) || (await isDockerImageAvailable("fuzzland/ityfuzz")),
        run: runItyFuzz,
      },
      {
        name: "mythril",
        enabled: job.tool === "mythril" || job.tool === "auto",
        available: async () =>
          (await isCommandAvailable("myth")) || (await isDockerImageAvailable("mythril/myth")),
        run: runMythril,
      },
      {
        name: "manticore",
        enabled: job.tool === "manticore" || job.tool === "auto",
        available: async () =>
          (await isCommandAvailable("manticore")) || (await isDockerImageAvailable("trailofbits/manticore")),
        run: runManticore,
      },
      {
        name: "heimdall",
        enabled: job.tool === "heimdall" || job.tool === "auto",
        available: async () =>
          (await isCommandAvailable("heimdall")) || (await isDockerImageAvailable("ghcr.io/jon-becker/heimdall-rs")),
        run: runHeimdall,
      },
    ];

    for (const tool of TOOL_CHECKS) {
      if (!tool.enabled) continue;
      let avail = false;
      try { avail = await tool.available(); } catch {}
      if (!avail) continue;

      console.log(`[fuzzer-service] Running ${tool.name} on ${job.contractAddress}`);
      try {
        const results = await tool.run(job);
        // Merge: skip duplicates by title
        for (const f of results) {
          if (!allFindings.some(e => e.title === f.title)) allFindings.push(f);
        }
        toolsUsed.push(tool.name);
        console.log(`[fuzzer-service] ${tool.name}: ${results.length} findings`);
      } catch (err) {
        console.error(`[fuzzer-service] ${tool.name} error: ${err.message}`);
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

async function isCommandAvailable(cmd) {
  const { execSync } = require("child_process");
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function isDockerImageAvailable(image) {
  const { execSync } = require("child_process");
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { enqueue, get };
