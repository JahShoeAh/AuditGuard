# AuditGuard — Current State (April 2026)

## Project Status: Transitioning from Hackathon → Production

The core pipeline is working end-to-end on Hedera testnet. Infrastructure is functional but built for demo/development — not production hardened. This document captures what exists, what works, what's broken, and what needs to be done.

---

## Incomplete / Broken Features — Priority Table

| Priority | Feature | Status | Effort | Impact |
|----------|---------|--------|--------|--------|
| ✅ P0 | StakingManager ↔ DelegatedStaking wiring | **DONE** — orchestrator slash relay + `wire-delegated-staking.js` script | — | Run `npm run wire:delegated-staking` once |
| ✅ P0 | Static analysis service real runners | **DONE** — slither+semgrep in Dockerfile, Sourcify source fetch | — | Deploy new image; sources auto-fetched |
| ✅ P0 | Treasury contract wiring | **DONE** — Treasury/StakingManager/DelegatedStaking in orchestrator ContractClient + `setup-treasury.js` | — | Run `npm run setup:treasury` once |
| ✅ P0 | Events API schema + routes | **DONE** — audit_jobs + registered_agents + audit_schedules + audit_vaults tables + GET/POST routes | — | Deploy + run schema migration |
| ✅ P1 | Report agent → PostgreSQL persistence | **DONE** — report agent POSTs to events-api `/api/reports`; events-api calls `report-db.js` → `audit_reports` table | — | Already implemented |
| ✅ P1 | iNFT mint triggers | **DONE** — `mintAuditJobINFT`/`mintAgentProfileINFT`/`mintContractHealthINFT` in `agents/shared/inft-bridge.ts`; orchestrator's `inft-bridge.js` handles `updateReputation` + `markJobCompleted` | — | No-op if credentials not set |
| ✅ P1 | DataMarketplace — fuzzer listings | **DONE** — `createListing()` + `DATA_LISTING_CREATED` added to fuzzer `simulateAuditCycle` | — | Mirrors static-analysis pattern |
| ✅ P2 | AuditScheduler — UI + API routes | **DONE** — `/api/schedules` routes + AuditSchedules dashboard sub-tab | — | — |
| ✅ P2 | GuardExchange + HbarPool integration | **DONE** — ABIs loaded in orchestrator ContractClient + ExchangeWidget dashboard sub-tab | — | — |
| ✅ P2 | VaultFactory integration | **DONE** — VaultCreated/AutoAuditTriggered wired + `/api/vaults` routes + VaultPanel dashboard | — | — |
| ✅ P3 | Fuzzer mock findings flag | **DONE** — `isMock: true` on all mock findings; severity counts zeroed in HCS + orchestrator | — | — |
| ✅ P3 | Dashboard placeholder pages | **N/A** — all pages were already implemented; VaultPanel + ExchangeWidget added in P2 | — | — |
| ✅ P2 | `report-writer.js` missing contract types | **DONE** — `CANONICAL_CONTRACT_TYPES` now includes `derivatives`, `oracle`, `governance`, `nft` | — | — |
| ✅ P2 | Duplicated Hedera provider logic | **DONE** — extracted to `packages/sdk/hedera-provider.js`; `agents/shared/contract-client.ts`, `agents/shared/wallet.ts`, `orchestrator/src/contract-client.js` all import from it | — | Gas fix now applied consistently including agent wallet provider |
| ✅ P3 | PaymentItem comment wrong | **DONE** — corrected in `agents/shared/contract-client.ts` to match all 10 Solidity enum values | — | — |

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
- **Status:** ✅ Fully deployed on Hedera testnet (v3 redeploy April 2026)
- **Contracts deployed:**
  - `AgentRegistry` — agent profiles, reputation, staking
  - `AuditAuction` **v3** — job lifecycle, bids, winner selection; `updateBid()` + `RegistryCallFailed` event
    - `MIN_BID_COLLATERAL` = 50 GUARD (50 × 10^8)
    - `JobStatus`: AUCTION_OPEN, BIDDING_CLOSED, AUDITING_IN_PROGRESS, REPORT_PENDING, COMPLETED, CANCELLED
    - `BidStatus`: PENDING, ACCEPTED, REJECTED, REFUNDED
  - `SubAuction` **v3** — sub-contracting; fresh deploy owned by current operator
  - `PaymentSettlement` **v3** — agent payment distribution; fresh deploy owned by current operator
    - `PaymentType` enum (10 values): MAIN_AUDIT(0), SUB_CONTRACT(1), DATA_PURCHASE(2), BONUS_SPEED(3), BONUS_UNIQUE_FINDING(4), MONITORING_PAYMENT(5), REPORT_FEE(6), PLATFORM_FEE(7), BOUNTY_PAYOUT(8), REFUND(9)
  - `DataMarketplace` — report listings; `ListingCategory` enum: SCAN_REPORT(0), DEPENDENCY_TREE(1), HOT_LEAD(2), VULN_DB(3)
  - `AuditScheduler` — recurring audit jobs
  - `GuardExchange` — GUARD/HBAR AMM swap ✅ integrated in orchestrator ContractClient
  - `HbarPool` — fixed-rate HBAR→GUARD converter ✅ integrated in orchestrator ContractClient
  - `VaultFactory` — audit vault creation ✅ VaultCreated/AutoAuditTriggered wired + VaultPanel
  - `Treasury` — fee distribution ✅ loaded in orchestrator ContractClient + setup script
  - `StakingManager` — agent staking ✅ `propagateSlash` relay wired via orchestrator
  - `DelegatedStaking` — delegator slash propagation ✅ pointed at StakingManager via wire script
