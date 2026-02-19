# AuditGuard — Current State of Project

> Last updated: 2026-02-19

AuditGuard is an autonomous multi-agent smart contract auditing platform built on Hedera. AI agents bid for audit jobs, execute analysis pipelines, publish findings, and are paid in GUARD tokens — fully on-chain with no manual coordination.

---

## Recent Build Updates (2026-02-19)

- Agent liveness heartbeat is now active end-to-end (`PING` from orchestrator, `PONG` from agents).
- `AUCTION_INVITE` handling in bidding agents is race-safe when invite arrives before discovery queue data.
- Dedicated invite test suite added: `npm run test:agents:invite` (also included in `npm run dev:test`).

## Live Testnet Deployment

| Resource | Value |
|---|---|
| **Network** | Hedera Testnet (chainId 296) |
| **RPC** | `https://testnet.hashio.io/api` |
| **Operator Account** | `0.0.7935670` |
| **GUARD Token** | `0.0.7936262` / `0x0000000000000000000000000000000000791906` |

### Deployed Contracts

| Contract | Hedera ID | EVM Address |
|---|---|---|
| AuditAuction (+ Escrow) | `0.0.95a0...cd88` | `0x95A0A0e78a32c849526d6AC32e98c6829FB2Cd88` |
| AuditBudgetVault | `0.0.68780a...fcd` | _(see sdk/config.json)_ |
| AgentRegistry | _(see sdk/config.json)_ | `0xe86218b5Bf5C21CA7a69cba04C5be0D3c2Be2303` |
| SubAuction | _(see sdk/config.json)_ | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| DataMarketplace | _(see sdk/config.json)_ | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| PaymentSettlement | _(see sdk/config.json)_ | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| VaultFactory | _(see sdk/config.json)_ | — |
| StakingManager | _(see sdk/config.json)_ | — |
| Treasury | _(see sdk/config.json)_ | — |
| DelegatedStaking | _(see sdk/config.json)_ | — |
| TimeLockVault | _(see sdk/config.json → timelockVault)_ | — |
| **AuditScheduler** | `0.0.39abe1...cba5f6` | `0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6` |

> Full addresses live in `packages/sdk/config.json`.

### HCS Topics

| Topic | ID |
|---|---|
| Discovery | `0.0.7940144` |
| Audit Log | `0.0.7940145` |
| Agent Comms | `0.0.7940146` |

---

## Smart Contracts (`packages/contracts/contracts/`)

### Core Protocol

| File | Purpose | Status |
|---|---|---|
| `AuditAuction.sol` | Job creation, bidding, winner selection, escrow + settlement | ✅ Deployed |
| `AgentRegistry.sol` | Agent registration, reputation, stake, specializations | ✅ Deployed |
| `AuditBudgetVault.sol` | Per-vault audit budget; weekly monitoring allocations | ✅ Deployed |
| `AuditVault.sol` | Individual contract vault logic | ✅ Deployed |
| `VaultFactory.sol` | CREATE2 factory for AuditVault; auto-audit triggers | ✅ Deployed |
| `SubAuction.sol` | Secondary auction for specialist sub-tasks (dependency, etc.) | ✅ Deployed |
| `DataMarketplace.sol` | Agents sell scan reports / findings to other agents | ✅ Deployed |
| `PaymentSettlement.sol` | Batch GUARD settlement across contributors | ✅ Deployed |
| `StakingManager.sol` | Agent stake locking, slashing, reputation bonding | ✅ Deployed |
| `DelegatedStaking.sol` | Delegated stake (stakers back agents for a share of rewards) | ✅ Deployed |
| `Treasury.sol` | Platform fee collection and distribution | ✅ Deployed |
| `TimeLockVault.sol` | Time-locked GUARD releases for vesting / bounties | ✅ Deployed |

### HSS Integration (NEW — this session)

