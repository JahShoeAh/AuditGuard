# 01 - Repo Context Inventory

## Objective
Record every material command, file, and subsystem inspected to build the HSS RE-Audit plan.

## Commands Used for Scan/Audit
1. `git branch --show-current && git rev-parse --short HEAD && git status -sb`
2. `rg -n --hidden -S "HSS|hss|AuditScheduler|AuditTriggered|scheduleAudit|triggerAudit|onRedeployDetected|HSS_AUDIT|HSS_SCHEDULE|SCANNER_SCAN_INTERVAL_MS|SCANNER_CURSOR_FILE_PATH" .`
3. `nl -ba orchestrator/src/orchestrator.js | sed -n '340,430p'`
4. `nl -ba orchestrator/src/orchestrator.js | sed -n '1230,1325p'`
5. `nl -ba orchestrator/src/orchestrator.js | sed -n '2360,2605p'`
6. `nl -ba orchestrator/src/orchestrator.js | sed -n '1,120p'`
7. `nl -ba orchestrator/src/orchestrator.js | sed -n '700,980p'`
8. `nl -ba orchestrator/src/orchestrator.js | sed -n '980,1235p'`
9. `nl -ba orchestrator/src/orchestrator.js | sed -n '1400,1705p'`
10. `nl -ba orchestrator/src/contract-client.js | sed -n '1,260p'`
11. `nl -ba orchestrator/src/config.js | sed -n '1,220p'`
12. `nl -ba agents/scanner/index.ts | sed -n '1,140p'`
13. `nl -ba agents/scanner/index.ts | sed -n '140,280p'`
14. `nl -ba agents/scanner/index.ts | sed -n '930,1085p'`
15. `nl -ba packages/dashboard/src/hooks/useEventListeners.js | sed -n '1,220p'`
16. `nl -ba packages/dashboard/src/store/index.js | sed -n '330,490p'`
17. `nl -ba packages/dashboard/src/components/AuditSchedules.jsx | sed -n '120,290p'`
18. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '1,180p'`
19. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '180,360p'`
20. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '360,520p'`
21. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '520,620p'`
22. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '600,780p'`
23. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '1160,1325p'`
24. `nl -ba packages/dashboard/src/services/event-listener.js | sed -n '1840,1995p'`
25. `nl -ba packages/dashboard/src/services/hedera-connection.js | sed -n '1,240p'`
26. `nl -ba packages/dashboard/src/hooks/useAuctionData.js | sed -n '1,240p'`
27. `nl -ba packages/contracts/contracts/AuditScheduler.sol | sed -n '1,240p'`
28. `nl -ba packages/contracts/contracts/AuditScheduler.sol | sed -n '240,460p'`
29. `nl -ba packages/contracts/contracts/HederaScheduleService.sol | sed -n '1,220p'`
30. `nl -ba packages/contracts/contracts/AuditAuction.sol | sed -n '620,700p'`
31. `nl -ba packages/contracts/contracts/interfaces/IAuditScheduler.sol | sed -n '1,180p'`
32. `nl -ba packages/contracts/contracts/VaultFactory.sol | sed -n '240,320p'`
33. `nl -ba packages/contracts/contracts/AuditVault.sol | sed -n '580,660p'`
34. `nl -ba packages/contracts/test/AuditScheduler.test.js | sed -n '1,320p'`
35. `nl -ba packages/contracts/test/AuditGuard.test.js | sed -n '560,760p'`
36. `nl -ba packages/dashboard/src/__tests__/event-listener.test.js | sed -n '1,360p'`
37. `nl -ba packages/dashboard/src/__tests__/use-auction-data.test.js | sed -n '1,320p'`
38. `nl -ba packages/inft/src/event-listener.js | sed -n '920,1125p'`
39. `nl -ba scripts/deploy-audit-scheduler.js | sed -n '1,220p'`
40. `rg -n "HSS|AuditScheduled|AuditTriggered|AuditScheduleCancelled|addHssEvent|hssEvents|AUTO_AUDIT_TRIGGERED|VAULT_CREATED" packages/dashboard/src/__tests__`
41. `rg -n "HSS|AuditScheduler|subscribeSchedulerEvents|triggeredByHSS|HSS_AUDIT_TRIGGERED|HSS_SCHEDULE_CANCELLED|onRedeployDetected" orchestrator/test`
42. `rg -n "SCANNER_CURSOR_FILE_PATH|scanner-cursor|SCANNER_SCAN_INTERVAL_DEMO_MS|SCANNER_SCAN_INTERVAL_MS" agents/scanner agents/shared .`
43. `rg -n "SCANNER_SCAN_INTERVAL_MS|SCANNER_SCAN_INTERVAL_DEMO_MS|SCANNER_START_TIMESTAMP|SCANNER_CURSOR|ORCHESTRATOR_BID_FINALITY_GRACE_MS|VITE_DASHBOARD_HCS_POLL_MS|VITE_DASHBOARD_CONTRACT_POLL_MS|VITE_WINNER_SELECTED_TTL_MS|auditScheduler|DASHBOARD_HCS_REPLAY_MODE|VITE_API_BASE_URL" .env.example packages/sdk/config.json`
44. `nl -ba .env.example | sed -n '1,260p'`
45. `nl -ba packages/sdk/config.json | sed -n '1,260p'`
46. `nl -ba CURRENT_STATE_OF_PROJECT.md | sed -n '40,120p'`
47. `nl -ba CURRENT_STATE_OF_PROJECT.md | sed -n '232,270p'`
48. `nl -ba DELIVERABLES.md | sed -n '80,150p'`
49. `nl -ba HSS_BOUNTY_COMPLIANCE_REPORT.md | sed -n '20,120p'`
50. `nl -ba FRONTEND.md | sed -n '540,580p' && nl -ba FRONTEND.md | sed -n '1530,1565p'`