- **All addresses in:** `packages/sdk/config.json`
- **Hedera key split (CRITICAL):**
  - `PERSONAL_PRIV` → EVM `0xC1E5d505a87FF69CDE44EDd67733C0310A09e859` — used by hardhat for deploys (contract owner)
  - `OPERATOR_PRIVATE_KEY` → EVM `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a` — used by orchestrator at runtime
  - After any new contract deploy, must call `setOrchestrator(0xDC126e...)` from owner (PERSONAL_PRIV) before orchestrator can call privileged functions
- **HTS token association (CRITICAL):**
  - Internal `tokenAssociate(address(this), token)` in Solidity does NOT work reliably via JSON-RPC on Hedera
  - Working approach: send 1 GUARD via `TransferTransaction` (Hedera SDK) to the contract address — triggers auto-association
  - All three auction contracts have GUARD associated via this method
- **AgentRegistry limitation:**
  - `setOrchestratorAndAuction()` has `require(orchestrator == address(0))` — one-time-only, already set for old AuditAuction
  - New AuditAuction is NOT registered with AgentRegistry
  - Impact: `recordJobCompletion` and `slashAgent` calls will fail (emit `RegistryCallFailed` event, non-fatal)
  - Payment and audit flow still work — only on-chain reputation metrics are affected
  - Fix: redeploy AgentRegistry with `setAuctionContract()` function (deferred, low priority)
- **`updateBid` function:**
  - Can only lower bid (enforced on-chain); adjusts collateral bidirectionally
  - Exposed in `agents/shared/contract-client.ts` as `updateBid(jobId, newAmount, newCollateral, estimatedTime)`
  - Agents currently use scouting-window-only strategy; true submit+updateBid flow available but not wired
- **Two ContractClient implementations (shared provider core):**
  - `packages/sdk/hedera-provider.js` — single source of truth for gas fix, PollingEventSubscriber patch, RPC candidate resolution, FallbackProvider construction
  - `agents/shared/contract-client.ts` — loads 6 ABIs: agentRegistry, auction, budgetVault, subAuction, dataMarketplace, paymentSettlement; imports provider utilities from sdk
  - `orchestrator/src/contract-client.js` — loads 12 ABIs (all 6 above + Treasury, StakingManager, DelegatedStaking, GuardExchange, HbarPool, VaultFactory, AuditScheduler); imports provider utilities from sdk; also has write queue for nonce management
  - `agents/shared/wallet.ts` — also imports from sdk; now applies gas fix to the agent wallet provider
- **Deploy scripts:**
  - `packages/contracts/scripts/redeploy-auction.js` — redeploys AuditAuction only
  - `packages/contracts/scripts/rewire-auction.js` — deploys fresh SubAuction + PaymentSettlement wired to existing AuditAuction
  - Post-deploy checklist: (1) call `setOrchestrator(OPERATOR_EVM)` on new contracts, (2) send 1 GUARD to each contract via TransferTransaction
- **Known issues:**
  - `getActiveJobs()` reverts on Hedera RPC when >600 active jobs (return payload too large)
  - Reconcile skips gracefully and falls back to locally-tracked jobs (fixed April 2026)
  - AgentRegistry metrics silent-fail on `recordJobCompletion`/`slashAgent` (RegistryCallFailed event emitted)

