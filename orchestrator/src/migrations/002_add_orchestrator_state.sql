-- Migration 002: Add orchestrator state table
-- Stores orchestrator roster and event cache for recovery across restarts

CREATE TABLE IF NOT EXISTS orchestrator_state (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
