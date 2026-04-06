-- orchestrator/src/schema.sql
--
-- PRE-BRANCH SHARED ARTIFACT — run once before any task branch is opened.
--
-- Creates the PostgreSQL table and indexes that all four task branches depend on.
-- Run with:
--   psql "$DATABASE_URL" -f orchestrator/src/schema.sql
--
-- DATABASE_URL examples:
--   Local dev:   postgresql://postgres:postgres@localhost:5432/auditguard
--   Production:  postgresql://user:pass@rds-host:5432/auditguard  (set in ECS env)
--
-- Idempotent: safe to run more than once (uses IF NOT EXISTS).
--
-- SCHEMA FREEZE: once all four branches are open, changes to this file
-- require a comment on every open branch PR before merging.

CREATE TABLE IF NOT EXISTS audit_reports (
  -- Primary key
  id                   TEXT        NOT NULL,

  -- Job / contract identifiers
  job_id               TEXT        NOT NULL,
  contract_address     TEXT        NOT NULL,
  deployer_address     TEXT        NOT NULL,
  hedera_account_id    TEXT,                          -- null when unavailable
  chain                TEXT        NOT NULL,          -- e.g. "hedera-testnet"
  contract_type        TEXT        NOT NULL,          -- "lending"|"dex"|"staking"|...

  -- Report content stored inline in the DB (same schema for local dev and production)
  content_hash         TEXT        NOT NULL,          -- SHA3-256 hex digest of markdown
  md_content           TEXT        NOT NULL DEFAULT '', -- full markdown text
  -- Legacy columns kept for backward compatibility with existing rows
  s3_key               TEXT        NOT NULL DEFAULT '',
  cid                  TEXT        NOT NULL DEFAULT '',

  -- Agent metadata
  agent_addresses      TEXT[]      NOT NULL DEFAULT '{}',
  agent_count          INTEGER     NOT NULL DEFAULT 0,
  finding_count        INTEGER     NOT NULL DEFAULT 0,
  findings_by_severity JSONB       NOT NULL DEFAULT '{"critical":0,"high":0,"medium":0,"low":0,"info":0}',

  -- Metadata
  timestamp            BIGINT      NOT NULL,          -- Unix ms when record was written
  tags                 TEXT[]      NOT NULL DEFAULT '{}',
  source               TEXT        NOT NULL DEFAULT 'orchestrator', -- 'orchestrator'|'agent'|'manual'

  -- Housekeeping
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id)
);

-- Indexes for the access patterns described in report-types.js
CREATE INDEX IF NOT EXISTS idx_ar_deployer_address  ON audit_reports (deployer_address);
CREATE INDEX IF NOT EXISTS idx_ar_contract_address  ON audit_reports (contract_address);
CREATE INDEX IF NOT EXISTS idx_ar_job_id            ON audit_reports (job_id);
CREATE INDEX IF NOT EXISTS idx_ar_timestamp         ON audit_reports (timestamp DESC);

-- ── events-api: HCS event log ────────────────────────────────────────────────
-- Replaces the SQLite audit_events table from packages/events-api/src/db.js

