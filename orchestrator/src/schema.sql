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

  -- File reference (markdown content stored in S3, NOT here)
  s3_key               TEXT        NOT NULL DEFAULT '', -- "reports/{jobId}.md"
                                                         -- empty string in local dev
  content_hash         TEXT        NOT NULL,          -- SHA3-256 hex digest of markdown
  cid                  TEXT        NOT NULL DEFAULT '', -- IPFS / 0g content identifier

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
