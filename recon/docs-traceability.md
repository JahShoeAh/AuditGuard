# Docs-to-Code Traceability Matrix (Post-Fix)

| Source | Claim | Implementation Evidence | Status | Notes |
|---|---|---|---|---|
| `README.md` | 7 autonomous agents are implemented | `agents/scanner/index.ts`, `agents/static-analysis/index.ts`, `agents/fuzzer/index.ts`, `agents/llm-contextual/index.ts`, `agents/dependency/index.ts`, `agents/report/index.ts`, `agents/alert/index.ts` | Verified | All entrypoints exist and tests run. |
| `README.md` | Orchestrator handles invite/findings/report flow | `orchestrator/src/orchestrator.js` handlers + orchestrator test suites | Verified | `orchestrator/test/*.js` passing. |
| `README.md` | Dashboard tabs/components are implemented | `packages/dashboard/src/Dashboard.jsx` + components tree | Verified | Unit tests + build pass. |
| `CURRENT_STATE_OF_PROJECT.md` | `AuditScheduler` tests failing/pending integration | `packages/contracts/test/AuditScheduler.test.js` | Contradicted | Suite now passes (`19 passing`). |
| `CURRENT_STATE_OF_PROJECT.md` | `AuditScheduler` ABI pending export | `packages/sdk/abis/AuditScheduler.json` | Contradicted | ABI now present. |
| `CURRENT_STATE_OF_PROJECT.md` | HSS deploy pending | `packages/sdk/config.json` (`contracts.auditScheduler`) | Contradicted | Scheduler deployed at `0x67d67C1c721241f9350d3ecA0C0a1B6D53E69860`. |
| `CURRENT_STATE_OF_PROJECT.md` | GUARD token/deploy values reflect current testnet | `packages/sdk/config.json` (`guardTokenId`, `guardTokenEvmAddress`) | Contradicted | Doc token IDs are older than current config (`0.0.7977433`). |
| `DELIVERABLES.md` | HCS signature was blocking live flow | `orchestrator/src/hcs-client.js` + `recon/test-logs/live_smoke_after_fix.log` | Verified | Live smoke receives `AUCTION_INVITE`. |
| `PROJECT_ANALYSIS.md` | Data marketplace flow is implemented | `packages/contracts/contracts/DataMarketplace.sol`, orchestrator handlers/tests | Verified | Contract + orchestrator tests pass. |
| `CURRENT_STATE_OF_PROJECT.md` | iNFT listeners integrated | `packages/inft/src/discovery-listener.js`, `packages/inft/src/event-listener.js` | Partial | Startup smoke passes; full live state-transition replay not fully re-walked in this pass. |
| `README.md` | Shared deploy config is centralized | `packages/sdk/config.json` consumed by agents/orchestrator/dashboard | Verified | Config is the single runtime source of deployed IDs/addresses. |

## Doc Drift Summary
- Highest drift is in `CURRENT_STATE_OF_PROJECT.md` (stale deploy IDs and now-resolved pending items).
- `DELIVERABLES.md` still describes some formerly-blocking items as unresolved.
- Code and tests are ahead of narrative docs; refresh is recommended before external sharing.
