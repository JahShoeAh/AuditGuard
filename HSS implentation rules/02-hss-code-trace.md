# 02 - HSS Code Trace

## Objective
Trace current HSS flow exactly as implemented across contracts, orchestrator, dashboard, and scanner.

## 1) Contract-Level HSS Flow

## 1.1 Scheduler contract lifecycle
- Contract declaration and purpose: `packages/contracts/contracts/AuditScheduler.sol:24`.
- Trigger modes:
  - `TIME_BASED` and `REDEPLOY`: `packages/contracts/contracts/AuditScheduler.sol:29-33`.
- Primary schedule state struct:
  - `AuditSchedule`: `packages/contracts/contracts/AuditScheduler.sol:36-44`.
- Key events:
  - `AuditScheduled`: `packages/contracts/contracts/AuditScheduler.sol:94`
  - `AuditTriggered`: `packages/contracts/contracts/AuditScheduler.sol:105`
  - `AuditScheduleCancelled`: `packages/contracts/contracts/AuditScheduler.sol:114`
  - `ScheduleFailed`: `packages/contracts/contracts/AuditScheduler.sol:121`

## 1.2 Scheduling entrypoint (`scheduleAudit`)
- Entry function: `packages/contracts/contracts/AuditScheduler.sol:176`.
- Validates contract non-zero + interval bounds:
  - Zero-address check: `packages/contracts/contracts/AuditScheduler.sol:181`
  - Interval checks for `TIME_BASED`: `packages/contracts/contracts/AuditScheduler.sol:183-185`
- For `REDEPLOY`, interval forced to `0`: `packages/contracts/contracts/AuditScheduler.sol:187-189`.
- Replaces old active schedule by deleting prior HSS entity:
  - `packages/contracts/contracts/AuditScheduler.sol:193-196`.
- Creates first schedule for `TIME_BASED`:
  - Due time + `_createSchedule`: `packages/contracts/contracts/AuditScheduler.sol:209-213`.
- `REDEPLOY` path emits schedule with zero address/due:
  - `packages/contracts/contracts/AuditScheduler.sol:214-218`.

## 1.3 Trigger callback (`triggerAudit`)
- Function: `packages/contracts/contracts/AuditScheduler.sol:243`.
- Access control:
  - Must be contract itself (`address(this)`) or orchestrator:
  - `packages/contracts/contracts/AuditScheduler.sol:247-250`.
- Increments trigger count and clears fired schedule pointer:
  - `packages/contracts/contracts/AuditScheduler.sol:252-255`.
- `TIME_BASED` re-schedules next interval using previous due + interval:
  - `packages/contracts/contracts/AuditScheduler.sol:258-265`.
- Emits `AuditTriggered` with `nextScheduleAddress`:
  - `packages/contracts/contracts/AuditScheduler.sol:268-274`.

## 1.4 Redeploy arm (`onRedeployDetected`)
- Function: `packages/contracts/contracts/AuditScheduler.sol:285`.
- Only orchestrator allowed: modifier at `packages/contracts/contracts/AuditScheduler.sol:131-134`.
- No-op unless active `REDEPLOY` mode:
  - `packages/contracts/contracts/AuditScheduler.sol:286-287`.
- Cancels prior pending redeploy schedule before re-arm:
  - `packages/contracts/contracts/AuditScheduler.sol:289-293`.
- Arms immediate delayed schedule:
  - `packages/contracts/contracts/AuditScheduler.sol:295-297`.

## 1.5 Internal HSS call wrapper behavior
- HSS precompile address and selectors:
  - `packages/contracts/contracts/HederaScheduleService.sol:14`
  - selectors at `:18-23`.
- `scheduleCall` wrapper:
  - `packages/contracts/contracts/HederaScheduleService.sol:34-50`.
- `deleteSchedule` wrapper:
  - `packages/contracts/contracts/HederaScheduleService.sol:55-62`.
- `hasScheduleCapacity` wrapper:
  - `packages/contracts/contracts/HederaScheduleService.sol:67-72`.

## 1.6 Failure/deactivation behavior in scheduler
- Capacity pre-check before schedule creation:
  - `packages/contracts/contracts/AuditScheduler.sol:362-366`.
- If `scheduleCall` fails:
  - emits `ScheduleFailed` and deactivates:
  - `packages/contracts/contracts/AuditScheduler.sol:381-384`.
- `_deactivate` deletes current schedule and marks inactive:
  - `packages/contracts/contracts/AuditScheduler.sol:401-410`.

## 1.7 Auction registration of scheduler
- `setAuditScheduler` in auction:
  - `packages/contracts/contracts/AuditAuction.sol:645-649`.
- Event emitted:
  - `AuditSchedulerSet`: `packages/contracts/contracts/AuditAuction.sol:648`.

## 1.8 External interface shape
- `IAuditScheduler` interface:
  - `packages/contracts/contracts/interfaces/IAuditScheduler.sol:6-25`.

---

## 2) Orchestrator HSS Flow

