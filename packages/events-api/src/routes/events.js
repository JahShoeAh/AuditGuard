import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  parseEventIngestRequest,
  parseBidSkipPayload,
  parseLimit,
} from "../validation.js";

export const eventsRouter = Router();

// ── helpers ──────────────────────────────────────────────────────────

const safeParseRecord = (value) => {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return {};
  } catch {
    return {};
  }
};

const safeParseMessage = (value) => {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        type: typeof parsed.type === "string" ? parsed.type : "unknown",
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : "unknown",
        timestamp:
          typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
            ? parsed.timestamp
            : 0,
        payload:
          typeof parsed.payload === "object" && parsed.payload !== null
            ? parsed.payload
            : {},
      };
    }
  } catch {
    // swallow
  }
  return { type: "unknown", agentId: "unknown", timestamp: 0, payload: {} };
};

const mapAuditEventRow = (row) => ({
  id: row.id,
  source: row.source,
  topicId: row.topic_id,
  messageType: row.message_type,
  agentId: row.agent_id,
  messageTimestamp: row.message_timestamp,
  payload: safeParseRecord(row.payload_json),
  rawMessage: safeParseMessage(row.raw_json),
  receivedAt: row.received_at,
});

// ── POST /api/events ─────────────────────────────────────────────────

eventsRouter.post("/events", requireAuth, (req, res) => {
  const parsed = parseEventIngestRequest(req.body);
  if (!parsed) {
    return res.status(400).json({
      error:
        "Invalid payload. Expected { source, topicId, message: { type, agentId, timestamp, payload } }.",
    });
  }

  try {
    const db = getDb();
    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO audit_events (
        id, source, topic_id, message_type, agent_id,
        message_timestamp, payload_json, raw_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      parsed.source,
      parsed.topicId,
      parsed.message.type,
      parsed.message.agentId,
      parsed.message.timestamp,
      JSON.stringify(parsed.message.payload),
      JSON.stringify(parsed.message),
      nowIso,
    );

    let bidSkipId = null;

    if (parsed.message.type === "BID_SKIPPED") {
      const bidSkip = parseBidSkipPayload(
        parsed.message.payload,
        parsed.message.agentId,
      );
      bidSkipId = crypto.randomUUID();
      const skipNow = new Date().toISOString();

      db.prepare(
        `INSERT INTO bid_skips (
          id, event_id, job_id, agent_id, reason_code,
          reason, invite_budget, bid_amount, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bidSkipId,
        eventId,
        bidSkip.jobId,
        bidSkip.agentId,
        bidSkip.reasonCode,
        bidSkip.reason,
        bidSkip.inviteBudget,
        bidSkip.bidAmount,
        skipNow,
      );
    }

    return res.status(201).json({ data: { eventId, bidSkipId } });
  } catch (error) {
    return res
      .status(500)
      .json({ error: `Failed to persist event: ${String(error)}` });
  }
});

// ── GET /api/events ──────────────────────────────────────────────────

eventsRouter.get("/events", (req, res) => {
  const limit = parseLimit(req.query.limit, 100, 1000);
  const messageType = req.query.type?.trim() || undefined;
  const agentId = req.query.agentId?.trim() || undefined;
  const topicId = req.query.topicId?.trim() || undefined;

  try {
    const db = getDb();
    const clauses = [];
    const params = [];

    if (messageType) {
      clauses.push("message_type = ?");
      params.push(messageType);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }
    if (topicId) {
      clauses.push("topic_id = ?");
      params.push(topicId);
    }

    let sql = `
      SELECT id, source, topic_id, message_type, agent_id,
             message_timestamp, payload_json, raw_json, received_at
      FROM audit_events
    `;

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    sql += " ORDER BY received_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    const events = rows.map(mapAuditEventRow);

    return res.json({ data: { events } });
  } catch (error) {
    return res
      .status(500)
      .json({ error: `Failed to load events: ${String(error)}` });
  }
});