| File | Purpose | Status |
|---|---|---|
| `HederaResponseCodes.sol` | Vendored Hedera response code constants | ✅ Compiled |
| `HederaScheduleService.sol` | Vendored HSS base contract (wraps precompile at `0x16b`) | ✅ Compiled |
| `AuditScheduler.sol` | Contract-native recurring audit scheduling via HSS | ✅ **Deployed** `0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6` |
| `interfaces/IAuditScheduler.sol` | Interface consumed by ContractClient | ✅ Done |
| `test/MockHSS.sol` | Test helper — mocks HSS precompile for Hardhat tests | ✅ Done |

### ABIs exported to `packages/sdk/abis/`

`AgentRegistry`, `AuditAuction`, `AuditBudgetVault`, `AuditVault`, `DataMarketplace`, `DelegatedStaking`, `PaymentSettlement`, `StakingManager`, `SubAuction`, `TimeLockVault`, `Treasury`, `VaultFactory`

> `AuditScheduler.json` will be added here after first compile+export or after `deploy:audit-scheduler` runs.

---

## AI Agents (`agents/`)

Seven autonomous agents, each running with its own Hedera testnet account and ECDSA key:

| Agent | Account | Specialization |
|---|---|---|
| Scanner | `0.0.7951944` | Contract discovery, bytecode analysis |
| Static Analysis | `0.0.7951945` | Solidity AST / vulnerability patterns |
| Fuzzer | `0.0.7951946` | Property-based fuzz testing |
| LLM Contextual | `0.0.7951947` | AI-powered contextual review (via 0g Compute) |
| Dependency | `0.0.7951948` | Dependency graph / sub-auction specialist |
| Report | `0.0.7951949` | Aggregates findings → publishes final report |
| Alert | `0.0.7951955` | Critical finding alerts / notifications |

**0g Compute integration:** LLM agent uses `@0glabs/0g-serving-broker` SDK against `qwen-2.5-7b-instruct` at `0xa48f012...`. The broker import is lazy (dynamic `import()` inside `getBroker()`) so a broken ESM build in the package does not crash the agent at startup — it falls back to mock findings gracefully.

**Agent entry points:**
- `npm run agents` — run all agents
- `npm run agents:demo` — demo mode (mock discoveries)
- `npm run scanner` — scanner only

---

## Orchestrator (`orchestrator/src/`)

Coordinates the full pipeline. Key modules:

| File | Role |
|---|---|
| `orchestrator.js` | Main agent — subscribes to HCS topics and contract events, invites agents, selects winners, settles |
| `contract-client.js` | Ethers.js wrappers for all deployed contracts |
| `hcs-client.js` | HCS topic publish/subscribe |
| `roster.js` | In-memory agent registry (tracks pongs, reputation, stake) |
| `inft-bridge.js` | iNFT lifecycle hooks (job created → profile updated → health minted) |
| `config.js` | Reads `packages/sdk/config.json` + `.env` |

**HSS wiring added this session:**
- `subscribeSchedulerEvents()` — listens for `AuditTriggered` on-chain → calls `createAuditJob` automatically
- Redeploy detection in `handleDiscovery()` — calls `auditScheduler.onRedeployDetected()` when scanner detects bytecode change

---

## AuditScheduler — HSS Integration (NEW)

The **Hedera Schedule Service (HSS)** integration allows vault owners to configure recurring audits with zero off-chain keeper involvement.

### Two Trigger Modes

| Mode | Behaviour |
|---|---|
| `TIME_BASED` | Audits fire every N seconds (e.g. every 30 days); contract re-schedules itself inside `triggerAudit()` |
| `REDEPLOY` | Orchestrator calls `onRedeployDetected(contractAddress)` when scanner detects new bytecode hash; HSS fires an immediate audit |

### Flow (TIME_BASED example)

```
Vault owner calls AuditScheduler.scheduleAudit(addr, 30 days, TIME_BASED)
  → AuditScheduler calls HSS.scheduleCall(this.triggerAudit, now+30d)
  → [30 days later] Hedera network calls AuditScheduler.triggerAudit(addr)
  → AuditScheduler re-schedules next cycle + emits AuditTriggered
  → Orchestrator sees AuditTriggered → calls AuditAuction.createAuditJob(addr)
  → Full bidding → auditing → reporting pipeline runs autonomously
```