## 2.1 Startup subscription
- Orchestrator boot calls scheduler subscription:
  - `packages/contracts/contracts/AuditScheduler.sol:76-77` (orchestrator concept)
  - `orchestrator/src/orchestrator.js:384` (`this.subscribeSchedulerEvents()`).

## 2.2 Scheduler event listener
- Subscription function:
  - `orchestrator/src/orchestrator.js:2499`.
- On `AuditTriggered`:
  - logs HSS trigger:
  - `orchestrator/src/orchestrator.js:2511-2513`.
  - publishes audit log `HSS_AUDIT_TRIGGERED`:
  - `orchestrator/src/orchestrator.js:2517-2526`.
  - tries enriched discovery publish:
  - `orchestrator/src/orchestrator.js:2535`.
  - queues retry on failure:
  - `orchestrator/src/orchestrator.js:2537-2541`.
- On `AuditScheduleCancelled`:
  - publishes `HSS_SCHEDULE_CANCELLED`:
  - `orchestrator/src/orchestrator.js:2553-2557`.
- On `ScheduleFailed`:
  - warn only:
  - `orchestrator/src/orchestrator.js:2561-2568`.

## 2.3 Scheduled enrichment path
- Enrichment publish helper:
  - `orchestrator/src/orchestrator.js:2386`.
- Discovery payload carries HSS provenance:
  - `triggeredByHSS: true`: `orchestrator/src/orchestrator.js:2403`
  - `scheduleAddress`: `orchestrator/src/orchestrator.js:2404`
  - placeholder deployer `"HSS_SCHEDULE"`: `orchestrator/src/orchestrator.js:2405`.
- Retry queue loop:
  - queue key: `orchestrator/src/orchestrator.js:2364`
  - process loop: `orchestrator/src/orchestrator.js:2454`
  - interval loop start: `orchestrator/src/orchestrator.js:2478`.

## 2.4 Redeploy detection block
- Discovery handler inspects scheduler state:
  - `orchestrator/src/orchestrator.js:1268-1286`.
- Current implementation reads schedule via `getSchedule`:
  - `orchestrator/src/orchestrator.js:1271`.
- For active REDEPLOY (`mode === 1`) it compares bytecode hash:
  - `orchestrator/src/orchestrator.js:1273-1277`.
- Current code stores hash as `sched._bytecodeHash`:
  - `orchestrator/src/orchestrator.js:1275, 1281`.
- This is non-durable because `sched` is a returned struct object per call (not orchestrator state map).

---

## 3) Dashboard HSS Flow

## 3.1 Contract bootstrap layer
- Dashboard creates contracts in:
  - `packages/dashboard/src/services/hedera-connection.js:99`.
- Current return object includes:
  - `auctionContract`, `agentRegistryContract`, `vaultFactoryContract`, etc.:
  - `packages/dashboard/src/services/hedera-connection.js:163-174`.
- No `auditSchedulerContract` is instantiated/returned.

## 3.2 Listener wiring layer
- Hook constructs `storeActions` for listener:
  - `packages/dashboard/src/hooks/useEventListeners.js:44-81`.
- `addHssEvent` is not currently wired into `storeActions`.

## 3.3 Event ingestion layer
- HCS routing entrypoint:
  - `_routeHCSMessage`: `packages/dashboard/src/services/event-listener.js:632`.
- Currently handles discovery/bid/lifecycle logs, but no HSS-to-`addHssEvent` path.
- Contract polling query set:
  - `packages/dashboard/src/services/event-listener.js:1197-1241`.
- Poll includes auction/agent/sub/data/payment/vault/staking/treasury events, but not AuditScheduler events.

## 3.4 Store state slice
- `hssEvents` store slice exists:
  - `packages/dashboard/src/store/index.js:410`.
- `addHssEvent` action exists:
  - `packages/dashboard/src/store/index.js:411-412`.

## 3.5 Schedule rendering
- `AuditSchedules` reads `hssEvents`:
  - `packages/dashboard/src/components/AuditSchedules.jsx:149-150`.
- It supports event types:
  - `AuditScheduled` / `HSS_AUDIT_SCHEDULED`: `:160`
  - `AuditTriggered` / `HSS_AUDIT_TRIGGERED`: `:174`
  - `AuditScheduleCancelled` / `HSS_SCHEDULE_CANCELLED`: `:186`.

---

## 4) Scanner Cadence Context

## 4.1 Effective defaults
- Non-demo default:
  - `DEFAULT_SCAN_INTERVAL_MS = 15_000`: `agents/scanner/index.ts:23`.
- Demo default:
  - `DEFAULT_SCAN_INTERVAL_DEMO_MS = 30_000`: `agents/scanner/index.ts:24`.
- Selection logic:
  - `agents/scanner/index.ts:25-27`.

## 4.2 Runtime scheduling shape
- Immediate first scan:
  - `await scanCycle()`: `agents/scanner/index.ts:1002`.
- Recurrence:
  - `setInterval(scanCycle, SCAN_INTERVAL_MS)`: `agents/scanner/index.ts:1003`.
- Current loop has no explicit single-flight guard around `scanCycle`.

