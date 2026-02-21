# 03 - Current-State Gap Analysis

## Objective
Summarize what is working, what is incomplete, root causes for HSS schedule UI gaps, and regression risk guardrails.

## 1) Confirmed Working
1. HSS contract deployment and config presence:
- Scheduler address exists in config: `packages/sdk/config.json:54-58`.
2. Core scheduler contract logic is implemented:
- `scheduleAudit`: `packages/contracts/contracts/AuditScheduler.sol:176`
- `triggerAudit`: `packages/contracts/contracts/AuditScheduler.sol:243`
- `onRedeployDetected`: `packages/contracts/contracts/AuditScheduler.sol:285`
3. Orchestrator listens to scheduler events and publishes HCS logs:
- `subscribeSchedulerEvents`: `orchestrator/src/orchestrator.js:2499`
- `HSS_AUDIT_TRIGGERED` publication: `orchestrator/src/orchestrator.js:2517`
- `HSS_SCHEDULE_CANCELLED` publication: `orchestrator/src/orchestrator.js:2553`
4. Scheduler-triggered discovery enrichment and retry are implemented:
- publish path: `orchestrator/src/orchestrator.js:2386-2435`
- queue path: `orchestrator/src/orchestrator.js:2438-2475`
5. Scanner discovery interval is already 15s in non-demo mode:
- `agents/scanner/index.ts:23-27`, `agents/scanner/index.ts:1003`.

## 2) Partially Wired / Incomplete
1. Dashboard state support exists but is not fully fed:
- `hssEvents` + `addHssEvent` exist in store:
  - `packages/dashboard/src/store/index.js:410-412`.
- UI consumes `hssEvents`:
  - `packages/dashboard/src/components/AuditSchedules.jsx:149-198`.
- But listener wiring does not pass `addHssEvent`:
  - `packages/dashboard/src/hooks/useEventListeners.js:44-81`.
2. Event ingestion does not populate HSS schedule state from all sources:
- HCS route lacks explicit HSS-to-`addHssEvent` mapping:
  - `packages/dashboard/src/services/event-listener.js:632-780`.
- Contract poll does not query AuditScheduler events:
  - `packages/dashboard/src/services/event-listener.js:1197-1241`.
3. Dashboard contract bootstrap lacks scheduler contract instance:
- No `auditSchedulerContract` in `createContractInstances` return:
  - `packages/dashboard/src/services/hedera-connection.js:163-174`.
4. Orchestrator REDEPLOY hash tracking is non-durable:
- uses transient `sched._bytecodeHash`:
  - `orchestrator/src/orchestrator.js:1275, 1281`.

## 3) Root-Cause List: HSS Schedule UI Gaps
1. `AuditSchedules` expects `hssEvents`, but no reliable producer pipeline writes schedule events into that slice from either HCS or scheduler contract poll path.
2. Listener action wiring omission (`addHssEvent`) blocks state mutations even if mappings were added in service layer.
3. Contract poll omits scheduler events, so contract-source reconciliation for schedule state is unavailable.
4. Scheduler contract instance is not bootstrapped in dashboard connection layer, preventing poll additions from functioning.

## 4) Risk Register

## 4.1 Strict-live regressions
- Risk: introducing HSS mappings in shared listener may inadvertently alter strict/hybrid bid-lifecycle behavior.
- Guard: do not alter existing branches for discovery/bid/winner handling in `_routeHCSMessage`.

## 4.2 Winner TTL regressions
- Risk: touching live feed logic can break winner-visibility windows.
- Guard: avoid modifying `packages/dashboard/src/hooks/useAuctionData.js` except with explicit test-driven necessity.
- Existing guard tests: `packages/dashboard/src/__tests__/use-auction-data.test.js`.

## 4.3 Multi-auction visibility regressions
- Risk: scheduler-triggered events or aggressive cleanup logic can collapse visible rows.
- Guard: keep inclusion precedence and strict-live behavior unchanged while adding schedule-state ingestion.

## 4.4 Nonce/contention side effects
- Risk: orchestrator direct write calls bypass `_enqueueWrite`, causing nonce contention under load.
- Evidence:
  - direct write calls in orchestrator:
  - `orchestrator/src/orchestrator.js:1449`, `1486`, `1525`, `1639`.
  - queued wrappers currently limited:
  - `orchestrator/src/contract-client.js:137-153`.
- Guard: optional queued wrappers for remaining write paths.

## 5) Guardrails for Safe Implementation
1. Keep single-winner selection policy unchanged.
2. Do not alter scoring, settlement calculations, or auction-open semantics.
3. Keep strict-live feed and winner TTL logic intact.
4. Add HSS ingestion as additive behavior only:
- Listener wiring + event mapping + scheduler contract polling.
5. Keep scanner 15s default unchanged; only add optional overlap guard.
6. Preserve report backend/API/UI merged behavior (no edits to report modules for this scope).

