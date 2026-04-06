# AuditGuard — Current State (April 2026)

## Project Status: Transitioning from Hackathon → Production

The core pipeline is working end-to-end on Hedera testnet. Infrastructure is functional but built for demo/development — not production hardened. This document captures what exists, what works, what's broken, and what needs to be done.

---

## Incomplete / Broken Features — Priority Table

| Priority | Feature | Status | Effort | Impact |
|----------|---------|--------|--------|--------|
| ✅ P0 | StakingManager ↔ DelegatedStaking wiring | **DONE** — orchestrator slash relay + `wire-delegated-staking.js` script | — | Run `npm run wire:delegated-staking` once |
| ✅ P0 | Static analysis service real runners | **DONE** — slither+semgrep in Dockerfile, Sourcify source fetch | — | Deploy new image; sources auto-fetched |
| ✅ P0 | Treasury contract wiring | **DONE** — Treasury/StakingManager/DelegatedStaking in ContractClient + `setup-treasury.js` | — | Run `npm run setup:treasury` once |
| ✅ P0 | Events API schema + routes | **DONE** — audit_jobs + registered_agents tables + GET/POST routes | — | Deploy + run schema migration |
| ✅ P1 | Report agent → PostgreSQL persistence | **DONE** — report agent POSTs to `/api/reports` on events-api | — | Already implemented |
| ✅ P1 | iNFT mint triggers | **DONE** — `mintAuditJobNFT`/`mintAgentProfileNFT`/`mintContractHealthNFT` added to InftBridge + wired in orchestrator | — | No-op if credentials not set |
| ✅ P1 | DataMarketplace — fuzzer listings | **DONE** — `createListing()` + `DATA_LISTING_CREATED` added to fuzzer `simulateAuditCycle` | — | Mirrors static-analysis pattern |
| ✅ P2 | AuditScheduler — UI + API routes | **DONE** — `/api/schedules` routes + AuditSchedules dashboard sub-tab | — | — |
| ✅ P2 | GuardExchange + HbarPool integration | **DONE** — ABIs loaded in ContractClient + ExchangeWidget dashboard sub-tab | — | — |
| ✅ P2 | VaultFactory integration | **DONE** — VaultCreated/AutoAuditTriggered wired + `/api/vaults` routes + VaultPanel dashboard | — | — |
| ✅ P3 | Fuzzer mock findings flag | **DONE** — `isMock: true` on all mock findings; severity counts zeroed in HCS + orchestrator | — | — |
| ✅ P3 | Dashboard placeholder pages | **N/A** — all pages were already implemented; VaultPanel + ExchangeWidget added in P2 | — | — |

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
                    │  PostgreSQL)   │
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
  - `GuardExchange` — GUARD/HBAR AMM swap ✅ integrated in ContractClient + ExchangeWidget
  - `HbarPool` — fixed-rate HBAR→GUARD converter ✅ integrated in ContractClient
  - `VaultFactory` — audit vault creation ✅ VaultCreated/AutoAuditTriggered wired + VaultPanel
  - `Treasury` — fee distribution ✅ loaded in ContractClient + setup script
  - `StakingManager` — agent staking ✅ `propagateSlash` relay wired via orchestrator
  - `DelegatedStaking` — delegator slash propagation ✅ pointed at StakingManager via wire script
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
| `static-analysis-047` | ✅ Working (⚠️ mock) | Calls static-analysis-service; falls back to mock if runners not installed |
| `fuzzer-012` | ✅ Working (⚠️ mock) | Calls fuzzer-service; always falls back to `generateFindings()` if no tools installed |
| `llm-contextual-003` | ✅ Working | 0g serving broker (qwen-2.5-7b); Claude fallback |
| `dependency-analyzer-008` | ✅ Working | Supply chain analysis |
| `report-aggregator-001` | ✅ Working | 120s aggregation window; writes MD to `agents/data/reports/` — not yet persisted to PG |
| `alert-sentinel-001` | ✅ Working | Webhook notifications |

