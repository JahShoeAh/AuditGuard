# AuditGuard — 10-Hour MVP Sprint Plan

> Updated 2026-02-18. Reflects actual current state. Organized into four ~2.5-hour sprints.
> ✅ = already done and working | 🔧 = needs work | ❌ = not started

---

## Sprint 1 (Hours 0–3): Fix the Critical Pipeline Break

The core issue: the orchestrator can't publish to HCS (INVALID_SIGNATURE), so `AUCTION_INVITE` messages never reach agents → agents never bid. Nothing works until this is fixed.

---



### Person 1 — Contracts

- ✅ All core contracts deployed on Hedera testnet
- ✅ AuditScheduler deployed (`0x39ABE1e38DBD77a89E445Ab9957C3c9B27CBA5f6`)
- 🔧 **Export AuditScheduler ABI** → `packages/sdk/abis/AuditScheduler.json`
- 🔧 **Call `AuditAuction.setAuditScheduler(schedulerAddr)`** — must be called by AuditAuction owner
- 🔧 **Call `AuditScheduler.setOrchestrator(orchestratorAddr)`** — wires the trigger chain
- 🔧 **Verify GUARD balances** for all 7 agent accounts (`0.0.7951944`–`0.0.7951955`); top up if needed for collateral

---

### Person 2 — Agents / Orchestrator

- ✅ All 7 agents implemented and running (`npm run agents`)
- ✅ Orchestrator subscribes to HCS topics, invites agents, selects winners
- 🔧 **Fix Orchestrator HCS INVALID_SIGNATURE** — `JOB_CREATED` and `AUCTION_INVITE` fail precheck; `.env` operator key for account `0.0.7935670` likely doesn't match the on-chain key. Verify, rotate, or re-import the correct ECDSA key.
- 🔧 **Confirm agents receive `AUCTION_INVITE`** — after signature fix, tail orchestrator logs to verify invite delivery
- 🔧 **Confirm agents submit on-chain bids** — tail agent logs for `On-chain bid submitted (tx: ...)` not `On-chain bid failed`

---

### Person 3 — iNFT

- ✅ Three iNFT collections deployed (AG-JOB `0.0.7946509`, AG-AGENT `0.0.7946510`, AG-HEALTH `0.0.7946511`)
- ✅ `discovery-listener.js` mints iNFTs on new contract discovery
- ✅ `event-listener.js` transitions iNFT states on contract events
- 🔧 **Restart iNFT listeners with rate limiting** — they were killed; restart after orchestrator HCS fix so they don't mint on stale/broken events
- 🔧 **Verify end-to-end iNFT state transitions**: DISCOVERED → AUCTION_OPEN → AUDITING_IN_PROGRESS → COMPLETED on one real job
- 🔧 **Confirm 0g storage writes** — check `packages/inft/data/inft-state.json` updates after a real cycle

---

### Person 4 — Dashboard

- ✅ TX explorer type mismatch fixed (`BID_SUBMITTED` → `BidSubmitted` normalized in HCS route)
- ✅ All dashboard tabs implemented (Live Feed, Agents, Contracts, Analytics, Schedules)
- 🔧 **Fix "Agents tab empty on load"** — dashboard opened before agents register shows nothing; `_syncHistoricalAgents()` should backfill from `AgentRegistered` events, verify it's running
- 🔧 **Verify TX explorer shows real bids** — once pipeline fix lands, confirm BID badge appears in AUCTIONS filter with correct agent name and amount
- 🔧 **Add `BidRefunded` entry to TX explorer display** — currently no label rendered for losing bidder refunds; add to `TransactionRow.jsx` describe()

---

## Sprint 2 (Hours 3–6): Wire the Full Auction Cycle

Goal: one complete autonomous cycle visible in the dashboard with real on-chain transactions — discovery → auction open → 3+ bids → winner selected → findings submitted → settlement paid.

---

### Person 1 — Contracts

