import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export const jobsRouter = Router();

// ── helpers ──────────────────────────────────────────────────────────

function parseLimit(raw, defaultVal = 100, max = 500) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(n, max);
}

const mapJobRow = (row) => ({
  jobId: row.job_id,
  contractAddress: row.contract_address,
  deployerAddress: row.deployer_address,
  contractType: row.contract_type,
  status: row.status,
  budgetGuard: row.budget_guard,
  winnerAddresses: row.winner_addresses ?? [],
  findingCount: row.finding_count,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

const mapAgentRow = (row) => ({
  evmAddress: row.evm_address,
  agentId: row.agent_id,
  specializations: row.specializations ?? [],
  reputation: row.reputation,
  tier: row.tier,
  status: row.status,
  stakeGuard: row.stake_guard,
  lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  registeredAt: row.registered_at instanceof Date ? row.registered_at.toISOString() : row.registered_at,
});

// ── GET /api/jobs ──────────────────────────────────────────────────────

jobsRouter.get("/jobs", async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const status = req.query.status?.trim() || undefined;
  const contractAddress = req.query.contractAddress?.trim() || undefined;

  try {
    const db = getDb();
    const rows = await db.queryJobs({ status, contractAddress, limit });
    return res.json({ data: { jobs: rows.map(mapJobRow) } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load jobs: ${String(error)}` });
  }
});

// ── GET /api/jobs/:jobId ───────────────────────────────────────────────

jobsRouter.get("/jobs/:jobId", async (req, res) => {
  try {
    const db = getDb();
    const row = await db.getJobById(req.params.jobId);
    if (!row) {
      return res.status(404).json({ error: "Job not found" });
    }
    return res.json({ data: { job: mapJobRow(row) } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load job: ${String(error)}` });
  }
});

// ── POST /api/jobs — upsert job state ─────────────────────────────────
// Called by the orchestrator when job lifecycle events occur.

jobsRouter.post("/jobs", requireAuth, async (req, res) => {
  const { jobId, contractAddress, deployerAddress, contractType, status, budgetGuard, winnerAddresses, findingCount } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({ error: "jobId (string) is required" });
  }
  if (!contractAddress || typeof contractAddress !== "string") {
    return res.status(400).json({ error: "contractAddress (string) is required" });
  }

  try {
    const db = getDb();
    await db.upsertJob({ jobId, contractAddress, deployerAddress, contractType, status, budgetGuard, winnerAddresses, findingCount });
    return res.status(201).json({ data: { jobId } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to upsert job: ${String(error)}` });
  }
});

// ── GET /api/agents ────────────────────────────────────────────────────

jobsRouter.get("/agents", async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const status = req.query.status?.trim() || undefined;

  try {
    const db = getDb();
    const rows = await db.queryAgents({ status, limit });
    return res.json({ data: { agents: rows.map(mapAgentRow) } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load agents: ${String(error)}` });
  }
});

// ── POST /api/agents — upsert agent state ─────────────────────────────
// Called by the orchestrator when AGENT_REGISTERED events arrive on HCS.

jobsRouter.post("/agents", requireAuth, async (req, res) => {
  const { evmAddress, agentId, specializations, reputation, tier, status, stakeGuard } = req.body ?? {};

  if (!evmAddress || typeof evmAddress !== "string") {
    return res.status(400).json({ error: "evmAddress (string) is required" });
  }

  try {
    const db = getDb();
    await db.upsertAgent({ evmAddress, agentId, specializations, reputation, tier, status, stakeGuard });
    return res.status(201).json({ data: { evmAddress: evmAddress.toLowerCase() } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to upsert agent: ${String(error)}` });
  }
});
