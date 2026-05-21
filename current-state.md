# AuditGuard — Current State (May 2026)

## Project Overview

AuditGuard is an autonomous agent-based smart contract security audit marketplace built on Hedera Hashgraph. Seven TypeScript agents (scanner, static-analysis, fuzzer, llm-contextual, dependency, report, alert) discover deployed contracts, bid in on-chain auctions, perform security analysis, and receive GUARD token payments — all coordinated via Hedera Consensus Service (HCS) topics and EVM smart contracts deployed on Hedera testnet.

**Stack:** Node.js v20+, TypeScript v5.5 (agents), JavaScript ESM (orchestrator), React 18 + Vite (dashboard), PostgreSQL (persistence), Hardhat (contracts), Docker + GitHub Actions (CI/CD).

---

## Build & Run Instructions

### Prerequisites
- Node.js >= 20
- PostgreSQL (or Docker)
- `.env` copied from `.env.example` with credentials filled in

### Install
```bash
npm install
```

### Dev (local, all services)
```bash
npm run dev:backend       # orchestrator + agents + events-api + fuzzer/static services
npm run dev:all           # above + dashboard (runs preflight checks first)
npm run dev:all:unsafe    # above but skip preflight (faster for dev)
```

### Individual services
```bash
npm run orchestrator                          # orchestrator only
npm run agents                                # all 7 agents
npm --prefix packages/dashboard run dev       # dashboard only
npm run fuzzer:service                        # fuzzer microservice :4001
npm run static-analysis:service               # static analysis microservice :4002
npm --prefix packages/events-api run dev      # events API :4000
```

### Tests
```bash
npm run test                  # Hardhat contract tests
npm run dev:test              # orchestrator mocks + agent invite + vitest + dashboard
npm --workspace agents run test  # all agent vitest tests
```

### Build
```bash
npm run build                 # builds dashboard (Vite) + orchestrator (Vite SSR)
npm run compile               # compile Solidity contracts (Hardhat)
```

### Docker (local dev)
```bash
docker compose up             # postgres + events-api + orchestrator + agents + dashboard
docker compose down
```

### Deploy (Hedera testnet)
```bash
npm run deploy:contracts      # deploy all EVM contracts
npm run setup:hcs             # create HCS topics
npm run setup:treasury        # wire Treasury fee splits (one-time)
npm run wire:delegated-staking # point StakingManager at DelegatedStaking (one-time)
npm run fund:agents           # fund agent accounts with HBAR + GUARD
npm run preflight:live        # check runtime readiness + activate/verify live agents
```

---

## Issues Table (P0–P3)

