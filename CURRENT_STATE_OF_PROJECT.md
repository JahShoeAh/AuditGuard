# AuditGuard — Current State of Project

> Last updated: 2026-02-19

AuditGuard is an autonomous multi‑agent smart contract auditing platform built on Hedera. AI agents bid for audit jobs, execute analysis pipelines, publish findings, and are paid in GUARD tokens – fully on‑chain with no manual coordination.

---

## Agents (`agents/`)

| Agent | Account | Specialization |
|---|---|---|
| Scanner | `0.0.7951944` | Contract discovery, bytecode analysis |
| Static Analysis | `0.0.7951945` | Solidity AST / vulnerability patterns |
| Fuzzer | `0.0.7951946` | Property‑based fuzz testing |
| LLM Contextual | `0.0.7951947` | AI‑powered contextual review (via 0g Compute) |
| Dependency | `0.0.7951948` | Dependency graph / sub‑auction specialist |
| Report | `0.0.7951949` | Aggregates findings → publishes final report |
| Alert | `0.0.7951955` | Critical finding alerts / notifications |

**Notable runtime changes** – the LLM agent now lazily imports the `@0glabs/0g-serving-broker` SDK, falling back to a mock broker if the ESM bundle is broken. The `agents/shared/wallet.ts` provider now disables batching so that `eth_newFilter` calls succeed on Hedera’s JSON‑RPC relay.

**Entrypoints**
```
npm run agents            # run all agents
npm run agents:demo       # demo mode (mock discoveries)
npm run scanner          # scanner only
```

---

## Orchestrator (`orchestrator/src/`)

Main modules:
- **orchestrator.js** – agent discovery, invitation, winner selection, settlement.
- **contract-client.js** – Ethers wrappers for all deployed contracts.
- **hcs-client.js** – HCS topic subscribe/publish.
- **roster.js** – in‑memory agent registry tracking heartbeats.
- **inft-bridge.js** – iNFT lifecycle hooks.
- **config.js** – reads `packages/sdk/config.json` + `.env`.

**HSS wiring** –`subscribeSchedulerEvents()` now listens for `AuditTriggered` events coming from the `AuditScheduler` contract and auto‑creates audit jobs.

---

## Audit Scheduler – HSS Integration

| Trigger | Behaviour |
|---|---|
| `TIME_BASED` | Audits fire every *N* seconds (e.g. 30 days). The scheduler re‑schedules itself inside `triggerAudit()` and emits `AuditTriggered`.
| `REDEPLOY` | The orchestrator calls `onRedeployDetected(contract)` when the scanner sees new bytecode; HSS fires an immediate audit.

The contract is deployed at `0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6` and emits the `AuditTriggered` event. The `AuditScheduler` ABI will be exported to `packages/sdk/abis/AuditScheduler.json`.

---

## Smart Contracts (`packages/contracts/contracts/`)

| Contract | Deployed Status |
|---|---|
| `AuditAuction.sol` | ✅ deployed |
| `AgentRegistry.sol` | ✅ deployed |
| `AuditBudgetVault.sol` | ✅ deployed |
| `AuditVault.sol` | ✅ deployed |
| `VaultFactory.sol` | ✅ deployed |
| `SubAuction.sol` | ✅ deployed |
| `DataMarketplace.sol` | ✅ deployed |
| `PaymentSettlement.sol` | ✅ deployed |
| `StakingManager.sol` | ✅ deployed |
| `DelegatedStaking.sol` | ✅ deployed |
| `Treasury.sol` | ✅ deployed |
| `TimeLockVault.sol` | ✅ deployed |
| `AuditScheduler.sol` | ✅ deployed via HSS |

**ABIs** – exported to `packages/sdk/abis/`. `AuditScheduler.json` will be added after the first compile.

---

## Dashboard (`packages/dashboard/`)

React/Vite SPA with the following tabs:
- **Live Feed** – discovery, auction, audit, payments
- **Agents** – leaderboard, reputations
- **Contracts** – health, job tracker, vault detail
- **Analytics** – network graph, treasury economics
- **Schedules** – new HSS schedule lifecycle view

