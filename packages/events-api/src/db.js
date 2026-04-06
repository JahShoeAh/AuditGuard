import pg from "pg";

const { Pool } = pg;

let db = null;

// Migration SQL — idempotent, matches orchestrator/src/schema.sql additions.
// Run on every startup so the service works standalone (no docker entrypoint needed).
const MIGRATION_SQL = `
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
CREATE INDEX IF NOT EXISTS idx_ae_received_at  ON audit_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_message_type ON audit_events (message_type);
CREATE INDEX IF NOT EXISTS idx_ae_agent_id     ON audit_events (agent_id);

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

CREATE TABLE IF NOT EXISTS audit_jobs (
  job_id           TEXT        PRIMARY KEY,
  contract_address TEXT        NOT NULL,
  deployer_address TEXT        NOT NULL DEFAULT '',
  contract_type    TEXT        NOT NULL DEFAULT 'unknown',
  status           TEXT        NOT NULL DEFAULT 'open',
  budget_guard     REAL        NOT NULL DEFAULT 0,
  winner_addresses TEXT[]      NOT NULL DEFAULT '{}',
  finding_count    INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aj_status           ON audit_jobs (status);
CREATE INDEX IF NOT EXISTS idx_aj_contract_address ON audit_jobs (contract_address);
CREATE INDEX IF NOT EXISTS idx_aj_updated_at       ON audit_jobs (updated_at DESC);

CREATE TABLE IF NOT EXISTS registered_agents (
  evm_address     TEXT        PRIMARY KEY,
  agent_id        TEXT        NOT NULL DEFAULT '',
  specializations TEXT[]      NOT NULL DEFAULT '{}',
  reputation      INTEGER     NOT NULL DEFAULT 0,
  tier            TEXT        NOT NULL DEFAULT 'standard',
  status          TEXT        NOT NULL DEFAULT 'active',
  stake_guard     REAL        NOT NULL DEFAULT 0,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ra_status   ON registered_agents (status);
CREATE INDEX IF NOT EXISTS idx_ra_agent_id ON registered_agents (agent_id);

CREATE TABLE IF NOT EXISTS audit_schedules (
  contract_address  TEXT        PRIMARY KEY,
  owner_address     TEXT        NOT NULL DEFAULT '',
  schedule_address  TEXT        NOT NULL DEFAULT '',
  next_audit_due    BIGINT      NOT NULL DEFAULT 0,
  mode              INTEGER     NOT NULL DEFAULT 0,
  interval_seconds  BIGINT      NOT NULL DEFAULT 0,
  times_triggered   INTEGER     NOT NULL DEFAULT 0,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_as_active ON audit_schedules (active);

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
`;

// ── PG implementation ─────────────────────────────────────────────────────────

class PgDb {
  constructor(pool) {
    this.pool = pool;
  }

