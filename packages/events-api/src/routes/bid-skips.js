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
  createdAt: row.created_at,
});

bidSkipsRouter.get("/bid-skips", (req, res) => {
  const limit = parseLimit(req.query.limit, 100, 1000);
  const reasonCode = req.query.reasonCode?.trim() || undefined;
  const agentId = req.query.agentId?.trim() || undefined;

  try {
    const db = getDb();
    const clauses = [];
    const params = [];

    if (reasonCode) {
      clauses.push("reason_code = ?");
      params.push(reasonCode);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }

    let sql = `
      SELECT id, event_id, job_id, agent_id, reason_code,
             reason, invite_budget, bid_amount, created_at
      FROM bid_skips
    `;

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    const bidSkips = rows.map(mapBidSkipRow);

    return res.json({ data: { bidSkips } });
  } catch (error) {
    return res
      .status(500)
      .json({ error: `Failed to load bid skips: ${String(error)}` });
  }
});
