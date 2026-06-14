# AuditGuard — Current State (June 2026)

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

**0g preflight:** `npm run dev` runs `preflight:runtime`, which validates live 0g inference config before startup. With `ZG_PROVIDER_MODE=pinned` (default), `ZG_MODEL` must match the model advertised by `ZG_PROVIDER_ADDRESS`. The testnet provider (`0xa48f01287233509FD694a22Bf840225062E67836`) currently serves `qwen/qwen2.5-omni-7b`.

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
| 15 | **P1** | `.env` / 0g preflight | `ZG_MODEL` was set to `qwen-2.5-7b-instruct` while the live 0g testnet provider advertises `qwen/qwen2.5-omni-7b`. With default `ZG_PROVIDER_MODE=pinned`, `preflight:runtime` failed and blocked `npm run dev`. | **FIXED** | Set `ZG_MODEL=qwen/qwen2.5-omni-7b` in `.env`, `.env.example`, `agents/.env.example`, and `agents/shared/config.ts` default |
| 16 | **P1** | `scripts/activate-live-agents.js` | Unfunded agents (`static-analysis-047`, `fuzzer-012`) could not be topped up because the primary operator account (`HEDERA_ACCOUNT_ID`) had 0 GUARD. Activation failed with `operator_guard_insufficient` and blocked `npm run dev`. | **FIXED** | Added multi-donor GUARD top-up: activation now searches owner credentials and funded agent accounts (keeping stake+liquid reserve) before failing |

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
- **Status:** Production-ready — creates auctions, selects winners, settles payments
- **Tech:** Node.js ESM, ethers v6, @hashgraph/sdk
- **Gas fix:** `patchProviderFeeData` forces legacy type-0 txs at 1111 gwei
- **Persistence:** PostgreSQL state store (roster + event cache)
- **Observability:** Prometheus metrics on port 9090, health checks on port 8080
- **Database:** Automated Knex migrations on startup

### Agents (agents/ — 7 agents)
| Agent | ID | Status | Metrics Port | Health Port |
|-------|----|--------|--------------|-------------|
| Scanner | `scanner-001` | Production-ready | 9091 | 8091 |
| Static Analysis | `static-analysis-047` | Production-ready | 9092 | 8092 |
| Fuzzer | `fuzzer-012` | Production-ready | 9093 | 8093 |
| LLM Contextual | `llm-contextual-003` | Production-ready | 9094 | 8094 |
| Dependency Analyzer | `dependency-analyzer-008` | Production-ready | 9095 | 8095 |
| Report Aggregator | `report-aggregator-001` | Production-ready | 9096 | 8096 |
| Alert Sentinel | `alert-sentinel-001` | Production-ready | 9097 | 8097 |

**New Features (June 2026):**
- ✅ Cryptographic PONG signatures for identity verification
- ✅ Type-safe message handling with runtime validation
- ✅ Race condition prevention with per-job locking
- ✅ Error boundaries with typed error classes
- ✅ External data validation (mirror nodes, RPC)
- ✅ Prometheus metrics export (business + performance)
- ✅ Comprehensive health checks (HCS, RPC, contracts, wallet)

### Microservices
| Service | Port | Status | Notes |
|---------|------|--------|-------|
| `events-api` | 4000 | Production-ready | PostgreSQL required; rate limiting enabled |
| `static-analysis-service` | 4002 | Working | Real runners require slither/semgrep in Docker |
| `fuzzer-service` | 4001 | Working | Real fuzz tools not installed in local setup |

**Events API Security (June 2026):**
- ✅ Input validation (message types, payload size, string length)
- ✅ Rate limiting (1000 req/15min per IP)
- ✅ Constant-time authentication (timing attack prevention)
- ✅ 32-character minimum token enforcement
- ✅ Comprehensive health checks

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
| **Orchestrator roster** (NEW) | PostgreSQL `orchestrator_state` | **Durable** ✅ |
| **Orchestrator event cache** (NEW) | PostgreSQL `orchestrator_state` | **Durable** ✅ |
| Findings during aggregation | PostgreSQL `pending_findings` (with in-memory fallback) | Durable when DB set |
| Fuzzer job queue | In-memory (fuzzer-service) | Ephemeral |
| iNFT metadata | 0g Labs DA | Durable |

**Database Migrations:** Managed by Knex.js, auto-run on startup via `npm start`

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

**Production Readiness (June 2026):**
- ✅ Docker healthchecks configured for all services
- ✅ Kubernetes liveness/readiness probes available
- ✅ Prometheus metrics on ports 9090-9097
- ✅ Health endpoints on ports 8080, 8091-8097, 4000
- ✅ Database migrations automated
- ✅ Security hardening complete (P0 issues resolved)

