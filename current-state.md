# AuditGuard — Current State (April 2026)

## Project Status: Transitioning from Hackathon → Production

The core pipeline is working end-to-end on Hedera testnet. Infrastructure is functional but built for demo/development — not production hardened. This document captures what exists, what works, what's broken, and what needs to be done.

---

## Architecture Overview

```
                        ┌─────────────────────────────────┐
                        │         Hedera Testnet           │
                        │  AgentRegistry | AuditAuction   │
                        │  PaymentSettlement | BudgetVault │
                        │  DataMarketplace | AuditScheduler│
                        │       HCS Topics (3)             │
                        └──────────────┬──────────────────┘
                                       │
               ┌───────────────────────┼──────────────────────┐
               │                       │                      │
        ┌──────▼──────┐       ┌────────▼────────┐    ┌───────▼──────┐
        │ Orchestrator │       │     Agents (7)   │    │  iNFT Layer  │
        │(orchestrator/│       │  (agents/ tsx)   │    │(packages/inft│
        │  src/index.js│       │                  │    │   nodejs)    │
        └──────┬───────┘       └────────┬─────────┘    └──────────────┘
               │                        │
               │               ┌────────▼─────────┐
               │               │ Microservices     │
               │               │ static-analysis   │ :4002
               │               │ fuzzer-service    │ :4001
               │               └────────┬─────────┘
               │                        │
               └────────────┬───────────┘
                            │
                    ┌───────▼────────┐
                    │  events-api    │ :4000
                    │  (Express +    │
                    │  SQLite/PG)    │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │   Dashboard    │
                    │  (React/Vite)  │
                    └────────────────┘
```

---

## Services & Their Current State

### Smart Contracts (packages/contracts/)
- **Status:** ✅ Fully deployed on Hedera testnet
- **Contracts deployed:**
  - `AgentRegistry` — agent profiles, reputation, staking
  - `AuditAuction` — job lifecycle, bids, winner selection
  - `PaymentSettlement` — agent payment distribution
  - `AuditBudgetVault` — escrow management
  - `DataMarketplace` — report listings
  - `AuditScheduler` — recurring audit jobs
- **All addresses in:** `packages/sdk/config.json`
- **Known issues:**
  - `getActiveJobs()` reverts on Hedera RPC when >600 active jobs (return payload too large)
  - Reconcile skips gracefully but winner selection backlog accumulates

### Orchestrator (orchestrator/src/)
- **Status:** ✅ Working — creates auctions, selects winners, settles payments
- **Tech:** Node.js ESM, ethers v6, @hashgraph/sdk
- **Key fix applied:** Gas price override (`patchProviderFeeData`) forces legacy type-0 txs at 1111 gwei — Hedera's EIP-1559 fee history returns near-zero baseFee which would cause silent reverts
- **Persistence:** Writes reports to PostgreSQL when `DATABASE_URL` is set; local files otherwise
- **Known issues:**
  - Must be restarted after any code change (no hot reload)
  - Nonce races on concurrent `selectWinners` (auto-retries 3x)
  - `getActiveJobs()` failure causes reconcile skip (benign but degrades over time)

### Agents (agents/ — 7 agents)

| Agent | Status | Notes |
|-------|--------|-------|
| `scanner-001` | ✅ Working | Discovers contracts via Hedera mirror node every 15s |
| `static-analysis-047` | ✅ Working | Slither/Aderyn/Semgrep; posts findings to store |
| `fuzzer-012` | ✅ Working | ItyFuzz/Mythril; bids but currently uses mock findings |
| `llm-contextual-003` | ✅ Working | 0g serving broker (qwen-2.5-7b); Claude fallback |
| `dependency-analyzer-008` | ✅ Working | Supply chain analysis |
| `report-aggregator-001` | ✅ Working (bug fixed) | 120s aggregation window; writes MD to `agents/data/reports/` |
| `alert-sentinel-001` | ✅ Working | Webhook notifications |

- **Manager:** `agents/run-all.ts` — launches all 7 agents with health monitoring and auto-restart
- **Critical bug fixed:** Duplicate `run-all.ts` instances caused two report agents to race on findings store — first run fetched and deleted findings, second wrote empty report. Fixed with `aggregating` mutex flag in report agent.
- **IMPORTANT:** Always check for stale processes before starting: `ps aux | grep run-all`

### Microservices
| Service | Port | Persistence | Status |
|---------|------|-------------|--------|
| `events-api` | 4000 | SQLite (`data/events.db`) + Postgres | ✅ Working |
| `static-analysis-service` | 4002 | In-memory (ephemeral) | ✅ Working |
| `fuzzer-service` | 4001 | In-memory (ephemeral) | ✅ Working |

### Dashboard (packages/dashboard/)
- **Status:** ✅ Working in dev mode
- **Tech:** React 18, Vite, Zustand, TailwindCSS
- **Not yet deployed** to production hosting

### iNFT Layer (packages/inft/)
- **Status:** ✅ Collections deployed, listener working
- **Collections:** AG-JOB (`0.0.7946509`), AG-AGENT (`0.0.7946510`), AG-HEALTH (`0.0.7946511`)
- **Storage:** 0g Labs DA (Galileo V3 testnet, chain ID 16602)

---

## Data Persistence — Current Reality