### Orchestrator (orchestrator/src/)
- **Status:** ✅ Working — creates auctions, selects winners, settles payments
- **Tech:** Node.js ESM, ethers v6, @hashgraph/sdk
- **Key fix applied:** Gas price override (`patchProviderFeeData`) forces legacy type-0 txs at 1111 gwei — Hedera's EIP-1559 fee history returns near-zero baseFee which would cause silent reverts
- **Report persistence:** Two write paths exist:
  1. Orchestrator `report-writer.js` → `packages/sdk/db/report-db.js` → `audit_reports` table directly
  2. Report agent → POST `REPORT_API_URL` (events-api `/api/reports`) → `report-db.js` → same `audit_reports` table
  - Both paths are active; reports from either source land in the same table
  - Optional: `REPORT_CLAUDE_ENRICHMENT_ENABLED=true` (default false) enables Haiku enrichment in `report-writer.js`
  - Optional: `AWS_S3_BUCKET` enables S3 upload of raw markdown (key stored in `s3_key` column); `md_content` also stored inline in DB
- **iNFT integration (orchestrator side):**
  - `orchestrator/src/inft-bridge.js` — thin bridge; only `updateReputation(agentId, deltaBasisPoints, jobId)` and `markJobCompleted(jobId, txHash)`
  - Requires `AGENT_SERIALS_JSON` env (agentId → HTS serial map) and `JOB_SERIALS_JSON` (jobId → serial map)
  - Full minting is in the **agent layer** (`agents/shared/inft-bridge.ts`) — see iNFT section
- **Scheduled contract enrichment:** `scheduled-enrichment-client.js` spawns scanner subprocess to classify AuditScheduler-triggered contracts (contractType, riskScore, estimatedLOC)
- **Key env vars (orchestrator):**

  | Env Var | Default | Purpose |
  |---------|---------|---------|
  | `ORCHESTRATOR_MIN_HBAR` | `0.5` | Min HBAR for gas before auto top-up |
  | `ORCHESTRATOR_TARGET_HBAR` | `2.0` | Target HBAR after top-up |
  | `ORCHESTRATOR_AUTO_TOPUP_HBAR` | `true` | Enable HBAR auto top-up |
  | `ORCHESTRATOR_FAST_WINNER_PATH_ENABLED` | `false` | Skip reconcile delay for faster winner selection |
  | `ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS` | `true` | Periodic reconcile of expired/stale auctions |
  | `ORCHESTRATOR_RECONCILE_EXPIRED_AUCTIONS_INTERVAL_MS` | `30000` | Reconcile interval |
  | `ORCHESTRATOR_RECONCILE_MAX_CLOSES_PER_CYCLE` | `3` | Max auction closes per reconcile cycle |
  | `ORCHESTRATOR_RECONCILE_MAX_SELECTS_PER_CYCLE` | `10` | Max winner selections per reconcile cycle |
  | `ORCHESTRATOR_STARTUP_WINNER_REARM` | `true` | Re-arm winner selection timers on startup for in-progress jobs |
  | `ORCHESTRATOR_STARTUP_WINNER_REARM_MAX_JOBS` | `200` | Max jobs re-armed on startup |
  | `ORCHESTRATOR_ROSTER_BOOTSTRAP_ONCHAIN` | `true` | Seed roster from on-chain AgentRegistry on startup |
  | `ORCHESTRATOR_FILTER_INVITES_ONCHAIN_ACTIVE` | `true` | Only invite agents verified active on-chain |
  | `ORCHESTRATOR_ACTIVE_CACHE_TTL_MS` | `15000` | On-chain active status cache TTL |
  | `ORCHESTRATOR_ENABLE_DISCOVERY_DEDUPE` | `true` | Deduplicate contract discoveries within TTL |
  | `ORCHESTRATOR_DISCOVERY_DEDUPE_TTL_MS` | `120000` | Discovery dedup window |
  | `ORCHESTRATOR_WINNER_ANNOUNCE_DEDUP_MS` | `15000` | Dedup window for winner announcements |
  | `HEDERA_LEGACY_GAS_PRICE` | `1111000000000` | Override gas price (wei) for legacy txs |

- **Known issues:**
  - Must be restarted after any code change (no hot reload)
  - Nonce races on concurrent `selectWinners` (auto-retries 3x)
  - `getActiveJobs()` failure causes reconcile skip (benign but degrades over time)