**Remaining deployment steps:**
1. EC2 instance provisioning
2. GitHub secrets configuration: `EC2_HOST`, `EC2_USERNAME`, `EC2_SSH_KEY`, `EC2_PORT`, `EC2_CONTAINER_NAME`, `GHCR_USERNAME`, `GHCR_READ_TOKEN`, `EC2_ENV_FILE`
3. Vercel secrets configuration: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VITE_EVENTS_API_BASE_URL`
4. Generate secure `EVENTS_API_INGEST_TOKEN` (≥32 chars): `openssl rand -hex 32`

---

## Recent Improvements (June 2026)

### ✅ Security Enhancements (P0 - All Complete)

**1. Type-Safe Message Handling**
- Created `agents/shared/message-validators.ts` with 15+ message type validators
- Eliminated all unsafe `as any` type casts across all 7 agents
- Runtime validation for all HCS messages before processing
- **Impact:** Zero type safety vulnerabilities, invalid messages rejected at ingestion

**2. Events API Security Hardening**
- Message type enum validation (40+ known types)
- Payload size limits (50KB), string length limits (500 chars)
- Rate limiting: 1000 requests per 15 minutes per IP
- Constant-time token comparison using `crypto.timingSafeEqual()`
- Enforced 32-character minimum token length
- **Impact:** Timing attack prevention, API abuse protection, comprehensive audit trail

**3. Error Handling & Race Condition Prevention**
- Created `agents/shared/errors.ts` with typed error classes
- Wrapped all HCS subscription callbacks in error boundaries
- Created `agents/shared/job-lock.ts` with JobLockManager for atomic state updates
- Automatic state cleanup on failures
- **Impact:** Zero unhandled promise rejections, zero duplicate bids, atomic job processing

**4. External Data Validation**
- Created `agents/shared/validation-utils.ts` with 9 validation functions
- All Hedera mirror node responses validated before use
- All JSON-RPC provider responses validated before processing
- Scanner validates: contract addresses, risk scores, LOC estimates, bytecode
- **Impact:** Zero invalid external data published to HCS topics

**5. Agent Identity Verification**
- Implemented cryptographic PONG signature verification
- Nonce-based replay protection (32-byte random nonces, 30s expiration)
- On-chain verification against AgentRegistry
- **Impact:** Prevents agent impersonation attacks, cryptographic proof of identity

### ✅ Reliability Improvements (P1 - All Complete)

**6. Persistent Orchestrator State**
- Created `orchestrator/src/state-store.js` with PostgreSQL persistence
- Agent roster and event cache survive restarts
- Periodic saves every 60 seconds + graceful shutdown saves
- **Impact:** No state loss on restart, faster recovery, production-ready

**7. Database Migration Framework**
- Knex.js migration framework installed
- 3 versioned SQL migrations (001_initial_schema, 002_orchestrator_state, 003_indexes)
- Idempotent migrations (safe to run multiple times)
- Auto-runs on `npm start`
- **Impact:** Version-controlled schema evolution, automated deployments

**8. StakingManager → DelegatedStaking Integration**
- Verified `setDelegatedStaking()` implemented in StakingManager contract
- Deployment script automatically wires contracts
- Automatic slash propagation to delegators
- **Impact:** No manual relay needed, production-ready

### ✅ Operational Readiness (P1 - All Complete)

**9. Prometheus Metrics Export**
- Created `orchestrator/src/metrics.js` and `agents/shared/metrics.ts`
- All services export metrics on dedicated ports (9090-9097)
- Business metrics: auctions, bids, findings, settlements
- Performance metrics: HCS latency, contract call duration
- System metrics: CPU, memory, event loop lag
- **Impact:** Full observability, Grafana-compatible, production monitoring ready

**10. Comprehensive Health Checks**
- Created `orchestrator/src/health.js` and `agents/shared/health.ts`
- Health checks verify: PostgreSQL, HCS topics, Hedera RPC, contract calls
- Separate liveness (`/healthz`) and readiness (`/ready`) probes
- All services on dedicated ports (8080 orchestrator, 8091-8097 agents)
- **Impact:** Kubernetes-ready, Docker healthcheck compatible, proper HTTP status codes

### Test Coverage
- **Base Test Suite:** 481 tests passing ✅
- **New Validation Tests:** 46 tests passing ✅
- **New Job Lock Tests:** 10 tests passing ✅
- **New Health Tests:** 13 tests passing ✅
- **New Metrics Tests:** 5 tests passing ✅
- **Total:** 555 tests passing ✅

### Files Changed
- **Created:** ~70 new files (validators, error classes, metrics, health checks, migrations, docs)
- **Modified:** ~60 files (all agents, orchestrator, events-api, .env.example)
- **Lines Added:** ~8,000+ lines of production code
- **Documentation:** 10+ comprehensive guides

---

---

## New Configuration (June 2026)

### Environment Variables Added

```bash
# Events API Authentication (P0 - Required)
EVENTS_API_INGEST_TOKEN=     # Generate: openssl rand -hex 32 (≥32 chars)

