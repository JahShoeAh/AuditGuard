-- Migration 003: Add performance indexes
-- Indexes for common query patterns across all tables

-- Audit reports indexes
CREATE INDEX IF NOT EXISTS idx_ar_deployer_address ON audit_reports (deployer_address);
CREATE INDEX IF NOT EXISTS idx_ar_contract_address ON audit_reports (contract_address);
CREATE INDEX IF NOT EXISTS idx_ar_job_id ON audit_reports (job_id);
CREATE INDEX IF NOT EXISTS idx_ar_timestamp ON audit_reports (timestamp DESC);

-- Audit events indexes
CREATE INDEX IF NOT EXISTS idx_ae_received_at ON audit_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_message_type ON audit_events (message_type);
CREATE INDEX IF NOT EXISTS idx_ae_agent_id ON audit_events (agent_id);

-- Bid skips indexes
CREATE INDEX IF NOT EXISTS idx_bs_created_at ON bid_skips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bs_reason_code ON bid_skips (reason_code);
CREATE INDEX IF NOT EXISTS idx_bs_agent_id ON bid_skips (agent_id);

-- Pending findings indexes
CREATE INDEX IF NOT EXISTS idx_pf_job_id ON pending_findings (job_id);

-- Audit jobs indexes
CREATE INDEX IF NOT EXISTS idx_aj_status ON audit_jobs (status);
CREATE INDEX IF NOT EXISTS idx_aj_contract_address ON audit_jobs (contract_address);
CREATE INDEX IF NOT EXISTS idx_aj_updated_at ON audit_jobs (updated_at DESC);

-- Registered agents indexes
CREATE INDEX IF NOT EXISTS idx_ra_status ON registered_agents (status);
CREATE INDEX IF NOT EXISTS idx_ra_agent_id ON registered_agents (agent_id);

-- Audit schedules indexes
CREATE INDEX IF NOT EXISTS idx_as_active ON audit_schedules (active);

-- Audit vaults indexes
CREATE INDEX IF NOT EXISTS idx_av_vault_address ON audit_vaults (vault_address);

-- Orchestrator state indexes
CREATE INDEX IF NOT EXISTS idx_orchestrator_state_updated ON orchestrator_state(updated_at DESC);
