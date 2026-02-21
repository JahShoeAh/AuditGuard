# 04 - HSS RE-Audit Implementation Plan

## Objective
Implement HSS RE-Audit integration in a minimal, conflict-safe way that does not break existing UI/backend behavior.

## Phase Summary
1. Complete dashboard HSS schedule ingestion from HCS + contract polling.
2. Harden orchestrator redeploy-bytecode detection durability.
3. Optionally harden orchestrator write serialization for non-queued paths.
4. Add scanner single-flight guard while keeping 15s cadence defaults.
5. Verify with deep regression tests and existing critical test suites.

---

## Phase 1 - Dashboard HSS Ingestion Completion

## 1.1 Wire `addHssEvent` into listener startup
- File: `packages/dashboard/src/hooks/useEventListeners.js`
- Change:
  - add `addHssEvent: useStore.getState().addHssEvent` to `storeActions`.
- Constraint:
  - no other store action behavior changes.

## 1.2 Add AuditScheduler contract bootstrap to dashboard connection
- File: `packages/dashboard/src/services/hedera-connection.js`
- Changes:
1. Import `AuditSchedulerABI` from `@sdk/abis/AuditScheduler.json`.
2. If `config.contracts.auditScheduler?.evmAddress` exists, create:
   - `auditSchedulerContract = new Contract(address, AuditSchedulerABI.abi, provider)`.
3. Return `auditSchedulerContract` in the contracts object.
- Constraints:
  - keep all existing contract instances unchanged.
  - no fallback mock behavior changes beyond additive scheduler support.

## 1.3 Route HSS HCS audit-log events into `hssEvents`
- File: `packages/dashboard/src/services/event-listener.js`
- In `_routeHCSMessage(...)`:
1. Add mappings for `parsedData.type`:
   - `HSS_AUDIT_TRIGGERED`
   - `HSS_SCHEDULE_CANCELLED`
   - optional forward-compatible: `HSS_AUDIT_SCHEDULED`, `HSS_SCHEDULE_FAILED`.
2. Normalize payload and call:
   - `this.store.addHssEvent?.(normalizedEvent)`.
3. Keep existing log-entry behavior intact.
- Constraints:
  - do not alter existing discovery/bid/winner flow logic.

## 1.4 Poll scheduler contract events and push to `hssEvents`
- File: `packages/dashboard/src/services/event-listener.js`
- In contract polling query list:
1. Add scheduler queries when `auditSchedulerContract` exists:
   - `AuditScheduled`
   - `AuditTriggered`
   - `AuditScheduleCancelled`
   - `ScheduleFailed`
2. For each polled event:
   - add normalized `hssEvents` entry via `addHssEvent`
   - keep log/telemetry entries for explorer continuity.
- Constraints:
  - preserve critical-query fail-close behavior for auction queries.

## 1.5 Add cross-source HSS dedupe
- File: `packages/dashboard/src/services/event-listener.js`
- Add stable dedupe key for schedule-state mutation path, example:
  - `hss:${type}:${contractAddressLower}:${scheduleAddressOr0}:${triggeredAtOr0}:${timesTriggeredOr0}`.
- Prevent double-processing when both HCS and contract poll carry same logical event.

---

## Phase 2 - Orchestrator Redeploy Hash Durability Fix

- File: `orchestrator/src/orchestrator.js`

## 2.1 Add durable map in constructor
1. Initialize:
   - `this.redeployBytecodeByContract = new Map();`

## 2.2 Replace transient `_bytecodeHash` approach
In discovery redeploy block (`orchestrator/src/orchestrator.js:1268-1286`):
1. Normalize `contractAddress` to lowercase map key.
2. Read previous hash from map.
3. If scheduler active and mode `REDEPLOY` and hash changed:
   - call `this.contracts.auditScheduler.onRedeployDetected(contractAddress)`.
4. Update map with latest hash whenever non-empty hash exists.

## 2.3 Constraints
1. Do not change discovery schema.
2. Do not change auction creation, invite logic, or winner logic.
3. Keep current HCS audit logs unchanged unless adding explicit diagnostics.

---

## Phase 3 - Optional Nonce-Safety Hardening

## 3.1 Extend queued write wrappers
- File: `orchestrator/src/contract-client.js`
- Add wrappers using `_enqueueWrite` for:
1. `purchaseData`
2. `createSubAuction`
3. `acceptResult`
4. `settleJob`

## 3.2 Route orchestrator calls through wrappers
- File: `orchestrator/src/orchestrator.js`
- Replace direct calls currently at:
1. `:1449` data purchase
2. `:1486` sub-auction create
3. `:1525` sub-result accept
4. `:1639` job settlement
- Constraints:
  - no payload shape changes.
  - no behavioral changes to existing logs and strict-live guards.

---

## Phase 4 - Scanner Single-Flight Guard (Keep 15s Defaults)

- File: `agents/scanner/index.ts`

## 4.1 Keep cadence defaults unchanged
- Preserve:
  - `DEFAULT_SCAN_INTERVAL_MS = 15_000` (`agents/scanner/index.ts:23`)
  - demo default `30_000` (`agents/scanner/index.ts:24`)

## 4.2 Add overlap guard
1. Add runtime flag `scanInFlight`.
2. Timer callback:
   - if `scanInFlight`, skip and log concise warning.
3. Wrap `scanCycle` in `try/finally` to always reset flag.

## 4.3 Constraints
1. No discovery payload schema changes.
2. No classifier pipeline behavior changes.
3. No HCS topic routing changes.

---

## Public / Interface Changes
1. Dashboard contracts object gains `auditSchedulerContract` (additive).
2. EventListener service receives `addHssEvent` action in startup wiring.
3. Internal HSS normalized event schema is used for store updates (additive, no external API change).
4. Optional orchestrator wrapper methods are additive to contract client.

---

## Rollout Order
1. Dashboard wiring (`useEventListeners`, `hedera-connection`, `event-listener`) + tests.
2. Orchestrator redeploy durability fix + tests.
3. Optional write queue hardening + tests.
4. Scanner single-flight guard + tests.
5. Full regression matrix run.

---

## Rollback Strategy
1. If dashboard regression appears:
- revert only HSS additions in:
  - `packages/dashboard/src/services/event-listener.js`
  - `packages/dashboard/src/hooks/useEventListeners.js`
  - `packages/dashboard/src/services/hedera-connection.js`
2. If orchestrator redeploy behavior regresses:
- revert only redeploy map block in `orchestrator/src/orchestrator.js`.
3. If nonce queue wrapper changes cause unexpected side effects:
- revert wrapper usage callsites while retaining original direct calls.
4. Keep scanner cadence constants unchanged during rollback.

---

## Acceptance Criteria
1. Schedules tab receives live HSS entries without manual refresh.
2. Both HCS and contract poll paths can populate `hssEvents`.
3. Duplicate source events do not double-count triggers.
4. Redeploy trigger call is deterministic (hash change required).
5. No regressions in:
- strict-live live-auction visibility
- winner TTL behavior
- existing bid lifecycle rendering
- scanner 15s cadence default behavior.

