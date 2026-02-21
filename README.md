# AuditGuard

Autonomous agent-based smart contract security audit marketplace built on Hedera Hashgraph. Seven TypeScript agents discover contracts, bid in on-chain auctions, perform security analysis, and get paid in GUARD tokens — coordinated through Hedera Consensus Service (HCS) and EVM smart contracts.

---

## Architecture

```mermaid
flowchart TB
    subgraph Blockchain["Hedera Hashgraph"]
        HCS_D["HCS Discovery Topic"]
        HCS_A["HCS Audit Log Topic"]
        HCS_C["HCS Agent Comms Topic"]
        subgraph Contracts["Smart Contracts (HSCS/EVM)"]
            AR[AgentRegistry]
            AA[AuditAuction]
            SA[SubAuction]
            DM[DataMarketplace]
            PS[PaymentSettlement]
            SM[StakingManager]
            TR[Treasury]
            VF[VaultFactory]
            ABV[AuditBudgetVault]
        end
    end

    subgraph Agents["Autonomous Agent Swarm"]
        SC[Scanner Agent]
        STA[Static Analysis Agent]
        FZ[Fuzzer Agent]
        LLM[LLM Contextual Agent]
        DEP[Dependency Agent]
        RPT[Report Agent]
        ALT[Alert Agent]
    end

    ORCH[Orchestrator]
    DASH[Observer Dashboard]
    INFT[iNFT System + 0g DA]

    SC -->|CONTRACT_DISCOVERED| HCS_D
    HCS_D --> ORCH
    ORCH -->|createAuditJob| AA
    ORCH -->|AUCTION_INVITE| HCS_C
    HCS_C --> STA & FZ & LLM
    STA & FZ & LLM -->|submitBid| AA
    STA & FZ & LLM -->|BID_SUBMITTED| HCS_A
    AA -->|WinnersSelected| ORCH
    STA & FZ & LLM -->|FINDINGS_SUBMITTED| HCS_C
    HCS_C --> RPT
    RPT -->|REPORT_PUBLISHED| HCS_C
    LLM -->|SUB_AUCTION_POSTED| HCS_C
    HCS_C --> DEP
    DEP -->|SUB_RESULT_DELIVERED| HCS_C
    STA -->|createListing| DM
    FZ -->|purchaseData| DM
    ORCH -->|settleJob| PS
    PS --> TR
    HCS_A --> ALT
    ALT -->|ALERT_FIRED| HCS_A
    ORCH --> INFT
    HCS_D & HCS_A & HCS_C --> DASH
    AA & AR & PS --> DASH
```

---

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- **Docker** (optional — needed only for local Postgres; report persistence works without it)
- A funded **Hedera testnet account** with ECDSA private key

---

## Environment Setup

```bash
cp .env.example .env
```

Open `.env` and fill in the required private keys. All account IDs are pre-populated with testnet values. At minimum you need:

| Variable | Required for |
|----------|-------------|
| `OPERATOR_PRIVATE_KEY` | Orchestrator, contract calls |
| `HEDERA_PRIVATE_KEY` | Contract deployment, HTS token ops |
| `STATIC_PRIVATE_KEY` / `FUZZER_PRIVATE_KEY` / `LLM_PRIVATE_KEY` | Individual agents |
| `SCANNER_PRIVATE_KEY` | Scanner agent |

Leave everything else at the defaults in `.env.example` for local dev.

---

## Install Dependencies

```bash
npm install
```

This installs all workspace dependencies (agents, orchestrator, dashboard, events-api, inft).

If `packages/events-api` dependencies are missing after the workspace install (known npm hoisting issue with native modules):

```bash
npm install --prefix packages/events-api
```

---

## Full Dev Stack

### Option A — Skip preflight (fastest, use for local dev)

Starts: dashboard · orchestrator · all 7 agents · iNFT listeners · events-api

```bash
npm run dev:all:unsafe
```

Ports assigned:
| Service | Port |
|---------|------|
| Dashboard (Vite) | 5173 |
| Events API (SQLite) | 4000 |
| Reports endpoints (`/api/reports`) | 4000 |

### Option B — Full preflight + live agent verification (production-like)

Runs preflight checks, activates and verifies live agents on Hedera testnet, then starts the full stack:

```bash
npm run dev:all
```

### Stop everything

```bash
npm run stop:all
```

---

## Starting Services Individually

### Dashboard only

```bash
npm --prefix packages/dashboard run dev
```

### Orchestrator only

```bash
npm run orchestrator
```

### All agents (supervisor — auto-restarts failed agents)

```bash
npm run agents
```

### Individual agent

```bash
npm --workspace agents run scanner
npm --workspace agents run static
npm --workspace agents run fuzzer
npm --workspace agents run llm
npm --workspace agents run dependency
npm --workspace agents run report
npm --workspace agents run alert
```

### Events API (SQLite — port 4000)

```bash
node packages/events-api/src/index.js
```

### iNFT listeners

```bash
npm run inft:listen          # discovery listener
npm run inft:listen:events   # event listener
```

### Backend only (no dashboard)

```bash
npm run dev:backend
```

---

## Report Persistence (PostgreSQL)

