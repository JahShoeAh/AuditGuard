# 05 - Deep Verification Test Suite

## Objective
Define comprehensive backend + frontend verification to ensure HSS RE-Audit integration is correct and non-regressive.

## Test Strategy
1. Additive tests for new HSS ingestion and redeploy durability behavior.
2. Preserve and re-run all existing regression-sensitive suites.
3. Validate both source paths for schedule state:
- HCS audit-log path
- on-chain contract polling path

---

## 1) Dashboard Tests to Add

## 1.1 HCS HSS routing
- File: `packages/dashboard/src/__tests__/event-listener.test.js`
- Cases:
1. `HSS_AUDIT_TRIGGERED` maps to `addHssEvent` with:
   - `type`, `contractAddress`, `scheduleAddress`, `triggeredAt`, `timesTriggered`.
2. `HSS_SCHEDULE_CANCELLED` maps to `addHssEvent` with:
   - `type`, `contractAddress`, `cancelledBy`, `reason`.
3. Unknown/partial HSS payload does not crash and is safely ignored/logged.

## 1.2 Contract HSS routing
- File: `packages/dashboard/src/__tests__/event-listener.test.js`
- Cases:
1. Polled `AuditScheduled` from scheduler contract creates one `hssEvents` entry.
2. Polled `AuditTriggered` updates trigger metadata.
3. Polled `AuditScheduleCancelled` marks schedule inactive.
4. Polled `ScheduleFailed` records failure context.

## 1.3 Dedupe between sources
- File: `packages/dashboard/src/__tests__/event-listener.test.js`
- Cases:
1. Same logical event via HCS + contract poll produces one schedule mutation.
2. Distinct schedule events remain independent.

## 1.4 Schedule rendering lifecycle
- New file: `packages/dashboard/src/__tests__/audit-schedules.test.jsx`
- Cases:
1. Empty `hssEvents` shows empty state.
2. `AuditScheduled` renders active row with due metadata.
3. `AuditTriggered` increments count and updates schedule fields.
4. `AuditScheduleCancelled` renders inactive state/reason.
5. Event ordering out-of-order still converges to correct final row.

## 1.5 Frontend regression guards
- Re-run:
1. `packages/dashboard/src/__tests__/use-auction-data.test.js`
2. existing listener tests unrelated to HSS.
- Must ensure no behavior drift in strict-live/winner TTL logic.

---

## 2) Orchestrator Tests to Add

## 2.1 Scheduler subscription behavior
- File: add new `orchestrator/test/hss-scheduler.test.js` (or equivalent test harness file used in repo).
- Cases:
1. `AuditTriggered` event causes `HSS_AUDIT_TRIGGERED` publication via `hcs.publishAuditLog`.
2. `AuditScheduleCancelled` event causes `HSS_SCHEDULE_CANCELLED` publication.
3. Enrichment call attempted after trigger.
4. Failed enrichment is queued for retry.

## 2.2 Redeploy hash transition correctness
- Cases:
1. First discovery hash is cached (no redeploy call).
2. Same hash on subsequent discovery does not call `onRedeployDetected`.
3. Changed hash calls `onRedeployDetected` exactly once.
4. Non-REDEPLOY mode does not call redeploy hook even when hash changes.

## 2.3 Optional queue wrapper validation
- If queue hardening is implemented:
1. `purchaseData`, `createSubAuction`, `acceptResult`, `settleJob` execute serially.
2. No nonce collision regressions in mocked concurrent triggers.

---

## 3) Contract Tests to Add

## 3.1 Scheduler lifecycle edges
- File: `packages/contracts/test/AuditScheduler.test.js`
- Cases:
1. Replacing active schedule deletes previous schedule before creating new one.
2. Capacity failure path emits `ScheduleFailed` and deactivates schedule.
3. `triggerAudit` TIME_BASED due-time progression remains interval-consistent.
4. `onRedeployDetected` cancels prior pending schedule before re-arming.

## 3.2 Access/security guards
- Cases:
1. Unauthorized `triggerAudit` rejected.
2. Unauthorized `onRedeployDetected` rejected.
3. Unauthorized `cancelSchedule` rejected.
4. Admin updates remain `onlyOwner`.

---

## 4) End-to-End Smoke Suite

## 4.1 Trigger-to-UI latency checks
- Scenario:
1. Emit/observe scheduler trigger.
2. Verify schedule state appears in UI within configured polling windows.
- Validate with:
  - `VITE_DASHBOARD_HCS_POLL_MS`
  - `VITE_DASHBOARD_CONTRACT_POLL_MS`
  from `.env.example:79-80`.

## 4.2 Live-auctions regression checks
- Scenario:
1. Ensure no unknown-auction flood from HSS additions.
2. Ensure no CLOSED->hidden->WINNER_SELECTED flicker regressions due to listener changes.

## 4.3 Scanner cadence and overlap checks
- Scenario:
1. Confirm runtime logs keep 15s interval (`agents/scanner/index.ts:23`).
2. With single-flight enabled, confirm no overlapping cycle execution.

---

## 5) CI Gating Matrix and Criteria

| Layer | Command (example) | Pass Criteria |
|---|---|---|
| Dashboard unit | `npm --prefix packages/dashboard test` | All existing + new HSS tests pass |
| Orchestrator tests | `npm --prefix orchestrator test` | HSS scheduler + existing suites pass |
| Contracts HSS | `npm exec -- hardhat test packages/contracts/test/AuditScheduler.test.js --config packages/contracts/hardhat.config.js` | Scheduler suite passes |
| Full smoke (optional) | repo smoke scripts under `recon/` | No HSS integration regressions |

## Mandatory Result Logging
1. Record exact command output for each test group.
2. Tag failures as:
- `pre-existing`
- `introduced by HSS changes`
- `environmental`.
3. Do not mark complete with newly introduced failures.