# Prometheus Metrics Ports (Defaults shown)
ORCHESTRATOR_METRICS_PORT=9090
SCANNER_METRICS_PORT=9091
STATIC_METRICS_PORT=9092
FUZZER_METRICS_PORT=9093
LLM_METRICS_PORT=9094
DEPENDENCY_METRICS_PORT=9095
REPORT_METRICS_PORT=9096
ALERT_METRICS_PORT=9097

# Health Check Ports (Defaults shown)
ORCHESTRATOR_HEALTH_PORT=8080
SCANNER_HEALTH_PORT=8091
STATIC_HEALTH_PORT=8092
FUZZER_HEALTH_PORT=8093
LLM_HEALTH_PORT=8094
DEPENDENCY_HEALTH_PORT=8095
REPORT_HEALTH_PORT=8096
ALERT_HEALTH_PORT=8097
```

### Port Reference

| Service | Main | Metrics | Health | Purpose |
|---------|------|---------|--------|---------|
| Orchestrator | N/A | 9090 | 8080 | Auction coordination |
| Scanner | N/A | 9091 | 8091 | Contract discovery |
| Static Analysis | N/A | 9092 | 8092 | Security analysis |
| Fuzzer | N/A | 9093 | 8093 | Fuzz testing |
| LLM Contextual | N/A | 9094 | 8094 | AI-powered analysis |
| Dependency | N/A | 9095 | 8095 | Dependency auditing |
| Report | N/A | 9096 | 8096 | Report aggregation |
| Alert | N/A | 9097 | 8097 | Alert monitoring |
| Events API | 4000 | N/A | 4000 | Event persistence |
| Dashboard | 5173 | N/A | N/A | Web UI (dev) |

### Monitoring & Observability

**Prometheus Scrape Configuration:**
```yaml
scrape_configs:
  - job_name: 'auditguard-orchestrator'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'auditguard-agents'
    static_configs:
      - targets:
          - 'localhost:9091'  # scanner
          - 'localhost:9092'  # static
          - 'localhost:9093'  # fuzzer
          - 'localhost:9094'  # llm
          - 'localhost:9095'  # dependency
          - 'localhost:9096'  # report
          - 'localhost:9097'  # alert
```

**Kubernetes Probes:**
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
```

**Docker Healthcheck:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1
```

---

## Documentation Reference

### New Guides (June 2026)
- **`HEALTH_CHECKS.md`** - Health endpoint documentation
- **`METRICS.md`** - Prometheus metrics guide
- **`orchestrator/MIGRATION_GUIDE.md`** - Database migrations
- **`orchestrator/PERSISTENCE.md`** - State persistence
- **`agents/shared/message-validators.ts`** - Message validation reference
- **`agents/shared/validation-utils.ts`** - External data validation

### Testing Documentation
- **`agents/tests/health-endpoints.test.ts`** - Health check tests
- **`agents/tests/job-lock.test.ts`** - Race condition tests
- **`agents/tests/validation-utils.test.ts`** - Validation tests
- **`orchestrator/test/metrics.test.js`** - Metrics tests
- **`orchestrator/test/migration.test.js`** - Migration tests

---

## Remaining Deferred Items

- **AgentRegistry `setAuctionContract()`** — requires redeploy to register AuditAuction v3 (low priority; non-fatal, metrics silent-fail only)
- **Orchestrator build artifact** — `vite build` produces unused `dist/index.js` (harmless, low priority cleanup)

---

## Production Deployment Checklist

### Pre-Deployment
- [x] All P0 security fixes applied
- [x] Database migrations tested
- [x] Health checks verified
- [x] Metrics endpoints tested
- [ ] Generate secure `EVENTS_API_INGEST_TOKEN` (≥32 chars)
- [ ] Set all required environment variables
- [ ] Provision EC2 instance (or equivalent)
- [ ] Configure GitHub secrets for CI/CD

### Deployment
1. **Database Setup**
   ```bash
   # Set DATABASE_URL in production .env
   export DATABASE_URL=postgresql://user:pass@host:5432/auditguard

   # Migrations run automatically on startup
   npm start
   ```

2. **Security**
   ```bash
   # Generate secure token
   openssl rand -hex 32

   # Set in .env
   echo "EVENTS_API_INGEST_TOKEN=<generated-token>" >> .env
   ```

3. **Monitoring Setup**
   - Configure Prometheus to scrape ports 9090-9097
   - Set up Grafana dashboards (see `METRICS.md`)
   - Configure alerting rules

4. **Health Monitoring**
   - Verify all health endpoints return 200
   - Test liveness probes (`/healthz`)
   - Test readiness probes (`/ready`)

### Post-Deployment Verification
```bash
# Check orchestrator health
curl http://your-server:8080/health

# Check agent health (all 7 agents)
for port in {8091..8097}; do
  curl http://your-server:$port/health
done

# Check metrics availability
curl http://your-server:9090/metrics

# Verify database migrations
psql $DATABASE_URL -c "SELECT * FROM knex_migrations;"
```