- 🔧 **Pre-fund `PaymentSettlement` / `AuditBudgetVault`** with enough GUARD to cover at least 3 test cycles (orchestrator settlement needs sufficient escrow)
- 🔧 **Test `AuditScheduler.scheduleAudit()`** on testnet for a dummy address — confirm `AuditTriggered` event fires and is visible on HashScan
- 🔧 **Verify `AgentRegistry` has all 7 agents registered** with correct stake amounts (check `completedJobs`, `reputation`, `tier` on-chain)

---

### Person 2 — Agents / Orchestrator

- 🔧 **Run full cycle smoke test** — trigger a discovery manually, watch the complete pipeline end-to-end: orchestrator opens auction → agents bid → winner selected → agents submit findings → report agent aggregates → settlement fires
- 🔧 **Fix LLM agent 0g inference** — set `ZG_PRIVATE_KEY` in `.env` or confirm graceful fallback to mock is acceptable for demo
- 🔧 **Ensure sub-auction fires** — `LLMContextual` agent must post a `SUB_AUCTION_POSTED` on HCS after winning, triggering `DependencyAgent` to bid on the sub-task; verify this in orchestrator logs
- 🔧 **Fix or suppress ENS warning** — `network does not support ENS` log is noisy; add `staticNetwork` option to provider to silence it

---

### Person 3 — iNFT

- 🔧 **Wire Agent Profile iNFT updates** — after winner selection and settlement, `agentProfile` iNFT should increment `completedJobs`, update `totalEarned`, and add to `jobHistory`
- 🔧 **Wire Contract Health iNFT after job completion** — `securityScore` and `auditHistory` should update from `AuditVault.AuditRecorded` event
- 🔧 **Verify 0g DA upload** — at least one findings report stored on 0g with a real `rootHash` (not null); confirm with `storage-0g.js` logs

---

### Person 4 — Dashboard

- 🔧 **Wire `addHssEvent` in `event-listener.js`** — `VAULT_CREATED` and `AUTO_AUDIT_TRIGGERED` events should populate the `hssEvents[]` store slice so the Schedules tab shows live data
- 🔧 **Verify AuditJobTracker shows live cycle** — cards should progress through DISCOVERED → AUCTION OPEN → IN PROGRESS → SETTLED with correct timestamps
- 🔧 **Verify PaymentFlow / GUARD flow animations fire** on settlement — `addGuardFlow()` calls from real `JobSettled` events should animate vault → agent flows in the Live Feed tab

---

## Sprint 3 (Hours 6–9): Integration Polish

Goal: every dashboard tab shows meaningful real data, all known bugs are resolved, and the system runs continuously without manual intervention for at least 30 minutes.

---

### Person 1 — Contracts

- 🔧 **Test TIME_BASED HSS schedule** — call `scheduleAudit(addr, intervalSec=300, TIME_BASED)`, confirm `AuditTriggered` fires after the interval, and orchestrator automatically opens a new auction
- 🔧 **Verify staking/slashing** — confirm `StakingManager.slash()` works on a falsely-reported finding; check reputation drop in `AgentRegistry`
- 🔧 **Confirm `DataMarketplace` on-chain purchases** — agents buying scan reports from each other should show real `DataPurchased` events on HashScan

---

### Person 2 — Agents / Orchestrator

- 🔧 **Discord alert** — set `DISCORD_WEBHOOK_URL` in `.env` and verify Alert agent fires on any CRITICAL finding
- 🔧 **Agent health monitoring** — `run-all.ts` auto-restarts crashed agents; confirm all 7 stay healthy through a 30-min continuous run
- 🔧 **Dynamic pricing validation** — after 2+ cycles, confirm `bidMultiplier` in static-analysis agent adjusts based on win rate (log `Dynamic pricing: winRate=X%` messages)
- 🔧 **Demo script** — write `agents/run-demo.ts` that triggers a discovery every 90 seconds for a 10-minute demo loop; confirms scanner, orchestrator, and agents all respond automatically