- **Manager:** `agents/run-all.ts` — launches all 7 agents with health monitoring and auto-restart
- **Critical bug fixed:** Duplicate `run-all.ts` instances caused two report agents to race on findings store — fixed with `aggregating` mutex flag
- **IMPORTANT:** Always check for stale processes before starting: `ps aux | grep run-all`

### Microservices

| Service | Port | Persistence | Status |
|---------|------|-------------|--------|
| `events-api` | 4000 | PostgreSQL (`audit_events`, `bid_skips`) + in-memory fallback | ✅ Working |
| `static-analysis-service` | 4002 | PostgreSQL (`pending_findings`) + in-memory fallback | ✅ Working (⚠️ runners stubbed) |
| `fuzzer-service` | 4001 | In-memory (job queue — short-lived, deferred) | ✅ Working (⚠️ tools not installed) |

### Dashboard (packages/dashboard/)
- **Status:** ✅ Working in dev mode; CI/CD ready for Vercel
- **Tech:** React 18, Vite, Zustand, TailwindCSS
- **Tabs:** Live Feed, Agents, Contracts, Analytics (Network/Timeline/Competition), Schedules (Schedules/Vaults/Exchange)
- **All pages implemented:** agent registration, stake delegation, report marketplace, contract health

### iNFT Layer (packages/inft/)
- **Status:** ✅ Collections deployed, mint triggers wired in orchestrator
- **Collections:** AG-JOB (`0.0.7946509`), AG-AGENT (`0.0.7946510`), AG-HEALTH (`0.0.7946511`)
- **Storage:** 0g Labs DA (Galileo V3 testnet, chain ID 16602)
- **Mint triggers:** `mintAuditJobNFT()` on job creation, `mintAgentProfileNFT()` on agent registration, `mintContractHealthNFT()` on first contract audit — all no-ops if 0g credentials not configured

---

## Incomplete Feature Detail

### P0 — StakingManager ↔ DelegatedStaking
- `StakingManager.propagateSlash()` calls `IDelegatedStaking.propagateSlash()` (line 577) wrapped in a try/catch — fails silently
- Root cause: StakingManager was deployed before `setDelegatedStaking()` setter existed in the ABI
- DelegatedStaking deployed in a later phase but StakingManager can never be pointed at it
- **Options:** (A) upgrade StakingManager via proxy, (B) deploy mediator wrapper, (C) manual EOA relay

### P0 — Static Analysis Service Runners
- `packages/static-analysis-service/src/runners/` has `slither.js`, `aderyn.js`, `semgrep.js` — implementation is minimal
- Service expects `sourceDir` to be passed in — never fetches source from Etherscan/Sourcify automatically
- Without tools installed + source available, all static analysis is mock data
- Static analysis agent falls back to `generateFindings()` when service returns empty

### P0 — Treasury Contract
- Deployed at `0xC4736e92fbd50663b0C1bd68d7Bf6cdC1FC04D9e`
- Never instantiated in `orchestrator/src/contract-client.js`
- `config.json` `day3` section defines slash rates and fee splits that never flow to the contract
- Payment settlement bypasses treasury entirely

### P0 — Events API Schema Gap
- Current tables: `audit_reports`, `audit_events`, `bid_skips`, `pending_findings`
- Missing tables: `jobs`, `agents`, `staking_events`, `slash_events`, `schedules`
- Dashboard falls back to querying HCS and on-chain RPC directly because the API doesn't cache agent/job state

### P1 — Report Agent → PostgreSQL
- Reports written to `agents/data/reports/<jobId>.md` (filesystem)
- `report_files` Docker volume mounts this directory — survives container restart
- But reports are not inserted into `audit_reports` table by the report agent itself (only orchestrator inserts via `report-db.js` after settlement)
- Dashboard can't retrieve a report until orchestrator settlement runs