The report generation pipeline writes audit reports to PostgreSQL after each `WinnersSelected` on-chain event. Without a `DATABASE_URL`, report writes are silently skipped (orchestrator logs a warning) — the system won't crash.

### 1. Start a local Postgres instance

```bash
docker run -d --name pg-local \
  -e POSTGRES_USER=auditguard \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=auditguard \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Add to `.env`

```
DATABASE_URL=postgresql://auditguard:dev@localhost:5432/auditguard
```

### 3. Run the schema migration (one-time)

```bash
psql "$DATABASE_URL" -f orchestrator/src/schema.sql
```

### 4. Verify reports route on the Events API (port 4000)

```bash
curl "http://localhost:4000/api/reports?deployer=0x0000000000000000000000000000000000000000"
```

### S3 (optional — local dev skips it)

Leave `AWS_S3_BUCKET` unset. When unset, the markdown content is omitted from the DB record and the "Show Preview" in the dashboard will show a placeholder. Set the following for production:

```
AWS_S3_BUCKET=auditguard-reports
AWS_REGION=us-east-1
```

---

## First-Time Deployment (Hedera Testnet)

Only needed when starting from scratch or after a contract upgrade:

```bash
# Deploy GUARD HTS token
npm run deploy:token

# Deploy all EVM smart contracts
npm run deploy:contracts

# Create HCS topics
npm run setup:hcs

# Fund agent accounts with HBAR + GUARD
npm run fund:agents
```

Deployed addresses and topic IDs are written to `packages/sdk/config.json` automatically.

---

## Testing

```bash
# Recommended dev test suite (fastest)
npm run dev:test

# Contract tests (Hardhat)
npm run test

# All test suites
npm run test:all

# Individual suites
npm --workspace agents run test           # Agent vitest
npm --workspace agents run test:invite    # Auction invite flow
npm --prefix orchestrator run test:mocks  # Orchestrator mock tests
npm --prefix orchestrator run test:offline
npm --prefix packages/dashboard test      # Dashboard tests
```

---

## Project Structure

```
AuditGuard/
├── agents/                  # 7 autonomous TypeScript agents
│   ├── scanner/
│   ├── static-analysis/
│   ├── fuzzer/
│   ├── llm-contextual/
│   ├── dependency/
│   ├── report/
│   ├── alert/
│   └── shared/              # HCS client, contract client, message types
├── orchestrator/            # Central coordination service (JS/ESM)
│   └── src/
│       ├── orchestrator.js  # Main state machine
│       ├── report-writer.js # Markdown generation + DB persistence hook
│       └── schema.sql       # PostgreSQL DDL — run once
├── packages/
│   ├── contracts/           # Solidity smart contracts (Hardhat)
│   ├── dashboard/           # React 18 + Vite + TailwindCSS observer UI
│   ├── events-api/          # Express + SQLite event persistence (port 4000)
│   ├── inft/                # 0g Labs DA layer, iNFT minting
│   └── sdk/
│       ├── config.json      # Single source of truth: contract addresses, topic IDs
│       └── db/
│           ├── report-db.js    # PostgreSQL + S3 report persistence
│           └── report-types.js # StoredAuditReport schema + helpers
└── scripts/                 # Deployment and utility scripts
```

---

## Key Config

`packages/sdk/config.json` — all deployed contract addresses, HCS topic IDs, and iNFT collection IDs. Updated automatically on deploy. Never hardcode addresses; always read from this file.

### HCS Topics

| Topic | ID | Purpose |
|-------|----|---------|
| Discovery | `0.0.7940144` | Contract discovery events |
| Audit Log | `0.0.7940145` | Findings, reports, alerts |
| Agent Comms | `0.0.7940146` | Invites, bids, heartbeats, sub-contracting |

### GUARD Token

HTS fungible token — **8 decimal places** (not 18). Always use `parseUnits(amount, 8)` in scripts and frontend. Token ID: `0.0.7977433`.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Blockchain | Hedera Hashgraph (HTS, HCS, HSCS/EVM) |
| Smart Contracts | Solidity 0.8.24 / Hardhat |
| Agents | TypeScript / Node.js 20 / tsx |
| Orchestrator | JavaScript / ES Modules |
| Dashboard | React 18 / Vite / TailwindCSS / Zustand / Framer Motion |
| Events API | Express / better-sqlite3 + reports routes |
| Reports Storage | PostgreSQL (pg) |
| iNFT | 0g Labs DA layer (`@0gfoundation/0g-ts-sdk`) |
| Hosting | Vercel (dashboard) · AWS EC2 Docker (backend) |

---

## Deployment

- **Dashboard**: Deployed to Vercel via `.github/workflows/deploy-dashboard-vercel.yml`
- **Backend (orchestrator + agents + events-api)**: AWS EC2 via Docker/GHCR — `.github/workflows/ghcr-build-devall.yml`
- **Reports API**: Served by `packages/events-api` on port 4000 (`/api/reports`). Set `DATABASE_URL` in the EC2 runtime env.
- Full runbook: `docs/DOCKER_AWS_EC2_GHCR_RUNBOOK.md`

---

## Known Deferred Items

- Signature verification for agent PONG messages
- Persistent orchestrator roster/cache (currently in-memory only)
- `StakingManager.propagateSlash` → `DelegatedStaking` wiring requires manual relay
