# AuditGuard — Production Persistence Plan

## Goal

Replace ephemeral in-memory and local-file storage with a production-grade, dockerized PostgreSQL database running on a server. The database is a **read-cache** — Hedera (contracts + HCS) is always the source of truth. The DB can be rebuilt from chain data at any time.

---

## Implementation Status

| # | Task | Status |
|---|------|--------|
| 1 | Extend schema with `audit_events`, `bid_skips`, `pending_findings` | ✅ Done |
| 2 | Replace events-api SQLite → async PG + in-memory fallback | ✅ Done |
| 3 | Update events-api route handlers to async | ✅ Done |
| 4 | Replace static-analysis-service findings store with PG | ✅ Done |
| 5 | Update Dockerfile (add fuzzer-service, static-analysis-service, sdk) | ✅ Done |
| 6 | Update `docker-compose.prod.yml` (remove SQLite volume, add report_files) | ✅ Done |
| 7 | Update `docker-compose.yml` (add postgres service for local dev) | ✅ Done |
| 8 | Provision server | ⬜ TODO |
| 9 | Wire CI/CD auto-deploy | ⬜ TODO |
| 10 | Set up daily backups | ⬜ TODO |
| 11 | Migrate existing SQLite data to Postgres | ⬜ TODO |

---

## What Needs to Be Persisted

| Data | Previous State | Current State |
|------|---------------|---------------|
| Audit reports (markdown + metadata) | Local file + PG | PostgreSQL ✅ |
| Audit events log | SQLite `data/events.db` | PostgreSQL ✅ |
| Bid skip decisions | SQLite `data/events.db` | PostgreSQL ✅ |
| Findings during aggregation | In-memory Map (lost on restart) | PostgreSQL ✅ |
| Fuzzer job queue | In-memory Map | In-memory (deferred — agent retries on restart) |
| Static analysis job queue | In-memory Map | In-memory (deferred — agent retries on restart) |
| Agent sessions / nonce tracking | In-memory | Redis (future, not started) |