| ID | Priority | Component | Issue | Status | Fix Applied |
|----|----------|-----------|-------|--------|-------------|
| 1 | **P0** | `docker-compose.yml` | `events-api` published port was `3001:3001` but the app listens on `EVENTS_API_PORT` (default **4000**). The environment set `PORT=3001` — a variable the app never reads — so the container was unreachable and the `depends_on` health check would never pass. | **FIXED** | Changed to `4000:4000`, env `EVENTS_API_PORT=4000` |
| 2 | **P0** | `docker-compose.yml` | Health check URL was `http://localhost:3001/health` but the health route is mounted under `/api` (so the real path is `/api/health`), and the wrong port was used. | **FIXED** | Changed to `http://localhost:4000/api/health` |
| 3 | **P0** | `docker-compose.yml` | `agents` service command `node -e "require('./agents/run-all.ts')"` cannot work: Node.js cannot `require()` a `.ts` file, and the agents workspace uses ESM (`"type":"module"`), making `require()` doubly invalid. | **FIXED** | Changed to `npx tsx agents/run-all.ts` |
| 4 | **P1** | `docker-compose.yml` | `orchestrator` and `agents` services referenced `http://events-api:3001` (wrong port). | **FIXED** | Changed to `http://events-api:4000` |
| 5 | **P1** | `packages/dashboard/Dockerfile` | Build arg declared as `VITE_EVENTS_API_URL` but the dashboard code reads `VITE_EVENTS_API_BASE_URL`. The Vite build would embed an empty string, causing all API calls to fall back to `/api` only — silently breaking non-proxied deployments (Docker without Nginx proxy / production). | **FIXED** | Renamed ARG/ENV to `VITE_EVENTS_API_BASE_URL`; updated default to `http://localhost:4000` |
| 6 | **P1** | `agents/package.json` | `@anthropic-ai/sdk` pinned at `^0.38.0` while the root `package.json` (and other workspaces) declare `^0.78.0`. npm workspace hoisting means the installed version could be unpredictable; Claude API calls from agents risked using stale SDK behaviour. | **FIXED** | Bumped to `^0.78.0` to match root |
| 7 | **P1** | `packages/sdk/address-utils.js` | No `.d.ts` declaration file existed. `agents/scanner/index.ts` imports `resolveDeployerAddress` from this module — TypeScript emitted `error TS7016` ("implicitly has any type"), failing strict type checking. | **FIXED** | Created `packages/sdk/address-utils.d.ts` with full function signatures |
| 8 | **P2** | `package.json` (root) | Three phantom npm packages in `dependencies`: `"checkout": "^1.0.1"`, `"git": "^0.1.5"`, `"main": "^1000.0.1"`. These are unrelated npm packages (none used anywhere in the codebase) that were likely accidental. They bloat `node_modules`, add install surface area, and show up in `npm audit`. | **FIXED** | Removed all three from root `dependencies` |
| 9 | **P2** | `packages/inft/package.json` | `vite` and `vitest` were listed as runtime `dependencies` instead of `devDependencies`. This causes them to be installed in production Docker images unnecessarily, increasing image size. | **FIXED** | Moved to `devDependencies` |
| 10 | **P2** | `packages/events-api/src/` | Two orphaned legacy CJS files remained in the ESM service: `auth.js` (80 lines using `require()`, importing uninstalled `jsonwebtoken` + `ethers`) and `hcs-listener.js` (also `require()`-based). Neither is imported by `index.js`. In an ESM package these files cannot be `require()`'d and would crash if accidentally referenced. | **FIXED** | Deleted both orphaned files |
| 11 | **P3** | `docker-compose.yml` `dashboard` service | Build arg passed as `VITE_EVENTS_API_URL` — now renamed to `VITE_EVENTS_API_BASE_URL` consistent with fix #5. | **FIXED** | Updated arg name in `docker-compose.yml` `dashboard.build.args` |
| 12 | **P3** | `orchestrator/` | Orchestrator has a `vite build` script that compiles to `dist/index.js` (SSR bundle). However all production run scripts (`start:backend`, `Dockerfile.devall`) execute `node orchestrator/src/index.js` directly — the built artifact is never used. This is confusing but not a blocker: the build succeeds and the SSR output is harmless. | DEFERRED | Low risk; would need to either wire up dist or remove the dead build step |
| 13 | **P3** | `AgentRegistry` | `setOrchestratorAndAuction()` has a `require(orchestrator == address(0))` guard — one-time-only; the new AuditAuction v3 is not registered with AgentRegistry. `recordJobCompletion` and `slashAgent` silently fail with `RegistryCallFailed` event. Payment and audit flow are unaffected. | DEFERRED | Requires AgentRegistry redeploy with `setAuctionContract()` |
| 14 | **P3** | `agents/shared/types.ts.bak` | A `.bak` file left in the shared directory. Not imported anywhere but adds noise. | DEFERRED | Safe to delete manually |

---

## Architecture Overview