State is managed by a Zustand store that now includes an `hssEvents` slice.

---

## Deploy Scripts (`scripts/`)

| Script | Command | Purpose |
|---|---|---|
| `deploy-guard-token.js` | `npm run deploy:token` | Deploy GUARD HTS token |
| `deploy-all.js` | `npm run deploy:contracts` | Deploy core contracts |
| `deploy-timelock.js` | `npm run deploy:timelock` | Deploy TimeLockVault |
| `deploy-audit-scheduler.js` | `npm run deploy:audit-scheduler` | Deploy AuditScheduler (HSS) |
| `setup-hcs-topics.js` | `npm run setup:hcs` | Create HCS topics |

---

## Tests

- **Contract Tests** – `packages/contracts/test/` (including `AuditScheduler.test.js`).
- **Agent Tests** – `agents/tests/` (unit, e2e, health‑monitoring, timelock pipeline).

Run via `npm test` (root) or `npm --prefix agents test`.

---

## Third‑Party Integrations

| Service | Usage | Status |
|---|---|---|
| Hedera Token Service (HTS) | GUARD token transfers | ✅ live |
| Hedera Consensus Service (HCS) | Messaging, audit log, discovery | ✅ live |
| Hedera Schedule Service (HSS) | Recurring audit scheduling | ✅ contract built, deployed |
| 0g Compute Network | LLM inference | ✅ configured |
| 0g Data Availability | Findings storage | ✅ integrated |
| iNFT (via HTS) | Job, profile, contract health NFTs | ✅ collections created |

---

## Pending / Next Steps

- ✅ Deploy AuditScheduler (already done).
- Set `AuditAuction.setAuditScheduler()` once the Auction owner calls it.
- Wire `addHssEvent` calls in the dashboard event‑listener for live schedule data.
- Verify orchestrator has the `AuditScheduler` ABI and can call `scheduleAudit()`.
- Expand production deployment to Hedera Mainnet.

---

## Runtime Fixes Applied (2026-02-18)

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `agents/llm-contextual/zg-client.ts` | Static import failed due to broken ESM export. | Switched to dynamic `import()` inside `getBroker()` and added runtime fallback to mock broker. |
| 2 | `agents/shared/wallet.ts` | Provider batching caused `eth_newFilter` errors. | Disabled batching by using `{ batchMaxCount: 1 }` when constructing `JsonRpcProvider`. |
| 3 | `agents/shared/contract-client.ts` | Same batching issue. | Applied the same `{ batchMaxCount: 1 }` fix. |

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
│   └── shared/                 # shared utilities
├── orchestrator/               # Coordinator agent (JS)
│   └── src/
├── packages/
│   ├── contracts/              # Solidity contracts & Hardhat
│   │   └── contracts/          # .sol files
│   │   └── test/               # contract tests
│   ├── dashboard/              # React UI
│   ├── sdk/                    # ABIs & config
│   └── inft/                   # iNFT collection
├── scripts/                    # deployment & setup scripts
├── .env                        # testnet credentials & addresses
└── package.json                # monorepo scripts
```

---

## Live Demo Honesty Summary

| Layer | Status | Notes |
|---|---|---|
| GUARD token | ✅ live | HTS transfers work |
| HCS messaging | ✅ live | Discovery, logs, comms are active |
| Smart contracts | ✅ live | All core contracts deployed and interacting |
| Agent bidding | ✅ live | Real on-chain bids and winner selection |
| LLM inference | ⚠️ hybrid | Works when broker is available; falls back to mock |
| HSS scheduling | ✅ live | Scheduler deployed and emits events |
| Dashboard | ⚠️ partial | Agents list may be empty if agents pre‑started; schedules tab requires wired event listener |

---

## Known Issues
- Dashboard agent list may be empty if agents have already been started.
- Occasionally hitting `429` limits on Hedera’s public mirror node.
- Orchestrator missing `AuditScheduler` ABI – prevents automatic scheduling.
- `JOB_CREATED`/`AUCTION_INVITE` HCS messages can fail due to operator key rotations.
- ENS resolution warnings on Hedera network (non‑critical).