**Not persisted in DB (already durable on-chain):**
- Agent registry, reputation, staking → Hedera `AgentRegistry`
- Job lifecycle, bids, winners → Hedera `AuditAuction`
- Payment history → Hedera `PaymentSettlement`
- All events (canonical) → Hedera HCS topics (replayable)
- iNFT metadata → 0g Labs DA

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Production Server (EC2 / VPS)             │
│                                                              │
│  ┌────────────────┐   ┌───────────────────────────────────┐  │
│  │   PostgreSQL   │   │          Backend Container        │  │
│  │   (Docker)     │◄──│  orchestrator | agents | api      │  │
│  │                │   │  fuzzer-svc | static-analysis-svc │  │
│  │  Port: 5432    │   │  Port: 4000 (events-api)          │  │
│  └────────────────┘   └───────────────────────────────────┘  │
│                                                              │
│  ┌────────────────┐   ┌────────────────┐                     │
│  │  pg_data vol   │   │ report_files   │                     │
│  │  (DB data)     │   │ vol (MD files) │                     │
│  └────────────────┘   └────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              ▼
                    ┌──────────────────┐
                    │  Dashboard       │
                    │  (Vercel CDN)    │
                    │  /api/* → server │
                    └──────────────────┘
```

---

## Phase 1: PostgreSQL Schema ✅ Done

**File:** `orchestrator/src/schema.sql`

All four tables are now defined. `audit_reports` was already present. The three new tables were appended:

```sql
-- ── Already existed ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_reports (
  id                   TEXT        NOT NULL,
  job_id               TEXT        NOT NULL,
  contract_address     TEXT        NOT NULL,
  deployer_address     TEXT        NOT NULL,
  hedera_account_id    TEXT,
  chain                TEXT        NOT NULL,
  contract_type        TEXT        NOT NULL,
  content_hash         TEXT        NOT NULL,
  md_content           TEXT        NOT NULL DEFAULT '',
  s3_key               TEXT        NOT NULL DEFAULT '',
  cid                  TEXT        NOT NULL DEFAULT '',
  agent_addresses      TEXT[]      NOT NULL DEFAULT '{}',
  agent_count          INTEGER     NOT NULL DEFAULT 0,
  finding_count        INTEGER     NOT NULL DEFAULT 0,
  findings_by_severity JSONB       NOT NULL DEFAULT '{"critical":0,"high":0,"medium":0,"low":0,"info":0}',
  timestamp            BIGINT      NOT NULL,
  tags                 TEXT[]      NOT NULL DEFAULT '{}',
  source               TEXT        NOT NULL DEFAULT 'orchestrator',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

-- ── New: replaces SQLite audit_events ────────────────────────────────────────
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

-- ── New: replaces SQLite bid_skips ───────────────────────────────────────────
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

-- ── New: replaces in-memory findingsStore Map ────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_findings (
  id        SERIAL      PRIMARY KEY,
  job_id    TEXT        NOT NULL,
  agent_id  TEXT        NOT NULL,
  findings  JSONB       NOT NULL DEFAULT '[]',
  stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_pf_job_id ON pending_findings (job_id);
```

**Note:** `analysis_jobs` was intentionally omitted. Fuzzer and static-analysis job queues are short-lived (seconds to minutes) and agents have retry logic on restart. Persisting job queues is deferred to a future phase.

The schema file is mounted as `/docker-entrypoint-initdb.d/001-schema.sql` in both compose files so Postgres auto-applies it on first boot.

---

## Phase 2: Code Changes ✅ Done

### 2a. events-api: SQLite → async PostgreSQL

**Files changed:**
- `packages/events-api/src/db.js` — full rewrite
- `packages/events-api/src/routes/events.js`
- `packages/events-api/src/routes/bid-skips.js`
- `packages/events-api/src/routes/health.js`
- `packages/events-api/src/index.js`

**`db.js` new interface** (all methods are `async`):

| Method | Description |
|--------|-------------|
| `initDb()` | Creates pool, runs migration SQL. Top-level `await` in `index.js`. |
| `getDb()` | Returns the singleton db instance (throws if not initialised). |
| `db.insertEvent(id, source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson, receivedAt)` | Inserts into `audit_events`. |
| `db.insertBidSkip(id, eventId, jobId, agentId, reasonCode, reason, inviteBudget, bidAmount, createdAt)` | Inserts into `bid_skips`. |
| `db.queryEvents({ messageType?, agentId?, topicId?, limit })` | Queries `audit_events` with optional filters. |
| `db.queryBidSkips({ reasonCode?, agentId?, limit })` | Queries `bid_skips` with optional filters. |
| `db.healthCheck()` | Runs `SELECT 1` — returns `true` if DB is reachable. |

**Fallback behaviour:** If `DATABASE_URL` is not set, `db.js` falls back to an `InMemoryDb` instance that implements the same async interface. This means local development without Docker still works — just with no persistence between restarts.

**`received_at` / `created_at` type handling:** PG returns `TIMESTAMPTZ` columns as JS `Date` objects. Row mappers in `events.js` and `bid-skips.js` convert with:
```js
row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at
```

**`index.js`** uses top-level `await` (valid because `"type": "module"` is set in `package.json`):
```js
await initDb();
app.listen(PORT, ...);
```

### 2b. static-analysis-service: findings store → PostgreSQL

**Files changed:**
- `packages/static-analysis-service/src/index.js` — findings store rewritten
- `packages/static-analysis-service/package.json` — added `"pg": "^8.18.0"`

The `findingsStore` Map was replaced with three async helpers:

| Helper | SQL |
|--------|-----|
| `storeFinding(jobId, agentId, findings)` | `INSERT ... ON CONFLICT (job_id, agent_id) DO UPDATE SET findings = $3, stored_at = NOW()` |
| `getFindingsForJob(jobId)` | `SELECT agent_id, findings, stored_at FROM pending_findings WHERE job_id = $1` |
| `deleteFindingsForJob(jobId)` | `DELETE FROM pending_findings WHERE job_id = $1` |

`initFindingsStore()` is called at startup. It runs the `pending_findings` migration SQL (idempotent) so the service works standalone without docker entrypoint. The three `/findings` route handlers are now `async`.

**Fallback behaviour:** If `DATABASE_URL` is not set, falls back to in-memory `Map` — same as before. Local dev without Docker is unaffected.

---

## Phase 3: Docker ✅ Done

### `Dockerfile`

Added `COPY` statements for `static-analysis-service`, `fuzzer-service`, and `sdk` package.json files in the `deps` stage so `npm ci` installs their dependencies (including the new `pg` dep for `static-analysis-service`):

```dockerfile
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/events-api/package.json              ./packages/events-api/
COPY packages/static-analysis-service/package.json ./packages/static-analysis-service/
COPY packages/fuzzer-service/package.json           ./packages/fuzzer-service/
COPY packages/sdk/package.json                      ./packages/sdk/
COPY agents/package.json                            ./agents/
COPY orchestrator/package.json                      ./orchestrator/
RUN npm ci --ignore-scripts
```

### `docker-compose.prod.yml`

Key changes from the previous version:
- Removed `EVENTS_DB_PATH` environment variable (SQLite no longer used)
- Removed `events_data` volume (no SQLite file to persist)
- Added `report_files` named volume mounted at `/app/agents/data/reports` for local MD file backup
- `DATABASE_URL` is the only DB-related env var needed by the backend container

### `docker-compose.yml` (local dev)

Added a `postgres` service matching the prod setup so developers can run `docker compose up` locally and test against real PG:
- Schema auto-applied via `./orchestrator/src/schema.sql:/docker-entrypoint-initdb.d/001-schema.sql`
- `DATABASE_URL=postgresql://auditguard:${POSTGRES_PASSWORD:-dev}@postgres:5432/auditguard` passed to all backend services
- `pg_data` named volume for local persistence
- Removed orphaned `events-data` volume (was for SQLite)
- All backend services `depends_on: postgres: condition: service_healthy`

---

## Phase 4: Server Setup ⬜ TODO

### Minimum Server Requirements
- **CPU:** 2 vCPU (agents are async/I/O bound, not CPU heavy)
- **RAM:** 4 GB (7 agents + orchestrator + Postgres + 3 microservices)
- **Storage:** 20 GB SSD (Postgres data + report files + logs)
- **OS:** Ubuntu 22.04 LTS
- **Ports open:** 80/443 (nginx), 22 (SSH)
- **Ports NOT open to internet:** 4000, 5432 (internal only)

### Server Software Stack
```
nginx (reverse proxy + TLS termination)
  └── :443 → :4000 (events-api / reports API)
Docker (postgres + backend containers)
certbot (Let's Encrypt TLS)
```

### Initial Server Setup Steps

```bash
# 1. Install Docker + Docker Compose
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. Install nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# 3. Create app directory
sudo mkdir -p /opt/auditguard
sudo chown $USER /opt/auditguard

# 4. Copy .env to server (never commit this)
scp .env user@server:/opt/auditguard/.env

# 5. Pull and start
cd /opt/auditguard
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# 6. Verify schema was applied
docker exec auditguard-postgres psql -U auditguard -c "\dt"

# 7. Configure nginx (see below)
# 8. Issue TLS cert via certbot
```

### nginx Config (Reverse Proxy)

```nginx
server {
    listen 443 ssl;
    server_name api.auditguard.xyz;

    ssl_certificate     /etc/letsencrypt/live/api.auditguard.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.auditguard.xyz/privkey.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name api.auditguard.xyz;
    return 301 https://$host$request_uri;
}
```

---

## Phase 5: Database Backup Strategy ⬜ TODO

```bash
# Daily backup (add to cron on server)
docker exec auditguard-postgres pg_dump -U auditguard auditguard \
  | gzip > /opt/auditguard/backups/auditguard-$(date +%Y%m%d).sql.gz

# Keep last 30 days
find /opt/auditguard/backups -name "*.sql.gz" -mtime +30 -delete
```

For production: pipe backups to S3 (`AWS_S3_BUCKET` already in env).

---

## Phase 6: CI/CD Auto-Deploy ⬜ TODO

Existing `.github/workflows/` already has:
1. Build & push backend image to GHCR on push to `main`
2. Deploy dashboard to Vercel

**What needs to be added** — SSH deploy step after docker push:

```yaml
- name: Deploy to server
  uses: appleboy/ssh-action@v1
  with:
    host: ${{ secrets.EC2_HOST }}
    username: ${{ secrets.EC2_USER }}
    key: ${{ secrets.EC2_SSH_KEY }}
    script: |
      cd /opt/auditguard
      docker compose -f docker-compose.prod.yml pull
      docker compose -f docker-compose.prod.yml up -d --no-deps backend
```

Required GitHub secrets: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`.

---

## Phase 7: Data Migration ⬜ TODO

Migrate existing local data to Postgres after server is provisioned:

```bash
# 1. Export SQLite events DB to CSV
sqlite3 data/events.db ".mode csv" ".output /tmp/audit_events.csv" "SELECT * FROM audit_events;"
sqlite3 data/events.db ".mode csv" ".output /tmp/bid_skips.csv" "SELECT * FROM bid_skips;"

# 2. Import to Postgres (adjust COPY paths as needed)
psql $DATABASE_URL -c "\COPY audit_events FROM '/tmp/audit_events.csv' CSV"
psql $DATABASE_URL -c "\COPY bid_skips FROM '/tmp/bid_skips.csv' CSV"

# 3. Import existing report markdown files
# Run orchestrator/scripts/import-reports.js (to be written) which reads
# agents/data/reports/*.md and INSERTs into audit_reports via report-db.js
```

---

## Environment Variables

Required in `/opt/auditguard/.env` on the server (in addition to existing Hedera/agent keys):

```bash
# Database (required for production)
DATABASE_URL=postgresql://auditguard:STRONG_PASSWORD@postgres:5432/auditguard
POSTGRES_PASSWORD=STRONG_PASSWORD

# Events API
EVENTS_API_PORT=4000
EVENTS_API_TOKEN=STRONG_RANDOM_TOKEN   # agents use this to POST events

# Optional: S3 backup for large report markdown
AWS_S3_BUCKET=auditguard-reports
AWS_REGION=us-east-1
```

For local dev (already in `.env.example`):
```bash
DATABASE_URL=postgresql://auditguard:dev@localhost:5432/auditguard
POSTGRES_PASSWORD=dev
```

If `DATABASE_URL` is not set, both `events-api` and `static-analysis-service` fall back to in-memory storage with a console warning. This is intentional — local dev without Docker continues to work.

---

## What Will NOT Be in the Database

By design, these stay on-chain / on DA — the DB is only a cache:

- **Agent reputation scores** — Always read from `AgentRegistry` contract
- **Job outcomes, bids, payments** — Always read from `AuditAuction` / `PaymentSettlement`
- **Canonical event log** — Hedera HCS (the DB is a queryable index, not the record)
- **iNFT metadata** — 0g Labs DA (CIDs only stored in DB for lookup)

If the database is wiped, it can be fully rebuilt by replaying HCS topics and re-fetching reports from the DA layer.
