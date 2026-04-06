import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export const schedulesRouter = Router();

function parseLimit(raw, defaultVal = 100, max = 500) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(n, max);
}

const mapScheduleRow = (row) => ({
  contractAddress: row.contract_address,
  ownerAddress: row.owner_address,
  scheduleAddress: row.schedule_address,
  nextAuditDue: Number(row.next_audit_due),
  mode: Number(row.mode),          // 0=TIME_BASED, 1=REDEPLOY
  intervalSeconds: Number(row.interval_seconds),
  timesTriggered: Number(row.times_triggered),
  active: row.active,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

// ── GET /api/schedules ─────────────────────────────────────────────────

schedulesRouter.get("/schedules", async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const activeRaw = req.query.active;
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;

  try {
    const db = getDb();
    const rows = await db.querySchedules({ active, limit });
    return res.json({ data: { schedules: rows.map(mapScheduleRow) } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load schedules: ${String(error)}` });
  }
});

// ── POST /api/schedules — upsert schedule state ────────────────────────
// Called by the orchestrator when AuditScheduled / AuditTriggered events arrive.

schedulesRouter.post("/schedules", requireAuth, async (req, res) => {
  const {
    contractAddress, ownerAddress, scheduleAddress,
    nextAuditDue, mode, intervalSeconds, timesTriggered, active,
  } = req.body ?? {};

  if (!contractAddress || typeof contractAddress !== "string") {
    return res.status(400).json({ error: "contractAddress (string) is required" });
  }

  try {
    const db = getDb();
    await db.upsertSchedule({
      contractAddress, ownerAddress, scheduleAddress,
      nextAuditDue, mode, intervalSeconds, timesTriggered, active,
    });
    return res.status(201).json({ data: { contractAddress: contractAddress.toLowerCase() } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to upsert schedule: ${String(error)}` });
  }
});
