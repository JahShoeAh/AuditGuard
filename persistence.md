# AuditGuard — Production Persistence Plan

## Goal

Replace ephemeral in-memory and local-file storage with a production-grade, dockerized PostgreSQL database running on a server. The database is a **read-cache** — Hedera (contracts + HCS) is always the source of truth. The DB can be rebuilt from chain data at any time.

---

## What Needs to Be Persisted

| Data | Current State | Target |
|------|--------------|--------|
| Audit reports (markdown + metadata) | Local file + optional PG | PostgreSQL (always) |
| Audit events log | SQLite `data/events.db` | PostgreSQL (replace SQLite) |
| Bid skip decisions | SQLite `data/events.db` | PostgreSQL |
| Findings during aggregation | In-memory (lost on restart) | PostgreSQL or Redis |
| Fuzzer job queue | In-memory | PostgreSQL |
| Static analysis job queue | In-memory | PostgreSQL |
| Agent sessions / nonce tracking | In-memory | Redis (optional) |

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
│  ┌────────────────┐                                          │
│  │  Docker Volume │  /var/lib/postgresql/data               │
│  │  (pg data)     │  Persists across container restarts     │
│  └────────────────┘                                          │
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

## Phase 1: PostgreSQL Schema (Consolidate All Storage)

### Goal
Single Postgres instance replacing: SQLite events DB, local report files, in-memory findings store.

### New / Updated Tables

```sql
-- Already exists in orchestrator/src/schema.sql — keep as-is
CREATE TABLE IF NOT EXISTS audit_reports (
  id                   TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  contract_address     TEXT NOT NULL,
  deployer_address     TEXT,
  hedera_account_id    TEXT,
  chain                TEXT NOT NULL DEFAULT 'hedera',
  contract_type        TEXT,
  md_content           TEXT,
  s3_key               TEXT,
  cid                  TEXT,
  agent_addresses      TEXT[],
  agent_count          INTEGER,
  finding_count        INTEGER DEFAULT 0,
  findings_by_severity JSONB,
  timestamp            BIGINT,
  tags                 TEXT[],
  source               TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- MIGRATE from SQLite data/events.db
CREATE TABLE IF NOT EXISTS audit_events (
  id                TEXT PRIMARY KEY,
  source            TEXT,
  topic_id          TEXT,
  message_type      TEXT,
  agent_id          TEXT,
  message_timestamp BIGINT,
  payload_json      TEXT,
  raw_json          TEXT,
  received_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bid_skips (
  id           TEXT PRIMARY KEY,
  event_id     TEXT REFERENCES audit_events(id),
  job_id       INTEGER,
  agent_id     TEXT,
  reason_code  TEXT,
  reason       TEXT,
  invite_budget REAL,
  bid_amount   REAL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- NEW: replaces in-memory findings store in static-analysis-service
CREATE TABLE IF NOT EXISTS pending_findings (
  id           SERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  findings     JSONB NOT NULL,
  stored_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (job_id, agent_id)   -- one entry per agent per job
);

-- NEW: replaces in-memory job queues in fuzzer/static-analysis services
CREATE TABLE IF NOT EXISTS analysis_jobs (
  job_id       TEXT PRIMARY KEY,
  service      TEXT NOT NULL,           -- 'fuzzer' | 'static-analysis'
  contract_address TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  tool_used    TEXT,
  findings     JSONB,
  error        TEXT,
  budget_seconds INTEGER DEFAULT 120,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_reports_job_id        ON audit_reports(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_reports_contract      ON audit_reports(contract_address);
CREATE INDEX IF NOT EXISTS idx_audit_reports_deployer      ON audit_reports(deployer_address);
CREATE INDEX IF NOT EXISTS idx_audit_reports_created_at    ON audit_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type           ON audit_events(message_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_agent          ON audit_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_received_at    ON audit_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_findings_job        ON pending_findings(job_id);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status        ON analysis_jobs(status);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_service       ON analysis_jobs(service, status);
```