### P1 — iNFT Mint Triggers
- `inft-bridge.js` only exposes `updateReputation()` and `markJobCompleted()`
- No calls to `mintAuditJobNFT()` when `createAuditJob()` succeeds
- No calls to `mintAgentProfileINFT()` when `AgentRegistered` event fires
- No calls to `mintContractHealthNFT()` on first successful audit of a contract
- `AGENT_SERIALS_JSON` and `JOB_SERIALS_JSON` env vars must be populated manually

### P1 — DataMarketplace Fuzzer Listings
- Static analysis agent calls `createListing()` after findings submission ✅
- Fuzzer agent subscribes to `DATA_LISTING_CREATED` but never calls `createListing()` ❌
- Dashboard `ReportMarketplace.jsx` pulls from `/api/marketplace/listings` (PG cache) — no on-chain reconciliation

### P2 — AuditScheduler UI + Routes
- Contract loaded in orchestrator, `AuditTriggered` event is listened to
- No events-api routes: `POST /scheduler/schedule`, `GET /scheduler/schedules/:contract`
- No dashboard UI for contract owners to create/manage schedules
- Vault creation flow has no hook into scheduler

### P2 — GuardExchange + HbarPool
- GuardExchange: `0xD6133Edab4D08D2a66f604217B36E342bc4338B7` — `buyGuard()`, `sellGuard()` implemented
- HbarPool: `0x9102Dc653a0F148B5a8FFbc6a9b2247E596c9CD5` — `hbarToGuard()`, `guardToHbar()` implemented
- Zero references in ContractClient, orchestrator, agents, or dashboard

### P2 — VaultFactory
- Deployed at `0xf8EdB1F55894F6b196245f4a46bDe9e4fb04a750`
- In config.json; never called anywhere
- Intended to let contract owners create escrow vaults for audit budgets

### P3 — Fuzzer Mock Findings
- `generateFindings()` in `agents/fuzzer/index.ts` creates synthetic findings with random severity
- No metadata flag distinguishing real fuzzer output from mock
- Mock findings affect reputation scoring in `PaymentSettlement`

---

## Data Persistence — Current Reality

| Data | Where It Lives | Durable? | Lost On? |
|------|---------------|----------|----------|
| Agent registry, reputation, staking | Hedera contracts | ✅ Permanent | Never |
| Job lifecycle, bids, winners | Hedera contracts | ✅ Permanent | Never |
| Payment history | Hedera contracts | ✅ Permanent | Never |
| HCS messages (all events) | Hedera HCS topics | ✅ Permanent | Never |
| Audit reports (markdown) | `agents/data/reports/<jobId>.md` + Docker volume | ✅ Survives restart | Only if volume deleted |
| Audit reports (DB) | PostgreSQL `audit_reports` via orchestrator | ✅ Durable | Only if DB wiped |
| Audit events log | PostgreSQL `audit_events` | ✅ Durable | Only if DB wiped |
| Bid skip decisions | PostgreSQL `bid_skips` | ✅ Durable | Only if DB wiped |
| Findings during aggregation | PostgreSQL `pending_findings` (PG) or in-memory fallback | ✅ Durable (when PG set) | Only if DB wiped |
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
| GuardExchange | `0xD6133Edab4D08D2a66f604217B36E342bc4338B7` |
| HbarPool | `0x9102Dc653a0F148B5a8FFbc6a9b2247E596c9CD5` |
| VaultFactory | `0xf8EdB1F55894F6b196245f4a46bDe9e4fb04a750` |
| Treasury | `0xC4736e92fbd50663b0C1bd68d7Bf6cdC1FC04D9e` |

**HCS Topics:**
- Discovery: `0.0.7940144`
- Audit Log: `0.0.7940145`
- Agent Comms: `0.0.7940146`