### Deploy

```bash
npm run deploy:audit-scheduler
# Reads guardToken + auctionContract from packages/sdk/config.json
# Calls AuditAuction.setAuditScheduler(schedulerAddress)
# Writes auditScheduler address back to config.json
```

---

## Dashboard (`packages/dashboard/`)

React + Vite SPA. Tabs:

| Tab | Key Components |
|---|---|
| **LIVE FEED** | DiscoveryFeed, AuctionFeed, AuditJobTracker, PaymentFlow |
| **AGENTS** | AgentLeaderboard, ReputationComparison, ReputationGraph, StakingChart |
| **CONTRACTS** | ContractHealth, AuditJobTracker, VaultDetail |
| **ANALYTICS** | NetworkGraph, SettlementTimeline, TreasuryEconomics, CompetitionHeatmap |
| **SCHEDULES** _(NEW)_ | AuditSchedules — HSS schedule lifecycle per contract |

State management: Zustand store (`packages/dashboard/src/store/index.js`)  
New store slice: `hssEvents[]` + `addHssEvent()` for HSS event tracking.

---

## Deploy Scripts (`scripts/`)

| Script | Command | Purpose |
|---|---|---|
| `deploy-guard-token.js` | `npm run deploy:token` | Deploy GUARD HTS token |
| `deploy-all.js` | `npm run deploy:contracts` | Deploy all core contracts |
| `deploy-timelock.js` | `npm run deploy:timelock` | Deploy TimeLockVault |
| `deploy-delegated-staking.js` | _(manual)_ | Deploy DelegatedStaking |
| `setup-hcs-topics.js` | `npm run setup:hcs` | Create HCS topics |
| `deploy-audit-scheduler.js` | `npm run deploy:audit-scheduler` | Deploy AuditScheduler (HSS) |

---

## Tests

### Contract Tests (`packages/contracts/test/`)

| File | Coverage |
|---|---|
| `AuditGuard.test.js` | Core protocol: auction lifecycle, settlements, staking |
| `AuditScheduler.test.js` _(NEW)_ | HSS scheduling: TIME_BASED, REDEPLOY, triggerAudit, cancelSchedule, access control |

Run: `npm test` (root)

### Agent / Integration Tests (`agents/tests/`)

| File | Coverage |
|---|---|
| `agents.test.ts` | Individual agent unit tests |
| `e2e-flow.test.ts` | Full pipeline: discovery → auction → findings → settlement |
| `health-monitoring.test.ts` | Contract health monitoring flow |
| `shared.test.ts` | Shared types and utilities |
| `timelock-pipeline.test.ts` | TimeLock vault + pipeline integration |

Run: `npm --prefix agents test`

---

## Third-Party Integrations

| Service | Usage | Status |
|---|---|---|
| **Hedera Token Service (HTS)** | GUARD token transfers (`0x167`) | ✅ Live |
| **Hedera Consensus Service (HCS)** | Agent messaging, audit log, discovery | ✅ Live |
| **Hedera Schedule Service (HSS)** | Recurring audit scheduling (`0x16b`) | ✅ Contract built; deploy pending |
| **0g Compute Network** | LLM inference for contextual agent | ✅ Configured (`ZG_ENABLED=true`) |
| **0g Data Availability** | Findings / report storage | ✅ Integrated |
| **iNFT (via HTS)** | Audit Job NFT, Agent Profile NFT, Contract Health NFT | ✅ Collections created |

---

## Pending / Next Steps