---

### Person 3 — iNFT

- 🔧 **Leaderboard data from iNFTs** — `AgentLeaderboard` in dashboard should reflect real reputation, job counts, and earnings from Agent Profile iNFTs; confirm data flows via `packages/inft/data/inft-state.json` or a query API
- 🔧 **iNFT query endpoint (optional)** — lightweight Express endpoint on `localhost:3001/inft/:type/:serial` for dashboard to fetch live iNFT metadata without reading JSON files directly
- 🔧 **Verify monitoring iNFT** — after `AuditVault.MonitoringApplied` event, `contractHealth` iNFT `monitoring.isActive` = true; visible in dashboard ContractHealth card

---

### Person 4 — Dashboard

- 🔧 **Schedules tab live data** — AuditSchedules component should show real `scheduleAudit()` entries and their next trigger times
- 🔧 **Story Mode end-to-end pass** — walk through the full Story Mode narration with real data; update any hardcoded mock values that no longer match live state
- 🔧 **Network graph shows real agent edges** — `DATA_PURCHASE` and `SUB_CONTRACT` flows from real on-chain events should create edges between agent nodes in the NetworkGraph
- 🔧 **Performance** — if `auditLog` grows large (200+ entries) during the 30-min run, verify the 200-entry slice cap in `TransactionExplorer.jsx` keeps the UI smooth

---

## Sprint 4 (Hours 9–10): Demo Rehearsal & Recording

Goal: a clean, unrehearsed demo run with no manual intervention. Anyone watching understands what's happening.

---

### All

- 🔧 **Full reset and cold start** — `store.resetAll()` in debug panel, restart all services, confirm the system boots from zero and populates on its own within 5 minutes
- 🔧 **30-minute autonomous run** — let the system run without touching it; confirm at least 3 complete auction cycles complete with real HashScan-verifiable transactions
- 🔧 **Demo talking points** — one paragraph per tab explaining what's real vs. simulated; match dashboard language to what the contracts actually do
- 🔧 **Record video** — screen capture: Live Feed → Agents tab → TX Explorer (AUCTIONS filter showing BID badges) → Contracts → Analytics → HashScan TX links

---

## What Is Already Complete (No Sprint Work Needed)

| Component | Status |
|---|---|
| All 12 Solidity contracts | ✅ Deployed on Hedera testnet |
| GUARD token (HTS) | ✅ Live, all agents funded |
| HCS topics (Discovery, AuditLog, AgentComms) | ✅ Live, receiving messages |
| All 7 AI agents + orchestrator | ✅ Running, healthy |
| Agent on-chain bidding (real wallet txs) | ✅ Working when pipeline is unblocked |
| DataMarketplace purchases | ✅ Real on-chain txs |
| PaymentSettlement | ✅ Working |
| iNFT collections (AG-JOB, AG-AGENT, AG-HEALTH) | ✅ Created on HTS |
| iNFT discovery listener + event listener | ✅ Implemented (stopped; restart after HCS fix) |
| Dashboard (all tabs, all components) | ✅ Fully implemented |
| Dashboard mock event cycle (75s loop) | ✅ Working for offline demos |
| TX explorer BID_SUBMITTED normalization | ✅ Fixed this session |
| AuditScheduler contract | ✅ Deployed |
| 0g DA storage integration | ✅ Integrated |
| Agent-to-agent sub-auction flow | ✅ Implemented |

---

## Critical Path (If Time Is Short)

If only one person can work, do these in order:

1. **Fix Orchestrator HCS key** (Person 2) — unlocks everything downstream
2. **Verify agents bid on-chain** (Person 2) — confirms the core value prop
3. **Export AuditScheduler ABI + wire setAuditScheduler** (Person 1) — enables HSS demo
4. **Wire HSS Schedules tab** (Person 4) — visible differentiation from other projects
5. **iNFT state transitions end-to-end** (Person 3) — completes the full narrative
