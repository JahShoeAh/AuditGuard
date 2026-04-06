"use strict";

const express = require("express");
const { enqueue, get } = require("./queue");

const app = express();
app.use(express.json());

const PORT = Number(process.env.STATIC_ANALYSIS_SERVICE_PORT ?? 4002);

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ── Submit a static analysis job ──────────────────────────────────────────────
//
// POST /analyze
// Body: {
//   contractAddress: string,     // EVM address of deployed contract
//   sourceDir?: string,          // path to Solidity source (enables Slither + Aderyn + Semgrep)
//   chainForkUrl?: string,       // JSON-RPC URL (used for context, not analysis)
//   budgetSeconds?: number,      // time limit, defaults to 120
//   tool?: "slither"|"aderyn"|"semgrep"|"auto"  // defaults to "auto"
// }
// Response: { jobId: string, status: "queued" }

app.post("/analyze", (req, res) => {
  const { contractAddress, sourceDir, chainForkUrl, budgetSeconds, tool } = req.body ?? {};

  if (!contractAddress || typeof contractAddress !== "string") {
    return res.status(400).json({ error: "contractAddress is required" });
  }

  const jobId = enqueue({
    contractAddress,
    sourceDir: sourceDir ?? null,
    chainForkUrl: chainForkUrl ?? process.env.HEDERA_JSON_RPC_URL,
    budgetSeconds: Number(budgetSeconds ?? 120),
    tool: tool ?? "auto",
  });

  console.log(
    `[static-analysis-service] Job ${jobId} queued for ${contractAddress} ` +
    `(sourceDir: ${sourceDir ?? "none"}, budget: ${budgetSeconds ?? 120}s)`
  );
  res.json({ jobId, status: "queued" });
});

// ── Poll for results ──────────────────────────────────────────────────────────
//
// GET /results/:jobId
// Response: {
//   jobId: string,
//   status: "queued"|"running"|"done"|"failed",
//   findings: Finding[],
//   toolUsed?: string,
//   elapsed?: number,
//   error?: string
// }

app.get("/results/:jobId", (req, res) => {
  const job = get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }

  const elapsed = job.finishedAt
    ? job.finishedAt - (job.startedAt ?? job.enqueuedAt)
    : Date.now() - job.enqueuedAt;

  res.json({
    jobId: job.id,
    status: job.status,
    findings: job.findings,
    toolUsed: job.toolUsed ?? null,
    elapsed: Math.round(elapsed / 1000),
    error: job.error ?? null,
  });
});

// ── Findings Store ────────────────────────────────────────────────────────────
//
// Agents POST their findings here after completing analysis.
// The report agent GETs all findings for a job when aggregating.
// This bridges the gap between per-process agents that can't share memory.
//
// Store shape: Map<jobId, { agentId, findings, timestamp }[]>

const findingsStore = new Map();

// POST /findings
// Body: { jobId: string, agentId: string, findings: Finding[] }
// Idempotent: re-posting for the same agentId replaces the previous entry.
app.post("/findings", (req, res) => {
  const { jobId, agentId, findings } = req.body ?? {};
  if (!jobId || !agentId || !Array.isArray(findings)) {
    return res.status(400).json({ error: "jobId, agentId, and findings[] are required" });
  }
  if (!findingsStore.has(jobId)) findingsStore.set(jobId, []);
  const entries = findingsStore.get(jobId);
  const idx = entries.findIndex(e => e.agentId === agentId);
  const entry = { agentId, findings, timestamp: Date.now() };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  console.log(`[findings-store] Stored ${findings.length} findings for job ${jobId} from ${agentId}`);
  res.json({ ok: true, stored: findings.length });
});

// GET /findings/:jobId
// Returns all agent entries for the given job.
// Response: { jobId, agents: [{ agentId, findings, timestamp }] }
app.get("/findings/:jobId", (req, res) => {
  const entries = findingsStore.get(req.params.jobId) ?? [];
  res.json({ jobId: req.params.jobId, agents: entries });
});

// DELETE /findings/:jobId
// Called by report agent after publishing to free memory.
app.delete("/findings/:jobId", (req, res) => {
  findingsStore.delete(req.params.jobId);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[static-analysis-service] Listening on port ${PORT}`);
  console.log(`[static-analysis-service] Tools tried in order: slither → aderyn → semgrep`);
  console.log(`[static-analysis-service] Note: all tools require sourceDir to be set`);
  console.log(`[static-analysis-service] Without sourceDir, agent falls back to mock findings`);
});