### Agents (agents/ — 7 agents)

| Agent | ID | Status | Specializations | Notes |
|-------|-----|--------|----------------|-------|
| Scanner | `scanner-001` | ✅ Working | discovery, triage, hot-leads | Hedera mirror node polling; 15s prod, 30s demo |
| Static Analysis | `static-analysis-047` | ✅ Working | lending, vault, staking | Calls static-analysis-service; `NO_FALLBACK_MODE=true` default — fails/skips if service down (set `false` for mock fallback) |
| Fuzzer | `fuzzer-012` | ✅ Working | all 9 types | Calls fuzzer-service; purchases static data listings; `NO_FALLBACK_MODE=true` default |
| LLM Contextual | `llm-contextual-003` | ✅ Working | all 9 types | 0g serving broker (qwen-2.5-7b); Claude fallback; skips jobs with riskScore<50 or LOC<1000 |
| Dependency Analyzer | `dependency-analyzer-008` | ✅ Working | — | Responds to SUB_AUCTION_POSTED; supply chain analysis |
| Report Aggregator | `report-aggregator-001` | ✅ Working | — | 120s aggregation (20s DEMO_MODE); writes MD + persists to events-api DB |
| Alert Sentinel | `alert-sentinel-001` | ✅ Working | — | Fires on REPORT_PUBLISHED with criticalCount>0; webhook via ALERT_WEBHOOK_URL |

- **Manager:** `agents/run-all.ts` — launches all 7 agents with MAX_RESTARTS=3, RESTART_BACKOFF_BASE_MS=2000ms, HEALTH_CHECK_INTERVAL_MS=30s
- **Critical bug fixed:** Duplicate `run-all.ts` instances caused two report agents to race on findings store — fixed with `aggregating` mutex flag
- **IMPORTANT:** Always check for stale processes before starting: `ps aux | grep run-all`

#### Scanner Agent Details
- Polls Hedera mirror node (SCANNER_MIRROR_NODE env, default testnet) every `SCANNER_SCAN_INTERVAL_MS` (15s prod) or `SCANNER_SCAN_INTERVAL_DEMO_MS` (30s demo)
- Full classifier pipeline: `contract-classifier.ts` → `risk-blender.ts` → `enrichment.ts` (enabled when `SCANNER_CLASSIFIER_PIPELINE=true`)
- Fetches runtime bytecode; uses `baseline-contract-type.ts` for heuristic classification
- **Hot-lead posting:** Contracts with `riskScore ≥ 80` create a DataMarketplace listing (price=0.1 GUARD, category=HOT_LEAD) before public discovery; 60s delay (10s demo) before publishing on HCS
- `SCANNER_AUTO_REGISTER_ONCHAIN=true` (default) — scanner self-registers with AgentRegistry on startup
- `CONTRACT_FETCH_LIMIT=25` contracts per poll; `SCANNER_MAX_DISCOVERIES_PER_CYCLE=5` (3 demo)
- Runtime bytecode LRU cache: max `SCANNER_RUNTIME_BYTECODE_CACHE_MAX` entries (default 1024)

#### Bidding System
- `agents/shared/bid-policy.ts` — `computeLiveBid()` + `computeScoutedBid()` implement the scouting strategy
- **Scouting window**: agents observe competitor bids on HCS before submitting one bid (AuditAuction allows only 1 bid per agent per job)
- `computeScoutedBid` undercuts lowest competitor by 5%, clamped to floor = `budget × MAX_BID_FRACTION_OF_BUDGET` (default 0.25)
- Bid deadline safety margin: `BID_DEADLINE_SAFETY_MARGIN_MS` (default 15000ms)
- Bid submit timeout: `BID_SUBMIT_TIMEOUT_MS` (default 20000ms)

#### GUARD Auto Top-up
- `agents/shared/guard-autotopup.ts` — agents can auto-top-up each other's GUARD collateral balances
- `BID_GUARD_AUTO_TOPUP_ENABLED=true` (default), buffer=50 GUARD, donor min reserve=200 GUARD, max transfer=500 GUARD
- Donor pool: any of the 9 agent private keys, OPERATOR_PRIVATE_KEY, or AGENT_REGISTRY_OWNER_PRIVATE_KEY

#### Findings Flow
- After analysis, agents POST findings to `static-analysis-service /findings` via `agents/shared/findings-store-client.ts`
- Report agent fetches via `GET /findings/:jobId`, then deletes (one-time read)
- All findings-store calls use 5s timeout and never throw — silently degrade