**Files to update:**
- Add `pending_findings` and `analysis_jobs` tables to `orchestrator/src/schema.sql`
- Update `packages/sdk/db/report-db.js` with new table definitions
- Update `packages/events-api/src/index.js` to use Postgres instead of SQLite

---

## Phase 2: Docker Setup

### 2a. `docker-compose.prod.yml` (update existing)

The file exists but needs to be verified and hardened. Target:

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    container_name: auditguard-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: auditguard
      POSTGRES_USER: auditguard
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./orchestrator/src/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    ports:
      - "127.0.0.1:5432:5432"   # localhost-only — never expose to internet
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U auditguard"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/${GITHUB_REPOSITORY}-devall:latest
    container_name: auditguard-backend
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file: /opt/auditguard/.env
    environment:
      DATABASE_URL: postgresql://auditguard:${POSTGRES_PASSWORD}@postgres:5432/auditguard
    ports:
      - "4000:4000"    # events-api (reverse-proxied by nginx)
    volumes:
      - report_files:/app/agents/data/reports   # local file backup
      - agent_logs:/app/agents/logs

volumes:
  pg_data:
  report_files:
  agent_logs:
```

**Key changes from current file:**
- Postgres port bound to `127.0.0.1` only (not exposed to internet)
- Schema auto-applied via `docker-entrypoint-initdb.d/`
- Named volumes for data durability
- Healthcheck before backend starts

### 2b. `Dockerfile` (verify multi-stage build)

Current `Dockerfile` exists — verify it:
1. Copies `orchestrator/`, `agents/`, `packages/events-api/`, `packages/fuzzer-service/`, `packages/static-analysis-service/`
2. Runs `npm install` with `--workspaces`
3. Entrypoint runs all services (orchestrator + agents + events-api)
4. Does NOT include dashboard (deployed separately to Vercel)

---

## Phase 3: Server Setup

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

# 6. Configure nginx (see below)
# 7. Issue TLS cert via certbot
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

## Phase 4: Code Changes Required

### 4a. events-api: Replace SQLite with PostgreSQL

**File:** `packages/events-api/src/index.js`

Current: `better-sqlite3` with in-memory fallback.
Target: Use `pg` (already a dependency in `packages/sdk`) — same interface, connect via `DATABASE_URL`.

Changes needed:
- Replace `better-sqlite3` adapter with `pg.Pool` adapter
- Keep the same `prepare/run/all/get` interface (already abstracted)
- Remove in-memory fallback (Postgres is required in production; fail loudly if unavailable)
- Add connection retry with exponential backoff on startup

### 4b. static-analysis-service: Replace In-Memory Findings Store with PostgreSQL

**File:** `packages/static-analysis-service/src/index.js`

Current: `Map<jobId, [{ agentId, findings, timestamp }]>` in process memory.
Target: Read/write `pending_findings` table in Postgres.

Changes needed:
- Add `pg.Pool` connection using `DATABASE_URL`
- `POST /findings` → `INSERT INTO pending_findings ... ON CONFLICT DO UPDATE`
- `GET /findings/:jobId` → `SELECT FROM pending_findings WHERE job_id = $1`
- `DELETE /findings/:jobId` → `DELETE FROM pending_findings WHERE job_id = $1`

This fixes the race condition where a service restart between agent submission and report aggregation loses all findings.

### 4c. fuzzer-service: Replace In-Memory Job Queue with PostgreSQL

**File:** `packages/fuzzer-service/src/index.js`

Current: `Map<jobId, Job>` in process memory.
Target: `analysis_jobs` table in Postgres with `service = 'fuzzer'`.

Changes needed:
- Add `pg.Pool` connection
- `POST /fuzz` → `INSERT INTO analysis_jobs`
- `GET /results/:jobId` → `SELECT FROM analysis_jobs WHERE job_id = $1`
- Job runner: `UPDATE analysis_jobs SET status = 'running'` on pickup, `status = 'done'` on complete

### 4d. static-analysis-service: Same Job Queue Migration

Same pattern as fuzzer, using `service = 'static-analysis'` in `analysis_jobs`.

### 4e. Ensure DATABASE_URL is Propagated to All Services

Every service that needs Postgres must receive `DATABASE_URL` via environment. In `docker-compose.prod.yml`, the single backend container already has it. For local dev, add to `.env`.

---

## Phase 5: Database Backup Strategy

```bash
# Daily backup (add to cron on server)
docker exec auditguard-postgres pg_dump -U auditguard auditguard \
  | gzip > /opt/auditguard/backups/auditguard-$(date +%Y%m%d).sql.gz

