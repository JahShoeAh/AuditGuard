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