### Microservices

| Service | Port | Persistence | Status |
|---------|------|-------------|--------|
| `events-api` | 4000 | PostgreSQL only (no in-memory fallback); 6 tables | ✅ Working |
| `static-analysis-service` | 4002 | PostgreSQL `pending_findings` + in-memory Map fallback | ✅ Working (⚠️ real runners require slither/semgrep/aderyn) |
| `fuzzer-service` | 4001 | In-memory job queue only (ephemeral) | ✅ Working (⚠️ tools not installed: ityfuzz, mythril, manticore, heimdall) |

**events-api DB tables** (all idempotent migrations via `db.js`):
- `audit_events` — all HCS messages ingested (primary audit trail)
- `bid_skips` — bid skip decisions per job/agent
- `audit_jobs` — job lifecycle state (synced from orchestrator)
- `registered_agents` — agent state (synced from orchestrator)
- `audit_schedules` — AuditScheduler state
- `audit_vaults` — VaultFactory vaults

**events-api API routes** (all under `/api`):
- `GET/POST /events`, `GET /bid-skips` — HCS event log + bid analytics
- `GET /reports`, `GET /reports/:jobId`, `POST /reports` — audit report CRUD (delegates to `report-db.js`)
- `GET /jobs`, `GET /jobs/:jobId`, `POST /jobs` — job state (POST requires auth)
- `GET /agents`, `POST /agents` — agent state (POST requires auth)
- `GET /schedules`, `POST /schedules` — schedule state
- `GET /vaults`, `POST /vaults` — vault state
- `GET /health` — health check