```
                        ┌─────────────────────────────────┐
                        │         Hedera Testnet           │
                        │  AgentRegistry | AuditAuction   │
                        │  SubAuction | PaymentSettlement  │
                        │  DataMarketplace | AuditScheduler│
                        │  GuardExchange | HbarPool        │
                        │  VaultFactory | Treasury         │
                        │  StakingManager | DelegatedStaking│
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
- **Status:** Fully deployed on Hedera testnet (v3 redeploy April 2026)
- **All addresses in:** `packages/sdk/config.json`
- **Key limitation:** AgentRegistry metrics silent-fail (`RegistryCallFailed` event, non-fatal)
- See previous `current-state.md` for complete contract address table

### Orchestrator (orchestrator/src/)
- **Status:** Working — creates auctions, selects winners, settles payments
- **Tech:** Node.js ESM, ethers v6, @hashgraph/sdk
- **Gas fix:** `patchProviderFeeData` forces legacy type-0 txs at 1111 gwei

### Agents (agents/ — 7 agents)
| Agent | ID | Status |
|-------|----|--------|
| Scanner | `scanner-001` | Working |
| Static Analysis | `static-analysis-047` | Working |
| Fuzzer | `fuzzer-012` | Working |
| LLM Contextual | `llm-contextual-003` | Working |
| Dependency Analyzer | `dependency-analyzer-008` | Working |
| Report Aggregator | `report-aggregator-001` | Working |
| Alert Sentinel | `alert-sentinel-001` | Working |

### Microservices
| Service | Port | Status |
|---------|------|--------|
| `events-api` | 4000 | Working (PostgreSQL required for durability) |
| `static-analysis-service` | 4002 | Working (real runners require slither/semgrep in Docker) |
| `fuzzer-service` | 4001 | Working (real fuzz tools not installed in local setup) |

### Dashboard (packages/dashboard/)
- **Status:** Working in dev mode; CI/CD ready for Vercel
- **Tech:** React 18, Vite, Zustand, TailwindCSS

---

## Data Persistence

| Data | Where It Lives | Durable? |
|------|---------------|----------|
| Agent registry, reputation, staking | Hedera contracts | Permanent |
| Job lifecycle, bids, winners | Hedera contracts | Permanent |
| Payment history | Hedera contracts | Permanent |
| HCS messages | Hedera HCS topics | Permanent |
| Audit reports (DB) | PostgreSQL `audit_reports` | Durable |
| Audit events log | PostgreSQL `audit_events` | Durable |
| Job state cache | PostgreSQL `audit_jobs` | Durable |
| Agent state cache | PostgreSQL `registered_agents` | Durable |
| Findings during aggregation | PostgreSQL `pending_findings` (with in-memory fallback) | Durable when DB set |
| Fuzzer job queue | In-memory (fuzzer-service) | Ephemeral |
| iNFT metadata | 0g Labs DA | Durable |

---

## Deployed Addresses (Hedera Testnet)

All in `packages/sdk/config.json`. Key contracts:

| Contract | EVM Address |
|---------|-------------|
| AuditAuction v3 | `0x9e47bBa152F1506F80Ad1168F37A47C66DEE0F5d` |
| SubAuction v3 | `0xd44D56e5e0870deC8def40EfAD0646dC0Ca75387` |
| PaymentSettlement v3 | `0x63F5d457fd20De96b98d33158F747D9fCb62d203` |
| AgentRegistry | `0x24F50cf56e768da01617906f1caa6010f0efe332` |
| DataMarketplace | `0xeB85dCAD49cee215EDF9244A4006439DAdEF8e7e` |
| Treasury | `0xC4736e92fbd50663b0C1bd68d7Bf6cdC1FC04D9e` |
| StakingManager | `0xd76B95CEBdEcf431D3D1376551e6764000e6ffc7` |
| DelegatedStaking | `0xdf1400c43f5747c2F783e95B81C68e8bAd792637` |

**HCS Topics:** Discovery `0.0.7940144` · Audit Log `0.0.7940145` · Agent Comms `0.0.7940146`

**GUARD Token:** `0.0.7977433` (8 decimal places — always use `parseUnits(amount, 8)`)

---

## Docker / Deployment

| File | Purpose | Status |
|------|---------|--------|
| `Dockerfile` | Multi-stage backend for local compose | Ready |
| `Dockerfile.devall` | Production image (CI/CD) — includes slither/semgrep/mythril | Ready |
| `docker-compose.yml` | Local dev (all services + postgres) | Fixed (port/health/agents command) |
| `docker-compose.prod.yml` | Prod (postgres + backend image) | Ready |
| `.github/workflows/ghcr-build-devall.yml` | Build + push to GHCR on push to main | Ready |
| `.github/workflows/deploy-backend.yml` | Deploy to EC2 (manual trigger) | Ready — needs EC2 secrets |
| `.github/workflows/deploy-dashboard-vercel.yml` | Deploy to Vercel (manual trigger) | Ready — needs Vercel secrets |

**Remaining deployment blockers:**
1. EC2 instance not yet provisioned
2. GitHub secrets not set: `EC2_HOST`, `EC2_USERNAME`, `EC2_SSH_KEY`, `EC2_PORT`, `EC2_CONTAINER_NAME`, `GHCR_USERNAME`, `GHCR_READ_TOKEN`, `EC2_ENV_FILE`
3. Vercel secrets not set: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VITE_EVENTS_API_BASE_URL`

---

## Known Deferred Items

- **Signature verification for agent PONG messages** — not implemented
- **Persistent orchestrator roster/cache** — currently in-memory only
- **AgentRegistry `setAuctionContract()`** — requires redeploy to register AuditAuction v3 (low priority; non-fatal)
- **Orchestrator build artifact unused** — `npm run build` produces `orchestrator/dist/index.js` but all run scripts execute `src/index.js` directly. Either wire up the dist output or remove the build step.
- **`agents/shared/types.ts.bak`** — orphaned backup file, safe to delete