- [ ] **Call `setAuditScheduler` on AuditAuction** — deployer account (`0x49b1...8B9b`) is not the AuditAuction owner; the AuditAuction owner must call `setAuditScheduler(0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6)`
- [ ] **Set orchestrator on AuditScheduler**: `scheduler.setOrchestrator(ORCHESTRATOR_ADDRESS)`
- [ ] **Export AuditScheduler ABI** to `packages/sdk/abis/AuditScheduler.json`
- [ ] **Test HSS on testnet**: call `scheduleAudit()` and observe `AuditTriggered` on HashScan
- [x] ~~**Deploy AuditScheduler** to testnet~~ ✅ `0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6`
- [ ] Wire `addHssEvent` calls in the dashboard's event-listener service to feed the Schedules tab live data
- [ ] Consider deploying to Hedera Mainnet for production

---

## Runtime Fixes Applied (2026-02-18)

| # | File | Problem | Fix |
|---|---|---|---|
| 1 | `agents/llm-contextual/zg-client.ts` | Static `import { createZGComputeNetworkBroker }` from `@0glabs/0g-serving-broker` has a broken ESM chunk (`index-c28a795c.js` missing export `C`). Node resolves static imports before any code runs, so the LLM agent crashed immediately on every start (3 restarts → permanently down). | Changed to a dynamic `await import(...)` inside `getBroker()`. The broken module is only loaded if `ZG_PRIVATE_KEY` is configured; without it the agent skips 0g entirely and uses mock fallback. All 7 agents now start cleanly. |
| 2 | `agents/shared/wallet.ts` | `ethers.JsonRpcProvider` batches RPC calls by default. Hedera's JSON-RPC relay rejects `eth_newFilter` inside a batch (error `-32007`). Static and Fuzzer agents were logging this every ~4 seconds while polling for `WinnersSelected` events. | Added `{ batchMaxCount: 1 }` to the provider constructor, disabling batching. Each RPC call now goes out individually; `eth_newFilter` is accepted. |
| 3 | `agents/shared/contract-client.ts` | Same batching issue as #2 in the `fromPrivateKey` static factory. | Same fix: `{ batchMaxCount: 1 }`. |

---

## Directory Structure

```
AuditGuard/
├── agents/                     # 7 AI agents (TypeScript)
│   ├── scanner/
│   ├── static-analysis/
│   ├── fuzzer/
│   ├── llm-contextual/
│   ├── dependency/
│   ├── report/
│   ├── alert/
│   └── shared/                 # Shared types, message bus, HCS client
├── orchestrator/               # Coordinator agent (JS)
│   └── src/
├── packages/
│   ├── contracts/              # Solidity contracts + Hardhat
│   │   ├── contracts/          # 15 .sol files
│   │   ├── test/               # 2 test files
│   │   └── scripts/            (alias of root /scripts/)
│   ├── dashboard/              # React + Vite observability UI
│   │   └── src/
│   │       ├── components/     # 35+ components
│   │       └── store/          # Zustand state
│   ├── sdk/
│   │   ├── abis/               # 12 compiled ABIs
│   │   └── config.json         # Deployed addresses
│   └── inft/                   # iNFT collection management
├── scripts/                    # Deploy + setup scripts (Node.js)
├── .env                        # Live testnet credentials + addresses
└── package.json                # Monorepo scripts
```

---

## What's Functional in the Live Demo

### ✅ Fully Live (Real On-Chain Transactions)

**Contracts — all deployed on Hedera Testnet, confirmed real transactions:**
- `AuditAuction` — job creation, bid submission, winner selection, escrow, settlement
- `AgentRegistry` — agent registration, reputation, tiering
- `AuditBudgetVault` — GUARD deposits, payment draws
- `DataMarketplace` — listings, purchases, ratings
- `SubAuction` — sub-task auctions, contractor selection
- `PaymentSettlement` — batch GUARD settlement
- `StakingManager` — staking, slashing, appeals
- `DelegatedStaking` — delegator backing
- `Treasury` — fee collection
- `TimeLockVault` — time-locked releases
- `VaultFactory` — vault creation

**HCS (Hedera Consensus Service):**
- All 3 topics (`Discovery`, `AuditLog`, `AgentComms`) are live and receiving real messages
- Dashboard polls the HCS mirror node every 4s and displays real messages as they arrive

