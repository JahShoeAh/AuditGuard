# AuditGuard

Autonomous agent-based smart contract security audit marketplace on Hedera Hashgraph. Seven TypeScript agents discover contracts, bid in on-chain auctions, run static analysis and fuzz testing, and get paid in GUARD tokens — coordinated through Hedera Consensus Service (HCS) and EVM smart contracts.

---

## Architecture

```
Hedera Testnet (AgentRegistry, AuditAuction, PaymentSettlement, ...)
        │
        ├── Orchestrator        — auction lifecycle, winner selection, payment settlement
        ├── 7 Agents            — scanner, static-analysis, fuzzer, llm, dependency, report, alert
        ├── Microservices       — static-analysis-service (:4002), fuzzer-service (:4001)
        ├── Events API          — Express + PostgreSQL (:4000)
        └── Dashboard           — React/Vite frontend
```

All deployed contract addresses and HCS topic IDs live in `packages/sdk/config.json`.

---

## Prerequisites

- Node.js v20+
- npm v10+
- A Hedera testnet account with HBAR balance
- Python 3 + pip (for local analysis tools — skip if using Docker)
- Docker + Docker Compose (for containerised dev/prod)

---

## Local Development (no Docker)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required fields in `.env`:

| Variable | Description |
|----------|-------------|
| `HEDERA_PRIVATE_KEY` | Hedera testnet operator private key (ECDSA) |
| `OPERATOR_PRIVATE_KEY` | Same as above (orchestrator uses this) |
| `STATIC_PRIVATE_KEY` … `ALERT_PRIVATE_KEY` | Per-agent Hedera keys (can reuse operator for dev) |
| `DATABASE_URL` | `postgresql://auditguard:dev@localhost:5432/auditguard` |
| `POSTGRES_PASSWORD` | `dev` (matches above) |
| `ANTHROPIC_API_KEY` | Optional — enables Claude report enrichment |
| `ZG_PRIVATE_KEY` | Optional — enables 0g LLM inference for the LLM agent |

Everything else in `.env.example` has sensible defaults for testnet dev.

### 3. Start PostgreSQL

```bash
# Option A — Docker (easiest)
docker compose up postgres -d

# Option B — local Postgres, create DB manually:
createdb auditguard
psql auditguard < orchestrator/src/schema.sql
```

### 4. Start the full backend

```bash
npm run dev:backend
```

This starts: orchestrator, all 7 agents, iNFT listeners, fuzzer-service (:4001), static-analysis-service (:4002), and events-api (:4000).

To also start the React dashboard:

```bash
npm run dev:all:unsafe   # backend + dashboard (skips preflight)
npm run dev:all          # backend + dashboard + live-agent preflight checks
```

### 5. Start the dashboard only (separate terminal)

```bash
npm --prefix packages/dashboard run dev
```

Dashboard runs at `http://localhost:5173`.

### 6. Individual services

```bash
npm run orchestrator                          # Orchestrator only
npm run agents                                # All 7 agents (run-all.ts supervisor)
npm run static-analysis:service               # Static analysis service (:4002)
npm run fuzzer:service                        # Fuzzer service (:4001)
npm --prefix packages/events-api run dev      # Events API (:4000)

# Individual agents
npm --workspace agents run scanner
npm --workspace agents run static
npm --workspace agents run fuzzer
npm --workspace agents run llm
npm --workspace agents run dependency
npm --workspace agents run report
npm --workspace agents run alert
```

### 7. Stop everything

```bash
npm run stop:all
```

---

## Docker (local compose)

Runs Postgres + all backend services in containers. Requires `.env` with `POSTGRES_PASSWORD=dev`.

```bash
# Start everything
docker compose up

# Or build first if you've made code changes
docker compose up --build

# Tail logs
docker compose logs -f

# Stop
docker compose down
```

The compose file builds the backend from local source (`Dockerfile`). The dashboard is not included in the backend image — run it locally with `npm --prefix packages/dashboard run dev` pointed at `http://localhost:4000`.

---

## Testing

```bash
# Recommended dev suite (fast, no Hedera needed)
npm run dev:test

# Full suite (includes Hardhat contract tests)
npm run test:all

# Individual suites
npm run test                                  # Hardhat contract tests
npm --workspace agents run test               # Agent vitest tests
npm --workspace agents run test:invite        # Auction invite flow
npm --prefix orchestrator run test:mocks      # Orchestrator mock tests
npm --prefix orchestrator run test:offline    # Orchestrator offline flow
npm --prefix packages/dashboard test          # Dashboard tests
```

---

## First-time setup (testnet, run once)

These scripts wire contracts together and only need to run once per deployment.

```bash
# Deploy GUARD token + smart contracts (skip if already deployed — see packages/sdk/config.json)
npm run deploy:token
npm run deploy:contracts
npm run setup:hcs

# Wire contract dependencies
npm run wire:delegated-staking   # Points StakingManager at DelegatedStaking
npm run setup:treasury           # Wires Treasury fee splits

# Fund agent accounts with HBAR + GUARD
npm run fund:agents
```

