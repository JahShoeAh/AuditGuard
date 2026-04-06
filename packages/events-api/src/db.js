import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const DB_PATH = process.env.EVENTS_DB_PATH || "data/events.db";
const require = createRequire(import.meta.url);

let db;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_received_at
  ON audit_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_message_type
  ON audit_events(message_type);

CREATE INDEX IF NOT EXISTS idx_audit_events_agent_id
  ON audit_events(agent_id);

CREATE TABLE IF NOT EXISTS bid_skips (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  job_id INTEGER,
  agent_id TEXT NOT NULL,
  reason_code TEXT,
  reason TEXT,
  invite_budget REAL,
  bid_amount REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES audit_events(id)
);

CREATE INDEX IF NOT EXISTS idx_bid_skips_created_at
  ON bid_skips(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bid_skips_reason_code
  ON bid_skips(reason_code);

CREATE INDEX IF NOT EXISTS idx_bid_skips_agent_id
  ON bid_skips(agent_id);
`;

function normalizeSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toFiniteLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

class InMemoryStatement {
  constructor(store, sql) {
    this.store = store;
    this.sql = sql;
    this.normalizedSql = normalizeSql(sql);
  }

  run(...params) {
    if (this.normalizedSql.startsWith("insert into audit_events")) {
      const [
        id,
        source,
        topic_id,
        message_type,
        agent_id,
        message_timestamp,
        payload_json,
        raw_json,
        received_at,
      ] = params;
      this.store.auditEvents.push({
        id,
        source,
        topic_id,
        message_type,
        agent_id,
        message_timestamp,
        payload_json,
        raw_json,
        received_at,
      });
      return { changes: 1 };
    }

    if (this.normalizedSql.startsWith("insert into bid_skips")) {
      const [
        id,
        event_id,
        job_id,
        agent_id,
        reason_code,
        reason,
        invite_budget,
        bid_amount,
        created_at,
      ] = params;
      this.store.bidSkips.push({
        id,
        event_id,
        job_id,
        agent_id,
        reason_code,
        reason,
        invite_budget,
        bid_amount,
        created_at,
      });
      return { changes: 1 };
    }

    throw new Error(`In-memory DB cannot run statement: ${this.sql}`);
  }

  all(...params) {
    if (this.normalizedSql.includes("from audit_events")) {
      const hasMessageType = this.normalizedSql.includes("message_type = ?");
      const hasAgentId = this.normalizedSql.includes("agent_id = ?");
      const hasTopicId = this.normalizedSql.includes("topic_id = ?");

      let paramIndex = 0;
      const expectedMessageType = hasMessageType ? params[paramIndex++] : undefined;
      const expectedAgentId = hasAgentId ? params[paramIndex++] : undefined;
      const expectedTopicId = hasTopicId ? params[paramIndex++] : undefined;
      const limit = toFiniteLimit(params[paramIndex], 100);

      return this.store.auditEvents
        .filter((row) => (hasMessageType ? row.message_type === expectedMessageType : true))
        .filter((row) => (hasAgentId ? row.agent_id === expectedAgentId : true))
        .filter((row) => (hasTopicId ? row.topic_id === expectedTopicId : true))
        .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
        .slice(0, limit);
    }

    if (this.normalizedSql.includes("from bid_skips")) {
      const hasReasonCode = this.normalizedSql.includes("reason_code = ?");
      const hasAgentId = this.normalizedSql.includes("agent_id = ?");

      let paramIndex = 0;
      const expectedReasonCode = hasReasonCode ? params[paramIndex++] : undefined;
      const expectedAgentId = hasAgentId ? params[paramIndex++] : undefined;
      const limit = toFiniteLimit(params[paramIndex], 100);

      return this.store.bidSkips
        .filter((row) => (hasReasonCode ? row.reason_code === expectedReasonCode : true))
        .filter((row) => (hasAgentId ? row.agent_id === expectedAgentId : true))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    throw new Error(`In-memory DB cannot query statement: ${this.sql}`);
  }

  get() {
    if (this.normalizedSql === "select 1 as ok") {
      return { ok: 1 };
    }
    const rows = this.all();
    return rows[0];
  }
}

class InMemoryDb {
  constructor() {
    this.auditEvents = [];
    this.bidSkips = [];
  }

  pragma() {}

  exec() {}

  prepare(sql) {
    return new InMemoryStatement(this, sql);
  }
}

function loadSqliteConstructor() {
  try {
    return require("better-sqlite3");
  } catch {
    return null;
  }
}

export function initDb() {
  if (db) return db;

  const Sqlite = loadSqliteConstructor();
  if (!Sqlite) {
    const requireSqlite = (process.env.EVENTS_API_REQUIRE_SQLITE ?? "false") === "true";
    if (requireSqlite) {
      throw new Error(
        "better-sqlite3 is required but not installed. Install dependencies or unset EVENTS_API_REQUIRE_SQLITE."
      );
    }
    db = new InMemoryDb();
    console.warn("[events-api] better-sqlite3 not found; using in-memory event store fallback");
    return db;
  }

  const dir = dirname(DB_PATH);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  db = new Sqlite(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(MIGRATION_SQL);
  console.log(`[events-api] SQLite database initialised at ${DB_PATH}`);
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error("Database not initialised. Call initDb() first.");
  }
  return db;
}