CREATE TABLE IF NOT EXISTS audit_events (
  id                TEXT        PRIMARY KEY,
  source            TEXT        NOT NULL,
  topic_id          TEXT        NOT NULL,
  message_type      TEXT        NOT NULL,
  agent_id          TEXT        NOT NULL,
  message_timestamp BIGINT      NOT NULL,
  payload_json      TEXT        NOT NULL,
  raw_json          TEXT        NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ae_received_at   ON audit_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_message_type  ON audit_events (message_type);
CREATE INDEX IF NOT EXISTS idx_ae_agent_id      ON audit_events (agent_id);

-- ── events-api: bid skip log ─────────────────────────────────────────────────
-- Replaces the SQLite bid_skips table from packages/events-api/src/db.js

CREATE TABLE IF NOT EXISTS bid_skips (
  id            TEXT        PRIMARY KEY,
  event_id      TEXT        NOT NULL REFERENCES audit_events(id),
  job_id        INTEGER,
  agent_id      TEXT        NOT NULL,
  reason_code   TEXT,
  reason        TEXT,
  invite_budget REAL,
  bid_amount    REAL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bs_created_at  ON bid_skips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bs_reason_code ON bid_skips (reason_code);
CREATE INDEX IF NOT EXISTS idx_bs_agent_id    ON bid_skips (agent_id);

-- ── static-analysis-service: findings store ──────────────────────────────────
-- Replaces the in-memory findingsStore Map in packages/static-analysis-service/src/index.js

CREATE TABLE IF NOT EXISTS pending_findings (
  id         SERIAL      PRIMARY KEY,
  job_id     TEXT        NOT NULL,
  agent_id   TEXT        NOT NULL,
  findings   JSONB       NOT NULL DEFAULT '[]',
  stored_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_pf_job_id ON pending_findings (job_id);

-- ── events-api: audit job lifecycle cache ────────────────────────────────────
-- Mirrors on-chain AuditAuction job state for fast dashboard queries without
-- RPC round-trips.  Hedera contracts are the source of truth; this is a cache.

CREATE TABLE IF NOT EXISTS audit_jobs (
  job_id           TEXT        PRIMARY KEY,          -- chain job ID (string of uint256)
  contract_address TEXT        NOT NULL,
  deployer_address TEXT        NOT NULL DEFAULT '',
  contract_type    TEXT        NOT NULL DEFAULT 'unknown',
  status           TEXT        NOT NULL DEFAULT 'open',  -- open|bidding|in_progress|settled|cancelled
  budget_guard     REAL        NOT NULL DEFAULT 0,
  winner_addresses TEXT[]      NOT NULL DEFAULT '{}',
  finding_count    INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aj_status          ON audit_jobs (status);
CREATE INDEX IF NOT EXISTS idx_aj_contract_address ON audit_jobs (contract_address);
CREATE INDEX IF NOT EXISTS idx_aj_updated_at      ON audit_jobs (updated_at DESC);

-- ── events-api: registered agents cache ──────────────────────────────────────
-- Mirrors AgentRegistry on-chain state for dashboard agent roster.

CREATE TABLE IF NOT EXISTS registered_agents (
  evm_address      TEXT        PRIMARY KEY,
  agent_id         TEXT        NOT NULL DEFAULT '',
  specializations  TEXT[]      NOT NULL DEFAULT '{}',
  reputation       INTEGER     NOT NULL DEFAULT 0,
  tier             TEXT        NOT NULL DEFAULT 'standard',
  status           TEXT        NOT NULL DEFAULT 'active',  -- active|inactive|slashed
  stake_guard      REAL        NOT NULL DEFAULT 0,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ra_status    ON registered_agents (status);
CREATE INDEX IF NOT EXISTS idx_ra_agent_id  ON registered_agents (agent_id);

-- ── events-api: AuditScheduler schedule cache ────────────────────────────────
-- Mirrors AuditScheduler on-chain state. Source of truth is the contract.

CREATE TABLE IF NOT EXISTS audit_schedules (
  contract_address  TEXT        PRIMARY KEY,
  owner_address     TEXT        NOT NULL DEFAULT '',
  schedule_address  TEXT        NOT NULL DEFAULT '',
  next_audit_due    BIGINT      NOT NULL DEFAULT 0,
  mode              INTEGER     NOT NULL DEFAULT 0,   -- 0=TIME_BASED, 1=REDEPLOY
  interval_seconds  BIGINT      NOT NULL DEFAULT 0,
  times_triggered   INTEGER     NOT NULL DEFAULT 0,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_as_active ON audit_schedules (active);

-- ── events-api: VaultFactory vault registry cache ────────────────────────────
-- Mirrors VaultFactory on-chain vault registry.

CREATE TABLE IF NOT EXISTS audit_vaults (
  contract_address  TEXT        PRIMARY KEY,
  vault_address     TEXT        NOT NULL,
  creator           TEXT        NOT NULL DEFAULT '',
  contract_chain    TEXT        NOT NULL DEFAULT 'hedera-testnet',
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_av_vault_address ON audit_vaults (vault_address);
