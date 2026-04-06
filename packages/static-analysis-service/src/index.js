"use strict";

const express = require("express");
const { enqueue, get } = require("./queue");

const app = express();
app.use(express.json());

const PORT = Number(process.env.STATIC_ANALYSIS_SERVICE_PORT ?? 4002);

// ── Findings Store — PostgreSQL with in-memory fallback ───────────────────────
//
// When DATABASE_URL is set, findings survive process restarts (critical for
// multi-agent report aggregation). Without DATABASE_URL, falls back to an
// in-memory Map so local dev without Docker still works.

let pgPool = null;
let inMemoryStore = null; // Map<jobId, { agentId, findings, timestamp }[]>

const FINDINGS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS pending_findings (
  id        SERIAL      PRIMARY KEY,
  job_id    TEXT        NOT NULL,
  agent_id  TEXT        NOT NULL,
  findings  JSONB       NOT NULL DEFAULT '[]',
  stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_pf_job_id ON pending_findings (job_id);
`;

async function initFindingsStore() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    inMemoryStore = new Map();
    console.warn("[findings-store] DATABASE_URL not set; using in-memory fallback (data lost on restart)");
    return;
  }

  const { Pool } = require("pg");
  pgPool = new Pool({ connectionString: databaseUrl });
  await pgPool.query(FINDINGS_MIGRATION_SQL);
  console.log("[findings-store] PostgreSQL findings store initialised");
}

async function storeFinding(jobId, agentId, findings) {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO pending_findings (job_id, agent_id, findings, stored_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (job_id, agent_id)
       DO UPDATE SET findings = $3::jsonb, stored_at = NOW()`,
      [jobId, agentId, JSON.stringify(findings)],
    );
  } else {
    if (!inMemoryStore.has(jobId)) inMemoryStore.set(jobId, []);
    const entries = inMemoryStore.get(jobId);
    const idx = entries.findIndex((e) => e.agentId === agentId);
    const entry = { agentId, findings, timestamp: Date.now() };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  }
}

async function getFindingsForJob(jobId) {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT agent_id, findings, EXTRACT(EPOCH FROM stored_at) * 1000 AS timestamp
       FROM pending_findings
       WHERE job_id = $1`,
      [jobId],
    );
    return rows.map((r) => ({
      agentId: r.agent_id,
      findings: Array.isArray(r.findings) ? r.findings : [],
      timestamp: Number(r.timestamp),
    }));
  }
  return inMemoryStore.get(jobId) ?? [];
}

async function deleteFindingsForJob(jobId) {
  if (pgPool) {
    await pgPool.query("DELETE FROM pending_findings WHERE job_id = $1", [jobId]);
  } else {
    inMemoryStore.delete(jobId);
  }
}

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
// POST /findings
// Body: { jobId: string, agentId: string, findings: Finding[] }
// Idempotent: re-posting for the same agentId replaces the previous entry.
app.post("/findings", async (req, res) => {
  const { jobId, agentId, findings } = req.body ?? {};
  if (!jobId || !agentId || !Array.isArray(findings)) {
    return res.status(400).json({ error: "jobId, agentId, and findings[] are required" });
  }
  try {
    await storeFinding(jobId, agentId, findings);
    console.log(`[findings-store] Stored ${findings.length} findings for job ${jobId} from ${agentId}`);
    res.json({ ok: true, stored: findings.length });
  } catch (err) {
    console.error(`[findings-store] Failed to store findings: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

// GET /findings/:jobId
// Returns all agent entries for the given job.
// Response: { jobId, agents: [{ agentId, findings, timestamp }] }
app.get("/findings/:jobId", async (req, res) => {
  try {
    const agents = await getFindingsForJob(req.params.jobId);
    res.json({ jobId: req.params.jobId, agents });
  } catch (err) {
    console.error(`[findings-store] Failed to get findings: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /findings/:jobId
// Called by report agent after publishing to free memory / DB rows.
app.delete("/findings/:jobId", async (req, res) => {
  try {
    await deleteFindingsForJob(req.params.jobId);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[findings-store] Failed to delete findings: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

initFindingsStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[static-analysis-service] Listening on port ${PORT}`);
      console.log(`[static-analysis-service] Tools tried in order: slither → aderyn → semgrep`);
      console.log(`[static-analysis-service] Note: all tools require sourceDir to be set`);
      console.log(`[static-analysis-service] Without sourceDir, agent falls back to mock findings`);
    });
  })
  .catch((err) => {
    console.error(`[static-analysis-service] Failed to initialise findings store: ${err}`);
    process.exit(1);
  });