# Keep last 30 days
find /opt/auditguard/backups -name "*.sql.gz" -mtime +30 -delete
```

For production: pipe backups to S3 (AWS_S3_BUCKET already in env).

---

## Phase 6: CI/CD (GitHub Actions — existing workflows)

Existing `.github/workflows/` already has:
1. Build & push backend image to GHCR on push to `main`
2. Deploy dashboard to Vercel

**What needs to be added:**
- Workflow to SSH into server and run `docker compose pull && docker compose up -d` after image push
- Secret: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` (store in GitHub secrets)

```yaml
# Add to existing backend workflow after docker push:
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

---

## Implementation Order

Do these in order — each phase unblocks the next:

1. **[ ] Write consolidated schema** — Merge SQLite tables + new `pending_findings` + `analysis_jobs` into `orchestrator/src/schema.sql`. This is the single migration file used by all services.

2. **[ ] Update events-api** — Replace `better-sqlite3` with `pg`. Test locally with `DATABASE_URL=postgresql://localhost:5432/auditguard`.

3. **[ ] Update static-analysis-service findings store** — Replace in-memory Map with `pending_findings` table. This is the highest-risk ephemeral store (loses findings on restart mid-audit).

4. **[ ] Update fuzzer-service + static-analysis-service job queues** — Replace in-memory job Maps with `analysis_jobs` table.

5. **[ ] Verify docker-compose.prod.yml** — Spin up locally with `docker compose -f docker-compose.prod.yml up`. Confirm schema is applied, backend connects to Postgres, `/api/reports` works.

6. **[ ] Provision server** — Spin up EC2 / VPS. Install Docker, nginx, certbot. Copy `.env`. Start containers.

7. **[ ] Point dashboard to server** — Update `VITE_EVENTS_API_BASE_URL` in Vercel env vars to `https://api.auditguard.xyz`.

8. **[ ] Wire CI/CD auto-deploy** — Add SSH deploy step to GitHub Actions workflow.

9. **[ ] Set up daily backups** — Cron job on server for `pg_dump` → S3.

10. **[ ] Migrate existing data** — Export `data/events.db` SQLite → import to Postgres. Any existing `agents/data/reports/*.md` → insert into `audit_reports` table.

---

## Environment Variables Required on Server

Add to `/opt/auditguard/.env` on the server (in addition to existing Hedera/agent keys):

```bash
# Database (required for production)
DATABASE_URL=postgresql://auditguard:STRONG_PASSWORD@postgres:5432/auditguard
POSTGRES_PASSWORD=STRONG_PASSWORD

# Events API
EVENTS_API_PORT=4000
EVENTS_API_TOKEN=STRONG_RANDOM_TOKEN   # agents use this to POST events

# Disable local-file fallbacks in production
EVENTS_API_REQUIRE_SQLITE=false        # don't fall back to SQLite

# Optional: S3 backup for large report markdown
AWS_S3_BUCKET=auditguard-reports
AWS_REGION=us-east-1
```

---

## What Will NOT Be in the Database

By design, these stay on-chain / on DA — the DB is only a cache:

- **Agent reputation scores** — Always read from `AgentRegistry` contract
- **Job outcomes, bids, payments** — Always read from `AuditAuction` / `PaymentSettlement`
- **Canonical event log** — Hedera HCS (the DB is a queryable index, not the record)
- **iNFT metadata** — 0g Labs DA (CIDs only stored in DB for lookup)

If the database is wiped, it can be fully rebuilt by replaying HCS topics and re-fetching reports from the DA layer.