**Dashboard event-listener:**
- Listens for real on-chain events: `JobPosted`, `BidSubmitted`, `WinnersSelected`, `AgentRegistered`, `DataListed`, `DataPurchased`, `JobSettled`, `Staked`, `SlashInitiated`, `FeeReceived`, and ~20 more — all against real testnet contracts

---

### ⚠️ Partially Real (Real Pipeline, Simulated Findings)

**Agent bidding — Real:**
- Agents authenticate with their own Hedera wallet
- Bids are submitted as real on-chain transactions via `AuditAuction.submitBid()`
- Winner selection happens on-chain

**Agent audit findings — Simulated/Generated:**
- **Scanner:** Contract addresses are `randomHex(40)` — not real deployed contracts being discovered
- **Fuzzer, Static Analysis, Dependency, Report, Alert:** Findings are generated via `generateFindings()` using randomized severity/titles — not real code analysis
- **LLM Agent:** Attempts real 0g inference (`qwen-2.5-7b-instruct` via 0g Compute Network at `ZG_ENABLED=true`). Falls back to `generateMockFindings()` if 0g is unavailable or the response fails to parse

**DataMarketplace purchases — Real:**
- When an agent buys a scan report, `purchaseData()` is a real on-chain transaction
- The "data" being sold is the keccak hash of simulated findings

---

### ❌ Not Yet Live

| Feature | Reason |
|---|---|
| **AuditScheduler (HSS)** | Built and compiled; not yet deployed — run `npm run deploy:audit-scheduler` |
| **Real contract scanning** | Scanner generates random hex addresses, not real Ethereum/Hedera contracts |
| **iNFT minting** | Collections created; minting is wired but depends on settlement events that don't yet fire in demo flow |
| **Discord alerts** | `DISCORD_WEBHOOK_URL` is empty in `.env` |

---

### Live Demo Honesty Summary

| Layer | Status | Notes |
|---|---|---|
| GUARD token (HTS) | ✅ Real | Fully functional on testnet. |
| HCS messaging | ✅ Real | Topics are live; Dashboard polls mirror node. |
| Smart contract transactions | ✅ Real | Bids, escrow, settlements, staking are real txs. |
| **Agent Registry (Dashboard)** | ✅ Real (Synced) | Dashboard fetches full registration history on startup. |
| **iNFT Minting** | ✅ Live | Successfully minting Audit Job & Contract Health iNFTs to 0g Storage. |
| Agent auction participation | ✅ Real | Real wallet transactions for bids & wins. |
| Agent audit findings | ⚠️ Simulated | Logic is mock/randomized; not real static analysis. |
| LLM analysis (0g Compute) | ⚠️ Hybrid | Agent starts cleanly (7/7 healthy). Attempts real inference; falls back to mock if 0g broker unavailable (`ZG_PRIVATE_KEY` not set or broker ESM broken). |
| **HSS Scheduling** | ⚠️ Partial | Contract deployed (`0x39AB...`); Orchestrator missing ABI; not yet fully integrated. |

### Known Issues
- **Dashboard Agent List**: The "Agents" tab will be empty if you open the dashboard *after* agents have already started. Restarting agents (`npm run agents`) while the dashboard is open will populate the list.
- **RPC Rate Limits**: Occasional `429` errors from Hedera public mirror node during high traffic.
- **HSS Integration**: `AuditScheduler` is deployed but `orchestrator` logs "ABI missing", preventing automatic scheduling.
- **Orchestrator HCS INVALID_SIGNATURE**: `JOB_CREATED` and `AUCTION_INVITE` HCS messages fail precheck — the operator key on account `0.0.7935670` may be rotated or the `.env` key doesn't match.
- **ENS on Hedera**: Orchestrator logs one-time warn `network does not support ENS` when creating an auction — ethers.js tries ENS resolution on chainId 296. Non-blocking; falls back to off-chain.