---

## Production Build

### Build flow

1. Push to `main` → GitHub Actions builds `Dockerfile.devall` and pushes to GHCR:
   ```
   ghcr.io/<owner>/<repo>-devall:sha-<commit>
   ghcr.io/<owner>/<repo>-devall:latest
   ```

2. Deploy to EC2 → Actions → **"Deploy Backend to EC2"** → enter the image tag from step 1.

3. Deploy dashboard → Actions → **"Deploy Dashboard to Vercel"** → Run workflow.

### GitHub Secrets required

**Backend (EC2):**

| Secret | Description |
|--------|-------------|
| `EC2_HOST` | EC2 public IP or hostname |
| `EC2_USERNAME` | SSH user (e.g. `ubuntu`) |
| `EC2_SSH_KEY` | PEM private key content |
| `EC2_PORT` | SSH port (default `22`) |
| `EC2_ENV_FILE` | Path to `.env` on EC2 (default `/opt/auditguard/.env`) |
| `EC2_CONTAINER_NAME` | Legacy container name to stop before deploy |
| `GHCR_USERNAME` | GitHub username for GHCR pull |
| `GHCR_READ_TOKEN` | GitHub PAT with `read:packages` scope |

**Dashboard (Vercel):**

| Secret | Description |
|--------|-------------|
| `VERCEL_TOKEN` | Vercel deploy token |
| `VERCEL_ORG_ID` | Vercel org ID |
| `VERCEL_PROJECT_ID` | Vercel project ID |
| `VITE_EVENTS_API_BASE_URL` | Public URL of the events-api (e.g. `https://api.auditguard.xyz`) |
| `VITE_API_BASE_URL` | Same as above or a separate base URL |

### EC2 server requirements

The EC2 instance needs:
- Docker + Docker Compose v2 installed
- `/opt/auditguard/.env` with all required variables including `POSTGRES_PASSWORD`

### Manual deploy to EC2

If you want to deploy without GitHub Actions (e.g. for the first time):

```bash
# On the EC2 host
IMAGE=ghcr.io/<owner>/<repo>-devall:latest \
ENV_FILE=/opt/auditguard/.env \
COMPOSE_FILE=/opt/auditguard/docker-compose.prod.yml \
SCHEMA_FILE=/opt/auditguard/schema.sql \
bash scripts/ec2/run-devall-container.sh
```

The script:
1. Stops any legacy container with `EC2_CONTAINER_NAME`
2. Pulls the image from GHCR
3. Runs `docker compose up -d` with `docker-compose.prod.yml`
4. Postgres schema is applied automatically on first boot

### docker-compose.prod.yml

Uses two services: `postgres` (data volume `pg_data`) and `backend` (the GHCR image). Report files are persisted on a `report_files` named volume at `/app/agents/data/reports`.

```bash
# Check running containers
docker compose -p auditguard -f docker-compose.prod.yml ps

# View logs
docker compose -p auditguard -f docker-compose.prod.yml logs -f backend

# Restart backend only
docker compose -p auditguard -f docker-compose.prod.yml restart backend
```

---

## Environment variable reference

See `.env.example` for the full list with documentation. Key variables:

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `HEDERA_PRIVATE_KEY` | Yes | — | Operator ECDSA key |
| `DATABASE_URL` | Yes (prod) | — | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Yes (Docker) | — | Must match `DATABASE_URL` |
| `ANTHROPIC_API_KEY` | No | — | Enables Claude report enrichment |
| `ZG_PRIVATE_KEY` | No | — | Enables 0g LLM inference |
| `DISCORD_WEBHOOK_URL` | No | — | Alert agent webhook |
| `EVENT_RELAY_URL` | No | — | HCS event relay mirror |
| `ORCHESTRATOR_WINNER_WAIT_MS` | No | `120000` | Auction window (ms) |

---

## Project layout

```
├── agents/                    — 7 TypeScript agents + run-all.ts supervisor
│   ├── scanner/
│   ├── static-analysis/
│   ├── fuzzer/
│   ├── llm-contextual/
│   ├── dependency/
│   ├── report/
│   ├── alert/
│   └── shared/                — HCS client, contract client, message types
├── orchestrator/src/          — Auction lifecycle coordinator (Node.js ESM)
├── packages/
│   ├── contracts/             — 15 Solidity contracts (Hardhat)
│   ├── dashboard/             — React 18 + Vite frontend
│   ├── events-api/            — Express + PostgreSQL REST API (:4000)
│   ├── static-analysis-service/ — Slither + Semgrep runner (:4002)
│   ├── fuzzer-service/        — Mythril fuzz runner (:4001)
│   ├── inft/                  — 0g Labs DA iNFT layer
│   └── sdk/                   — Shared config (config.json = source of truth)
├── scripts/                   — Deployment + utility scripts
├── Dockerfile                 — Local compose image (multi-service)
├── Dockerfile.devall          — Production image (CI/CD, includes Python analysis tools)
├── docker-compose.yml         — Local dev compose
└── docker-compose.prod.yml    — Production compose (postgres + backend image)
```
