# 06 - One-Shot Implementation Prompt

Use this prompt as-is for implementation.

```md
You are implementing HSS RE-Audit integration hardening in AuditGuard. Make minimal, conflict-safe changes only. Do not change core auction logic, winner selection policy, or report pipeline behavior.

Branch assumptions:
- Current branch has scanner default 15s cadence.
- AuditScheduler is deployed and present in `packages/sdk/config.json`.
- Existing dashboard strict-live and winner TTL logic must remain intact.

Primary objective:
- Fully wire HSS schedule events into dashboard state (`hssEvents`) from both HCS and contract polling.
- Harden orchestrator REDEPLOY bytecode-change detection to use durable in-memory state.
- Add deep regression-safe tests.

Required edits:

1) `packages/dashboard/src/hooks/useEventListeners.js`
- Add `addHssEvent` into `storeActions` passed to `EventListenerService`.

2) `packages/dashboard/src/services/hedera-connection.js`
- Import `@sdk/abis/AuditScheduler.json`.
- Instantiate `auditSchedulerContract` when `config.contracts.auditScheduler?.evmAddress` exists.
- Include this instance in returned contracts map.
- Keep all existing contracts and behavior unchanged.

3) `packages/dashboard/src/services/event-listener.js`
- In `_routeHCSMessage`, map HCS HSS event types:
  - `HSS_AUDIT_TRIGGERED`
  - `HSS_SCHEDULE_CANCELLED`
  - optional future `HSS_AUDIT_SCHEDULED`, `HSS_SCHEDULE_FAILED`
- For each, call `store.addHssEvent` with normalized payload.
- Preserve current log-entry behavior and strict/hybrid lifecycle behavior.
- In contract polling query set, include `auditSchedulerContract` and query:
  - `AuditScheduled`
  - `AuditTriggered`
  - `AuditScheduleCancelled`
  - `ScheduleFailed`
- Route those into `addHssEvent`.
- Add dedupe key for HSS schedule mutations across HCS+contract sources.
- Do not alter non-HSS routing logic.

4) `orchestrator/src/orchestrator.js`
- Replace transient `sched._bytecodeHash` comparison with durable map:
  - `this.redeployBytecodeByContract = new Map()`.
- In discovery handler redeploy block:
  - compare previous hash from map;
  - if REDEPLOY mode active and hash changed, call `auditScheduler.onRedeployDetected(contractAddress)`;
  - then update map with latest hash.
- Keep all other discovery/auction logic unchanged.

5) Optional but recommended write-serialization hardening:
- `orchestrator/src/contract-client.js`:
  - add queued wrappers for `purchaseData`, `createSubAuction`, `acceptResult`, `settleJob`.
- `orchestrator/src/orchestrator.js`:
  - call wrappers instead of direct sub-contract methods.
- Do not change payloads or business rules.

6) Scanner guardrail:
- `agents/scanner/index.ts`
- Keep 15s default and existing env semantics.
- Add single-flight guard to prevent overlapping scan cycles.
- Do not alter discovery payload schema.

Tests to add/update:

A) `packages/dashboard/src/__tests__/event-listener.test.js`
- HSS HCS routing to `addHssEvent`.
- HSS contract poll routing to `addHssEvent`.
- HCS/contract dedupe for identical logical schedule events.
- Ensure existing non-HSS tests continue passing.

B) New `packages/dashboard/src/__tests__/audit-schedules.test.jsx`
- Render behavior for scheduled/triggered/cancelled/failed rows.
- Event ordering convergence test.
- Empty state test.

C) `orchestrator/test` (new hss-focused test file or extend existing)
- `subscribeSchedulerEvents` emits HSS audit-log events.
- Enrichment retry queue behavior on enrichment failure.
- Redeploy hash-state transition tests (unchanged hash no trigger, changed hash triggers once).

D) `packages/contracts/test/AuditScheduler.test.js`
- Add drift/capacity/replacement/redeploy re-arm edge tests.

Run and report:
- Dashboard tests.
- Orchestrator tests.
- Contracts scheduler tests.
- Include exact pass/fail outputs and any environment blockers.
- If any pre-existing unrelated tests fail, isolate and document them separately.

Guardrails:
- Do not modify `packages/sdk/db/**` or report API/UI files.
- Do not change `packages/dashboard/src/hooks/useAuctionData.js` behavior except if a failing regression test proves strictly necessary.
- No broad refactors.
- Keep patches minimal and localized.
```

## Included Non-Goals and Guardrails
1. No scoring/winner-policy changes.
2. No report pipeline edits.
3. No broad refactors.
4. Keep strict-live and winner-TTL behavior unchanged unless tests force a minimal correction.

## Required Reporting Format
1. List modified files.
2. List tests run and outputs.
3. Label failures as introduced/pre-existing/environmental.
4. Confirm whether guardrails were preserved.