  async insertEvent(id, source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson, receivedAt) {
    await this.pool.query(
      `INSERT INTO audit_events
         (id, source, topic_id, message_type, agent_id, message_timestamp, payload_json, raw_json, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [id, source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson, receivedAt],
    );
  }

  async insertBidSkip(id, eventId, jobId, agentId, reasonCode, reason, inviteBudget, bidAmount, createdAt) {
    await this.pool.query(
      `INSERT INTO bid_skips
         (id, event_id, job_id, agent_id, reason_code, reason, invite_budget, bid_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [id, eventId, jobId, agentId, reasonCode, reason, inviteBudget, bidAmount, createdAt],
    );
  }

  async queryEvents({ messageType, agentId, topicId, limit }) {
    const clauses = [];
    const params = [];

    if (messageType) {
      clauses.push(`message_type = $${params.length + 1}`);
      params.push(messageType);
    }
    if (agentId) {
      clauses.push(`agent_id = $${params.length + 1}`);
      params.push(agentId);
    }
    if (topicId) {
      clauses.push(`topic_id = $${params.length + 1}`);
      params.push(topicId);
    }
    params.push(limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT id, source, topic_id, message_type, agent_id,
              message_timestamp, payload_json, raw_json, received_at
       FROM audit_events
       ${where}
       ORDER BY received_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async queryBidSkips({ reasonCode, agentId, limit }) {
    const clauses = [];
    const params = [];

    if (reasonCode) {
      clauses.push(`reason_code = $${params.length + 1}`);
      params.push(reasonCode);
    }
    if (agentId) {
      clauses.push(`agent_id = $${params.length + 1}`);
      params.push(agentId);
    }
    params.push(limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT id, event_id, job_id, agent_id, reason_code,
              reason, invite_budget, bid_amount, created_at
       FROM bid_skips
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async upsertJob({ jobId, contractAddress, deployerAddress, contractType, status, budgetGuard, winnerAddresses, findingCount }) {
    await this.pool.query(
      `INSERT INTO audit_jobs
         (job_id, contract_address, deployer_address, contract_type, status,
          budget_guard, winner_addresses, finding_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         contract_address = EXCLUDED.contract_address,
         deployer_address = COALESCE(EXCLUDED.deployer_address, audit_jobs.deployer_address),
         contract_type    = COALESCE(EXCLUDED.contract_type, audit_jobs.contract_type),
         status           = EXCLUDED.status,
         budget_guard     = COALESCE(EXCLUDED.budget_guard, audit_jobs.budget_guard),
         winner_addresses = COALESCE(EXCLUDED.winner_addresses, audit_jobs.winner_addresses),
         finding_count    = COALESCE(EXCLUDED.finding_count, audit_jobs.finding_count),
         updated_at       = NOW()`,
      [
        jobId,
        contractAddress,
        deployerAddress ?? "",
        contractType ?? "unknown",
        status ?? "open",
        budgetGuard ?? 0,
        winnerAddresses ?? [],
        findingCount ?? 0,
      ],
    );
  }

  async queryJobs({ status, contractAddress, limit }) {
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (contractAddress) {
      clauses.push(`contract_address = $${params.length + 1}`);
      params.push(contractAddress);
    }
    params.push(limit ?? 100);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT job_id, contract_address, deployer_address, contract_type,
              status, budget_guard, winner_addresses, finding_count, created_at, updated_at
       FROM audit_jobs
       ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async getJobById(jobId) {
    const { rows } = await this.pool.query(
      `SELECT job_id, contract_address, deployer_address, contract_type,
              status, budget_guard, winner_addresses, finding_count, created_at, updated_at
       FROM audit_jobs WHERE job_id = $1`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  async upsertAgent({ evmAddress, agentId, specializations, reputation, tier, status, stakeGuard }) {
    await this.pool.query(
      `INSERT INTO registered_agents
         (evm_address, agent_id, specializations, reputation, tier, status, stake_guard, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (evm_address) DO UPDATE SET
         agent_id        = COALESCE(EXCLUDED.agent_id, registered_agents.agent_id),
         specializations = COALESCE(EXCLUDED.specializations, registered_agents.specializations),
         reputation      = COALESCE(EXCLUDED.reputation, registered_agents.reputation),
         tier            = COALESCE(EXCLUDED.tier, registered_agents.tier),
         status          = EXCLUDED.status,
         stake_guard     = COALESCE(EXCLUDED.stake_guard, registered_agents.stake_guard),
         last_seen_at    = NOW()`,
      [
        evmAddress.toLowerCase(),
        agentId ?? "",
        specializations ?? [],
        reputation ?? 0,
        tier ?? "standard",
        status ?? "active",
        stakeGuard ?? 0,
      ],
    );
  }

  async queryAgents({ status, limit }) {
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    params.push(limit ?? 100);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT evm_address, agent_id, specializations, reputation, tier,
              status, stake_guard, last_seen_at, registered_at
       FROM registered_agents
       ${where}
       ORDER BY last_seen_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async upsertSchedule({ contractAddress, ownerAddress, scheduleAddress, nextAuditDue, mode, intervalSeconds, timesTriggered, active }) {
    await this.pool.query(
      `INSERT INTO audit_schedules
         (contract_address, owner_address, schedule_address, next_audit_due, mode,
          interval_seconds, times_triggered, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (contract_address) DO UPDATE SET
         owner_address    = COALESCE(EXCLUDED.owner_address, audit_schedules.owner_address),
         schedule_address = COALESCE(EXCLUDED.schedule_address, audit_schedules.schedule_address),
         next_audit_due   = COALESCE(EXCLUDED.next_audit_due, audit_schedules.next_audit_due),
         mode             = COALESCE(EXCLUDED.mode, audit_schedules.mode),
         interval_seconds = COALESCE(EXCLUDED.interval_seconds, audit_schedules.interval_seconds),
         times_triggered  = COALESCE(EXCLUDED.times_triggered, audit_schedules.times_triggered),
         active           = EXCLUDED.active,
         updated_at       = NOW()`,
      [
        contractAddress.toLowerCase(),
        ownerAddress ?? "",
        scheduleAddress ?? "",
        nextAuditDue ?? 0,
        mode ?? 0,
        intervalSeconds ?? 0,
        timesTriggered ?? 0,
        active !== undefined ? active : true,
      ],
    );
  }

  async querySchedules({ active, limit } = {}) {
    const clauses = [];
    const params = [];

    if (active !== undefined) {
      clauses.push(`active = $${params.length + 1}`);
      params.push(active);
    }
    params.push(limit ?? 100);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT contract_address, owner_address, schedule_address, next_audit_due, mode,
              interval_seconds, times_triggered, active, created_at, updated_at
       FROM audit_schedules
       ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async upsertVault({ contractAddress, vaultAddress, creator, contractChain, active }) {
    await this.pool.query(
      `INSERT INTO audit_vaults
         (contract_address, vault_address, creator, contract_chain, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (contract_address) DO UPDATE SET
         vault_address  = EXCLUDED.vault_address,
         creator        = COALESCE(EXCLUDED.creator, audit_vaults.creator),
         contract_chain = COALESCE(EXCLUDED.contract_chain, audit_vaults.contract_chain),
         active         = EXCLUDED.active,
         updated_at     = NOW()`,
      [
        contractAddress.toLowerCase(),
        vaultAddress.toLowerCase(),
        creator ?? "",
        contractChain ?? "hedera-testnet",
        active !== undefined ? active : true,
      ],
    );
  }

  async queryVaults({ active, limit } = {}) {
    const clauses = [];
    const params = [];

    if (active !== undefined) {
      clauses.push(`active = $${params.length + 1}`);
      params.push(active);
    }
    params.push(limit ?? 100);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT contract_address, vault_address, creator, contract_chain, active, created_at, updated_at
       FROM audit_vaults
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async healthCheck() {
    const { rows } = await this.pool.query("SELECT 1 AS ok");
    return Number(rows[0]?.ok) === 1;
  }
}

// ── In-memory fallback (local dev without Postgres) ───────────────────────────

function toFiniteLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

class InMemoryDb {
  constructor() {
    this.auditEvents = [];
    this.bidSkips = [];
    this.auditJobs = new Map();        // jobId → row
    this.registeredAgents = new Map(); // evmAddress → row
    this.auditSchedules = new Map();   // contractAddress → row
    this.auditVaults = new Map();      // contractAddress → row
  }

  async insertEvent(id, source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson, receivedAt) {
    if (this.auditEvents.some((r) => r.id === id)) return;
    this.auditEvents.push({ id, source, topic_id: topicId, message_type: messageType, agent_id: agentId, message_timestamp: messageTimestamp, payload_json: payloadJson, raw_json: rawJson, received_at: receivedAt });
  }

  async insertBidSkip(id, eventId, jobId, agentId, reasonCode, reason, inviteBudget, bidAmount, createdAt) {
    if (this.bidSkips.some((r) => r.id === id)) return;
    this.bidSkips.push({ id, event_id: eventId, job_id: jobId, agent_id: agentId, reason_code: reasonCode, reason, invite_budget: inviteBudget, bid_amount: bidAmount, created_at: createdAt });
  }

  async queryEvents({ messageType, agentId, topicId, limit }) {
    const lim = toFiniteLimit(limit, 100);
    return this.auditEvents
      .filter((r) => (messageType ? r.message_type === messageType : true))
      .filter((r) => (agentId ? r.agent_id === agentId : true))
      .filter((r) => (topicId ? r.topic_id === topicId : true))
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
      .slice(0, lim);
  }

  async queryBidSkips({ reasonCode, agentId, limit }) {
    const lim = toFiniteLimit(limit, 100);
    return this.bidSkips
      .filter((r) => (reasonCode ? r.reason_code === reasonCode : true))
      .filter((r) => (agentId ? r.agent_id === agentId : true))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, lim);
  }

  async upsertJob({ jobId, contractAddress, deployerAddress, contractType, status, budgetGuard, winnerAddresses, findingCount }) {
    const now = new Date().toISOString();
    const existing = this.auditJobs.get(jobId) ?? { created_at: now };
    this.auditJobs.set(jobId, {
      job_id: jobId,
      contract_address: contractAddress,
      deployer_address: deployerAddress ?? existing.deployer_address ?? "",
      contract_type: contractType ?? existing.contract_type ?? "unknown",
      status: status ?? "open",
      budget_guard: budgetGuard ?? existing.budget_guard ?? 0,
      winner_addresses: winnerAddresses ?? existing.winner_addresses ?? [],
      finding_count: findingCount ?? existing.finding_count ?? 0,
      created_at: existing.created_at,
      updated_at: now,
    });
  }

  async queryJobs({ status, contractAddress, limit }) {
    const lim = toFiniteLimit(limit, 100);
    return [...this.auditJobs.values()]
      .filter((r) => (status ? r.status === status : true))
      .filter((r) => (contractAddress ? r.contract_address === contractAddress : true))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, lim);
  }

  async getJobById(jobId) {
    return this.auditJobs.get(jobId) ?? null;
  }

  async upsertAgent({ evmAddress, agentId, specializations, reputation, tier, status, stakeGuard }) {
    const addr = evmAddress.toLowerCase();
    const now = new Date().toISOString();
    const existing = this.registeredAgents.get(addr) ?? { registered_at: now };
    this.registeredAgents.set(addr, {
      evm_address: addr,
      agent_id: agentId ?? existing.agent_id ?? "",
      specializations: specializations ?? existing.specializations ?? [],
      reputation: reputation ?? existing.reputation ?? 0,
      tier: tier ?? existing.tier ?? "standard",
      status: status ?? "active",
      stake_guard: stakeGuard ?? existing.stake_guard ?? 0,
      last_seen_at: now,
      registered_at: existing.registered_at,
    });
  }

  async queryAgents({ status, limit }) {
    const lim = toFiniteLimit(limit, 100);
    return [...this.registeredAgents.values()]
      .filter((r) => (status ? r.status === status : true))
      .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
      .slice(0, lim);
  }

  async upsertSchedule({ contractAddress, ownerAddress, scheduleAddress, nextAuditDue, mode, intervalSeconds, timesTriggered, active }) {
    const addr = contractAddress.toLowerCase();
    const now = new Date().toISOString();
    const existing = this.auditSchedules.get(addr) ?? { created_at: now };
    this.auditSchedules.set(addr, {
      contract_address: addr,
      owner_address: ownerAddress ?? existing.owner_address ?? "",
      schedule_address: scheduleAddress ?? existing.schedule_address ?? "",
      next_audit_due: nextAuditDue ?? existing.next_audit_due ?? 0,
      mode: mode ?? existing.mode ?? 0,
      interval_seconds: intervalSeconds ?? existing.interval_seconds ?? 0,
      times_triggered: timesTriggered ?? existing.times_triggered ?? 0,
      active: active !== undefined ? active : (existing.active !== undefined ? existing.active : true),
      created_at: existing.created_at,
      updated_at: now,
    });
  }

  async querySchedules({ active, limit } = {}) {
    const lim = toFiniteLimit(limit, 100);
    return [...this.auditSchedules.values()]
      .filter((r) => (active !== undefined ? r.active === active : true))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, lim);
  }

  async upsertVault({ contractAddress, vaultAddress, creator, contractChain, active }) {
    const addr = contractAddress.toLowerCase();
    const now = new Date().toISOString();
    const existing = this.auditVaults.get(addr) ?? { created_at: now };
    this.auditVaults.set(addr, {
      contract_address: addr,
      vault_address: vaultAddress.toLowerCase(),
      creator: creator ?? existing.creator ?? "",
      contract_chain: contractChain ?? existing.contract_chain ?? "hedera-testnet",
      active: active !== undefined ? active : (existing.active !== undefined ? existing.active : true),
      created_at: existing.created_at,
      updated_at: now,
    });
  }

  async queryVaults({ active, limit } = {}) {
    const lim = toFiniteLimit(limit, 100);
    return [...this.auditVaults.values()]
      .filter((r) => (active !== undefined ? r.active === active : true))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, lim);
  }

  async healthCheck() {
    return true;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initDb() {
  if (db) return db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    db = new InMemoryDb();
    console.warn("[events-api] DATABASE_URL not set; using in-memory event store (data lost on restart)");
    return db;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(MIGRATION_SQL);
  db = new PgDb(pool);
  console.log("[events-api] PostgreSQL database initialised");
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error("Database not initialised. Call initDb() first.");
  }
  return db;
}