## Files Inspected and Why
| File | Why it was inspected |
|---|---|
| `orchestrator/src/orchestrator.js` | End-to-end HSS event subscription, discovery handling, redeploy trigger logic, winner timing, and auction creation/reconciliation flow. |
| `orchestrator/src/contract-client.js` | Validate queued vs direct write coverage and AuditScheduler contract initialization behavior. |
| `orchestrator/src/config.js` | Verify grace/wait tunables affecting perceived HSS-to-UI lag and scheduling behavior. |
| `agents/scanner/index.ts` | Verify actual discovery cadence defaults and scan loop behavior (15s vs 5m concern). |
| `packages/dashboard/src/hooks/useEventListeners.js` | Verify listener-to-store action wiring, including whether `addHssEvent` is passed. |
| `packages/dashboard/src/services/event-listener.js` | Verify ingestion sources, HCS routing, poll cadence, replay cursor model, and missing HSS schedule ingestion. |
| `packages/dashboard/src/services/hedera-connection.js` | Verify which contracts are instantiated for polling and whether AuditScheduler is included. |
| `packages/dashboard/src/store/index.js` | Verify `hssEvents` store slice and action availability. |
| `packages/dashboard/src/components/AuditSchedules.jsx` | Verify schedule UI data contract and expected HSS event shape. |
| `packages/dashboard/src/hooks/useAuctionData.js` | Verify strict-live filters and TTL behavior that can regress with HSS/UI changes. |
| `packages/contracts/contracts/AuditScheduler.sol` | Canonical on-chain HSS schedule lifecycle semantics and security checks. |
| `packages/contracts/contracts/HederaScheduleService.sol` | Underlying HSS precompile wrapper semantics and response behavior. |
| `packages/contracts/contracts/interfaces/IAuditScheduler.sol` | Interface shape used externally for scheduler operations. |
| `packages/contracts/contracts/AuditAuction.sol` | Scheduler registration path (`setAuditScheduler`). |
| `packages/contracts/contracts/VaultFactory.sol` | Existing auto-reaudit event signaling path (`AutoAuditTriggered`). |
| `packages/contracts/contracts/AuditVault.sol` | Permissionless re-audit trigger path and relation to scheduler concepts. |
| `packages/contracts/test/AuditScheduler.test.js` | Existing HSS contract test baseline and missing edges. |
| `packages/contracts/test/AuditGuard.test.js` | VaultFactory/AuditVault integration baseline around re-audit adjacencies. |
| `packages/dashboard/src/__tests__/event-listener.test.js` | Existing ingestion tests and absence of HSS schedule ingestion tests. |
| `packages/dashboard/src/__tests__/use-auction-data.test.js` | Regression-critical strict-live/winner TTL tests. |
| `packages/inft/src/event-listener.js` | Verify iNFT event path relevance (auto-audit coverage). |
| `scripts/deploy-audit-scheduler.js` | Deployment + wiring behavior and expected config layout. |
| `.env.example` | Verify current poll/finality defaults and scanner-related env state. |
| `packages/sdk/config.json` | Verify deployed addresses and scheduler address shape. |
| `CURRENT_STATE_OF_PROJECT.md` | Claimed system state vs code-truth gap checkpoints. |
| `DELIVERABLES.md` | Claimed pending dashboard/HSS wiring targets. |
| `HSS_BOUNTY_COMPLIANCE_REPORT.md` | Claimed HSS compliance to reconcile against current code behavior. |
| `FRONTEND.md` | Intended dashboard data model and schedule-tab behavior contract. |

## Environment / Config Artifacts Inspected
1. `.env.example`
2. `packages/sdk/config.json`
3. `CURRENT_STATE_OF_PROJECT.md`
4. `DELIVERABLES.md`
5. `HSS_BOUNTY_COMPLIANCE_REPORT.md`
6. `FRONTEND.md`

## Explicit Non-Changes During Analysis
1. No source logic was edited during analysis.
2. No contracts, orchestrator, scanner, dashboard runtime code, or tests were modified during analysis.
3. Only this documentation pack was added as part of the requested implementation.