**Test Contracts:**
- VulnerableVault1: `0x0c5a2d6380F8f5E53A5b1C99c0FEE51d46834162`
- VulnerableVault2: `0x57b2bc29B5dce8257F9536D7DcC46f41d495690E`
- VulnerableVault3: `0xfAd7C68ABB535f866aA9852158BE2a16A3f572A0`

---

## Docker / Deployment Files

| File | Purpose | Status |
|------|---------|--------|
| `Dockerfile` | Multi-stage backend build (local compose only) | ✅ Ready |
| `Dockerfile.devall` | Production image (used by CI/CD) | ✅ Ready — `NODE_ENV=production`, uses `start:backend` CMD |
| `docker-compose.yml` | Local dev (all services + postgres) | ✅ Ready — postgres service + DATABASE_URL wired |
| `docker-compose.prod.yml` | Prod (postgres + backend image) | ✅ Ready — SQLite removed, report_files volume added |
| `scripts/ec2/run-devall-container.sh` | EC2 deploy script | ✅ Ready |
| `.github/workflows/ghcr-build-devall.yml` | Build + push to GHCR on push to main | ✅ Ready — build only, no auto-deploy |
| `.github/workflows/deploy-backend.yml` | Deploy chosen image tag to EC2 (manual trigger) | ✅ Ready — needs EC2 secrets set |
| `.github/workflows/deploy-dashboard-vercel.yml` | Deploy dashboard to Vercel (manual trigger) | ✅ Ready — needs Vercel secrets set |

**Deploy flow:**
1. Push to `main` → build runs, image tagged `sha-<hash>` pushed to GHCR
2. Ready to ship → Actions → "Deploy Backend to EC2" → enter `sha-<hash>` or `latest`
3. Dashboard → Actions → "Deploy Dashboard to Vercel" → Run workflow

**Remaining deployment blockers:**
1. EC2 instance not yet provisioned (needs Docker installed + `/opt/auditguard/.env` with `POSTGRES_PASSWORD`)
2. GitHub secrets not set: `EC2_HOST`, `EC2_USERNAME`, `EC2_SSH_KEY`, `EC2_PORT`, `EC2_CONTAINER_NAME`, `GHCR_USERNAME`, `GHCR_READ_TOKEN`, `EC2_ENV_FILE`
3. Vercel secrets not set: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VITE_EVENTS_API_BASE_URL`

---

## What Works End-to-End (Verified April 6, 2026)

1. ✅ Scanner discovers new contracts on Hedera testnet (15s polling)
2. ✅ Orchestrator creates on-chain auction jobs for discovered contracts
3. ✅ Agents receive invites via HCS, bid on auctions
4. ✅ Winner selection happens on-chain after auction deadline
5. ✅ Winning agent runs static analysis on contract source (via Sourcify)
6. ✅ Findings posted to static-analysis-service store (PostgreSQL when DATABASE_URL set)
7. ✅ Report agent aggregates findings after 120s window
8. ✅ Markdown report written to `agents/data/reports/<jobId>.md`
9. ✅ Report posted to events-api `/api/reports` endpoint (when running)
10. ✅ Gas price fix working — legacy type-0 txs at 1111 gwei succeed
11. ✅ PostgreSQL schema applied on first boot via docker entrypoint
12. ✅ CI/CD wired: push to main → GHCR image → EC2 deploy (pending secrets)

---

## How to Start (Current Dev Setup)

```bash
# All at once (recommended)
npm run dev:backend

# Or individually:
npm run fuzzer:service &
npm run static-analysis:service &
npm --prefix packages/events-api run dev &
npm run orchestrator >> /tmp/ag-orchestrator.log 2>&1 &
cd agents && npm run all >> /tmp/ag-agents.log 2>&1 &

# Monitor
tail -f /tmp/ag-orchestrator.log
tail -f /tmp/ag-agents.log
```

Or with Docker (local dev, requires `.env` with `POSTGRES_PASSWORD=dev`):
```bash
docker compose up
```
