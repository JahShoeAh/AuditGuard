import { Router } from "express";
import { getDb } from "../db.js";
import { parseLimit } from "../validation.js";

export const bidSkipsRouter = Router();

const mapBidSkipRow = (row) => ({
  id: row.id,
  eventId: row.event_id,
  jobId: row.job_id,
  agentId: row.agent_id,
  reasonCode: row.reason_code,
  reason: row.reason,
  inviteBudget: row.invite_budget,
  bidAmount: row.bid_amount,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

bidSkipsRouter.get("/bid-skips", async (req, res) => {
  const limit = parseLimit(req.query.limit, 100, 1000);
  const reasonCode = req.query.reasonCode?.trim() || undefined;
  const agentId = req.query.agentId?.trim() || undefined;

  try {
    const db = getDb();
    const rows = await db.queryBidSkips({ reasonCode, agentId, limit });
    const bidSkips = rows.map(mapBidSkipRow);

    return res.json({ data: { bidSkips } });
  } catch (error) {
    return res
      .status(500)
      .json({ error: `Failed to load bid skips: ${String(error)}` });
  }
});
