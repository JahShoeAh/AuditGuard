import { execute, queryAll, queryFirst } from "../d1";
import type {
  BidSkipExtract,
  EventIngestRequest,
  StoredAuditEvent,
  StoredBidSkip,
} from "../../types/events";
import type { D1Database } from "../../types/runtime";

type AuditEventRow = {
  id: string;
  source: string;
  topic_id: string;
  message_type: string;
  agent_id: string;
  message_timestamp: number;
  payload_json: string;
  raw_json: string;
  received_at: string;
};

type BidSkipRow = {
  id: string;
  event_id: string;
  job_id: number | null;
  agent_id: string;
  reason_code: string | null;
  reason: string | null;
  invite_budget: number | null;
  bid_amount: number | null;
  created_at: string;
};

export type EventQueryFilter = {
  messageType?: string;
  agentId?: string;
  topicId?: string;
  limit: number;
};

export type BidSkipQueryFilter = {
  reasonCode?: string;
  agentId?: string;
  limit: number;
};

const safeParseRecord = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const safeParseMessage = (value: string): EventIngestRequest["message"] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "unknown";
      const agentId = typeof record.agentId === "string" ? record.agentId : "unknown";
      const timestamp =
        typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
          ? record.timestamp
          : 0;
      const payload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : {};

      return { type, agentId, timestamp, payload };
    }
  } catch {
    // swallow parse failures
  }

  return {
    type: "unknown",
    agentId: "unknown",
    timestamp: 0,
    payload: {},
  };
};

const mapAuditEventRow = (row: AuditEventRow): StoredAuditEvent => {
  return {
    id: row.id,
    source: row.source,
    topicId: row.topic_id,
    messageType: row.message_type,
    agentId: row.agent_id,
    messageTimestamp: row.message_timestamp,
    payload: safeParseRecord(row.payload_json),
    rawMessage: safeParseMessage(row.raw_json),
    receivedAt: row.received_at,
  };
};

const mapBidSkipRow = (row: BidSkipRow): StoredBidSkip => {
  return {
    id: row.id,
    eventId: row.event_id,
    jobId: row.job_id,
    agentId: row.agent_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    inviteBudget: row.invite_budget,
    bidAmount: row.bid_amount,
    createdAt: row.created_at,
  };
};

export const insertAuditEvent = async (
  db: D1Database,
  input: EventIngestRequest,
): Promise<string> => {
  const eventId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const result = await execute(
    db,
    `INSERT INTO audit_events (
      id,
      source,
      topic_id,
      message_type,
      agent_id,
      message_timestamp,
      payload_json,
      raw_json,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      input.source,
      input.topicId,
      input.message.type,
      input.message.agentId,
      input.message.timestamp,
      JSON.stringify(input.message.payload),
      JSON.stringify(input.message),
      nowIso,
    ],
  );

  if (!result.success) {
    throw new Error(result.error ?? "Failed to insert audit event");
  }

  return eventId;
};

export const insertBidSkip = async (
  db: D1Database,
  eventId: string,
  input: BidSkipExtract,
): Promise<string> => {
  const rowId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const result = await execute(
    db,
    `INSERT INTO bid_skips (
      id,
      event_id,
      job_id,
      agent_id,
      reason_code,
      reason,
      invite_budget,
      bid_amount,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rowId,
      eventId,
      input.jobId,
      input.agentId,
      input.reasonCode,
      input.reason,
      input.inviteBudget,
      input.bidAmount,
      nowIso,
    ],
  );

  if (!result.success) {
    throw new Error(result.error ?? "Failed to insert bid skip");
  }

  return rowId;
};

export const listEvents = async (
  db: D1Database,
  filter: EventQueryFilter,
): Promise<StoredAuditEvent[]> => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.messageType) {
    clauses.push("message_type = ?");
    params.push(filter.messageType);
  }
  if (filter.agentId) {
    clauses.push("agent_id = ?");
    params.push(filter.agentId);
  }
  if (filter.topicId) {
    clauses.push("topic_id = ?");
    params.push(filter.topicId);
  }

  let sql = `
    SELECT
      id,
      source,
      topic_id,
      message_type,
      agent_id,
      message_timestamp,
      payload_json,
      raw_json,
      received_at
    FROM audit_events
  `;

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  sql += " ORDER BY received_at DESC LIMIT ?";
  params.push(filter.limit);

  const rows = await queryAll<AuditEventRow>(db, sql, params);
  return rows.map(mapAuditEventRow);
};

export const listBidSkips = async (
  db: D1Database,
  filter: BidSkipQueryFilter,
): Promise<StoredBidSkip[]> => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.reasonCode) {
    clauses.push("reason_code = ?");
    params.push(filter.reasonCode);
  }
  if (filter.agentId) {
    clauses.push("agent_id = ?");
    params.push(filter.agentId);
  }

  let sql = `
    SELECT
      id,
      event_id,
      job_id,
      agent_id,
      reason_code,
      reason,
      invite_budget,
      bid_amount,
      created_at
    FROM bid_skips
  `;

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(filter.limit);

  const rows = await queryAll<BidSkipRow>(db, sql, params);
  return rows.map(mapBidSkipRow);
};

export const checkDbHealth = async (db: D1Database): Promise<boolean> => {
  const row = await queryFirst<{ ok: number }>(db, "SELECT 1 AS ok");
  return row?.ok === 1;
};