| Data | Where It Lives | Durable? | Lost On? |
|------|---------------|----------|----------|
| Agent registry, reputation, staking | Hedera contracts | ✅ Permanent | Never |
| Job lifecycle, bids, winners | Hedera contracts | ✅ Permanent | Never |
| Payment history | Hedera contracts | ✅ Permanent | Never |
| HCS messages (all events) | Hedera HCS topics | ✅ Permanent | Never |
| Audit reports (markdown) | `agents/data/reports/<jobId>.md` | ⚠️ Local file | Server restart / redeploy |
| Audit reports (DB) | PostgreSQL via events-api | ✅ Durable | Only if DB wiped |
| Audit events log | SQLite `data/events.db` | ⚠️ Local file | Server restart / redeploy |
| Findings during aggregation | In-memory (static-analysis-service) | ❌ Ephemeral | Process restart |
| Fuzzer job queue | In-memory (fuzzer-service) | ❌ Ephemeral | Process restart |
| iNFT metadata | 0g Labs DA | ✅ Durable | Never (DA guarantee) |

---

## Deployed Addresses (Hedera Testnet)

All in `packages/sdk/config.json`. Key ones:

| Contract | Address |
|---------|---------|
| AuditAuction | `0x8D186E672026FE39FE3265f9737D8884B4A18604` |
| AgentRegistry | See config.json |
| PaymentSettlement | See config.json |
| AuditBudgetVault | See config.json |
| DataMarketplace | See config.json |
| AuditScheduler | `0x67d67c1c721241f9350d3eca0c0a1b6d53e69860` |

**HCS Topics:**
- Discovery: `0.0.7940144`
- Audit Log: `0.0.7940145`
- Agent Comms: `0.0.7940146`

**Test Contracts:**
- VulnerableVault1: `0x0c5a2d6380F8f5E53A5b1C99c0FEE51d46834162`
- VulnerableVault2: `0x57b2bc29B5dce8257F9536D7DcC46f41d495690E`
- VulnerableVault3: `0xfAd7C68ABB535f866aA9852158BE2a16A3f572A0`

---

## Docker / Deployment Files (Exist But Untested)

The following Docker infrastructure exists but was built for the hackathon and has **not been tested in production**:

| File | Purpose | Status |
|------|---------|--------|
| `Dockerfile` | Multi-stage backend build | Exists, untested |
| `docker-compose.yml` | Local dev (events-api + orchestrator + agents) | Exists, untested |
| `docker-compose.prod.yml` | Prod (Postgres + backend image) | Exists, untested |
| `.github/workflows/` | Deploy dashboard to Vercel + push image to GHCR | Exists, partially configured |

---

## Existing PostgreSQL Schema (orchestrator/src/schema.sql)

```sql
CREATE TABLE audit_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  contract_address TEXT,
  deployer_address TEXT,
  hedera_account_id TEXT,
  chain TEXT,
  contract_type TEXT,
  md_content TEXT,
  s3_key TEXT,
  cid TEXT,
  agent_addresses TEXT[],
  agent_count INTEGER,
  finding_count INTEGER,
  findings_by_severity JSONB,
  timestamp BIGINT,
  tags TEXT[],
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

SQLite `audit_events` table also exists in `data/events.db` — this needs to be migrated to Postgres for production.

---

## Known Bugs & Limitations

1. **`getActiveJobs()` RPC overflow** — 600+ active on-chain jobs cause Hedera RPC to fail returning the list. Reconcile skips. Long-term: clean up stale jobs or paginate.
2. **Fuzzer uses mock findings** — The fuzzer agent bids and wins auctions but `ItyFuzz`/`Mythril` require native tool installs not present in dev environment.
3. **LLM agent requires valid ANTHROPIC_API_KEY** — Currently falls back to mock analysis when key is missing/invalid.
4. **HCS event relay returns 401** — The Cloudflare Worker event relay is not configured. All `HCSClient Event relay publish failed` warnings are cosmetic — real HCS publishing works fine.
5. **Duplicate `run-all.ts` processes** — Multiple terminal starts without `npm run stop:all` first creates duplicate agent instances. Always verify with `ps aux | grep run-all`.
6. **Local-only report files** — Without `DATABASE_URL` set, reports only live in `agents/data/reports/` and are lost on redeploy.
7. **SQLite events DB** — `data/events.db` is local-only and not replicated.

---

## What Works End-to-End (Verified April 6, 2026)

1. ✅ Scanner discovers new contracts on Hedera testnet (15s polling)
2. ✅ Orchestrator creates on-chain auction jobs for discovered contracts
3. ✅ Agents receive invites via HCS, bid on auctions
4. ✅ Winner selection happens on-chain after auction deadline
5. ✅ Winning agent runs static analysis on contract source (via Sourcify)
6. ✅ Findings posted to static-analysis-service store
7. ✅ Report agent aggregates findings after 120s window
8. ✅ Markdown report written to `agents/data/reports/<jobId>.md`
9. ✅ Report posted to events-api `/api/reports` endpoint (when running)
10. ✅ Gas price fix working — legacy type-0 txs at 1111 gwei succeed

---

## How to Start (Current Dev Setup)

```bash
# Terminal 1 — Backend services
npm run fuzzer:service &
npm run static-analysis:service &
cd packages/events-api && npm start &

# Terminal 2 — Orchestrator
npm run orchestrator >> /tmp/ag-orchestrator.log 2>&1 &

# Terminal 3 — Agents
cd agents && npm run all >> /tmp/ag-agents.log 2>&1 &

# Monitor
tail -f /tmp/ag-orchestrator.log
tail -f /tmp/ag-agents.log
```

Or all at once: `npm run dev:backend`