**audit_reports table** — managed by `packages/sdk/db/report-db.js` (separate from events-api's tables):
- Columns: id, job_id, contract_address, deployer_address, hedera_account_id, chain, contract_type, s3_key, content_hash, cid, md_content, agent_addresses, agent_count, finding_count, findings_by_severity, timestamp, tags, source
- `md_content` stored inline in DB (added via ALTER TABLE migration for old rows)
- Optional S3 upload when `AWS_S3_BUCKET` is set; `s3_key` stores the S3 object key

### Dashboard (packages/dashboard/)
- **Status:** ✅ Working in dev mode; CI/CD ready for Vercel
- **Tech:** React 18, Vite, Zustand, TailwindCSS
- **Tabs:** Live Feed, Agents, Contracts, Analytics (Network/Timeline/Competition), Schedules (Schedules/Vaults/Exchange)
- **All pages implemented:** agent registration, stake delegation, report marketplace, contract health
- **Store:** Zustand store normalizes `riskScore`/`estimatedLOC` field variants from different sources

### iNFT Layer (packages/inft/)
- **Status:** ✅ Collections deployed; mint triggers exist in agent layer; orchestrator handles state transitions
- **Collections:** AG-JOB (`0.0.7946509`), AG-AGENT (`0.0.7946510`), AG-HEALTH (`0.0.7946511`)
- **Storage:** 0g Labs DA (Galileo V3 testnet, chain ID 16602) with local JSON fallback when 0g unreachable
- **Mint flow (agent layer — `agents/shared/inft-bridge.ts`):**
  - `mintAuditJobINFT(params)` — on contract discovery by scanner
  - `mintAgentProfileINFT(params)` — on agent registration
  - `mintContractHealthINFT(params)` — on first audit of a contract
  - All are no-ops if HEDERA_ACCOUNT_ID / OPERATOR_ACCOUNT_ID credentials not configured
- **State transitions (orchestrator layer — `orchestrator/src/inft-bridge.js`):**
  - `updateReputation(agentId, deltaBasisPoints, jobId)` — updates agent NFT reputation
  - `markJobCompleted(jobId, txHash)` — transitions job NFT state to COMPLETED
  - Requires `AGENT_SERIALS_JSON` + `JOB_SERIALS_JSON` env vars (agentId/jobId → serial mappings)

---

## Known Limitations

### One-time setup scripts must run once on the live server
- `npm run wire:delegated-staking` — points StakingManager at DelegatedStaking
- `npm run setup:treasury` — wires Treasury fee splits

---

## Data Persistence — Current Reality

| Data | Where It Lives | Durable? | Lost On? |
|------|---------------|----------|----------|
| Agent registry, reputation, staking | Hedera contracts | ✅ Permanent | Never |
| Job lifecycle, bids, winners | Hedera contracts | ✅ Permanent | Never |
| Payment history | Hedera contracts | ✅ Permanent | Never |
| HCS messages (all events) | Hedera HCS topics | ✅ Permanent | Never |
| Audit reports (markdown) | `agents/data/reports/<jobId>.md` + Docker volume | ✅ Survives restart | Only if volume deleted |
| Audit reports (DB) | PostgreSQL `audit_reports` table (via `report-db.js`); optionally S3 for markdown | ✅ Durable | Only if DB wiped |
| Audit events log | PostgreSQL `audit_events` (events-api) | ✅ Durable | Only if DB wiped |
| Bid skip decisions | PostgreSQL `bid_skips` (events-api) | ✅ Durable | Only if DB wiped |
| Job state cache | PostgreSQL `audit_jobs` (events-api) | ✅ Durable | Only if DB wiped |
| Agent state cache | PostgreSQL `registered_agents` (events-api) | ✅ Durable | Only if DB wiped |
| Schedule state | PostgreSQL `audit_schedules` (events-api) | ✅ Durable | Only if DB wiped |
| Vault state | PostgreSQL `audit_vaults` (events-api) | ✅ Durable | Only if DB wiped |
| Findings during aggregation | PostgreSQL `pending_findings` (static-analysis-service) or in-memory fallback | ✅ Durable (when PG set) | Only if DB wiped |
| Fuzzer job queue | In-memory (fuzzer-service) | ❌ Ephemeral | Process restart |
| iNFT metadata | 0g Labs DA | ✅ Durable | Never (DA guarantee) |

---

## Deployed Addresses (Hedera Testnet)

All in `packages/sdk/config.json`. Key ones:

| Contract | Address | Hedera ID |
|---------|---------|-----------|
| AuditAuction v3 | `0x9e47bBa152F1506F80Ad1168F37A47C66DEE0F5d` | `0.0.8549733` |
| SubAuction v3 | `0xd44D56e5e0870deC8def40EfAD0646dC0Ca75387` | `0.0.8549742` |
| PaymentSettlement v3 | `0x63F5d457fd20De96b98d33158F747D9fCb62d203` | `0.0.8549743` |
| AgentRegistry | `0x24F50cf56e768da01617906f1caa6010f0efe332` | See config.json |
| DataMarketplace | `0xeB85dCAD49cee215EDF9244A4006439DAdEF8e7e` | See config.json |
| AuditScheduler | `0x67d67c1c721241f9350d3eca0c0a1b6d53e69860` | See config.json |
| GuardExchange | `0xD6133Edab4D08D2a66f604217B36E342bc4338B7` | See config.json |
| HbarPool | `0x9102Dc653a0F148B5a8FFbc6a9b2247E596c9CD5` | See config.json |
| Treasury | `0xC4736e92fbd50663b0C1bd68d7Bf6cdC1FC04D9e` | See config.json |
| StakingManager | `0xd76B95CEBdEcf431D3D1376551e6764000e6ffc7` | See config.json |
| DelegatedStaking | `0xdf1400c43f5747c2F783e95B81C68e8bAd792637` | See config.json |

**Operator Keys:**
- Hardhat deployer (contract owner): `PERSONAL_PRIV` → `0xC1E5d505a87FF69CDE44EDd67733C0310A09e859`
- Orchestrator signer: `OPERATOR_PRIVATE_KEY` → `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a`

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
2. ✅ Scanner posts hot-lead DataMarketplace listings for high-risk contracts (riskScore ≥ 80)
3. ✅ Orchestrator creates on-chain auction jobs for discovered contracts
4. ✅ Agents receive invites via HCS, observe competitor bids during scouting window, submit single bid
5. ✅ Winner selection happens on-chain after auction deadline
6. ✅ Winning agent runs static analysis on contract source (via Sourcify)
7. ✅ Findings posted to static-analysis-service store (PostgreSQL when DATABASE_URL set)
8. ✅ Report agent aggregates findings after 120s window (20s demo mode)
9. ✅ Markdown report written to `agents/data/reports/<jobId>.md`
10. ✅ Report posted to events-api `/api/reports` → persisted to `audit_reports` table
11. ✅ Gas price fix working — legacy type-0 txs at 1111 gwei succeed
12. ✅ PostgreSQL schema applied on first boot via docker entrypoint
13. ✅ CI/CD wired: push to main → GHCR image → EC2 deploy (pending secrets)

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
