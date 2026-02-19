Inventory
Core functionality (from CURRENT_STATE_OF_PROJECT.md (line 5), CURRENT_STATE_OF_PROJECT.md (line 53), CURRENT_STATE_OF_PROJECT.md (line 90), CURRENT_STATE_OF_PROJECT.md (line 113)) is the autonomous audit pipeline: scanner discovery -> orchestrator auction/invites -> agent bidding/execution -> findings/report -> settlement.
Core runtime entrypoints are package.json scripts agents, orchestrator, inft:listen, inft:listen:events, and agent package scripts in package.json (scanner, static, fuzzer, llm, dependency, report, alert, all, all:demo).
Core orchestrator flow depends on numeric jobId correlation in orchestrator.js (line 247) (casts incoming jobId with Number(jobId) and keys this.jobs on that value).
Core test suites to preserve (per context and current scripts) are contract tests AuditGuard.test.js, AuditScheduler.test.js, agent tests under agents/tests, orchestrator tests, and dashboard tests.
Non-core/support candidates identified as removable were standalone demo/helper scripts not referenced by scripts/imports/runtime paths.
Deletion safety proof used:
Repo-wide reference scan returned no matches for removed script names (rg -n "run-demo|list-0g-providers|demo-day[234]|test-day3-integration").
Package script checks showed no script points to removed files (package.json, package.json).
Kept ambiguous items (not deleted) when not provably dead (for example, legacy script aliases and deployment scripts with TODOs).
Changes
Deleted run-demo.ts; safe because no runtime/script/import references and all:demo already uses run-all.ts.
Deleted list-0g-providers.ts; safe because no package script/import/runtime references.
Deleted demo-day2.js; safe because package.json does not invoke it.
Deleted demo-day3.js; safe because package.json does not invoke it.
Deleted demo-day4.js; safe because package.json does not invoke it.
Deleted test-day3-integration.js; safe because no script/import/runtime references.
Refactored findings job correlation to use real jobId (not contract address) in index.ts (line 324), index.ts (line 387), index.ts (line 537); behavior-preserving for intended protocol semantics because orchestrator already keys jobs by numeric job id (orchestrator.js (line 247)).
Refactored pending-job state to carry jobId through winner/fallback paths in index.ts (line 32), index.ts (line 32), index.ts (line 45); no public API change.
Refactored static listing publish path to require actual on-chain DataListed event + listing id before broadcasting DATA_LISTING_CREATED in index.ts (line 341) and index.ts (line 370); this prevents invalid marketplace announcements.
Refactored fuzzer marketplace intake/purchase guardrails to validate listing id and index reports by job id in index.ts (line 183), index.ts (line 335); no intended behavior change except invalid-input rejection.
Refactored sub-auction id usage from hardcoded 0 to real id in index.ts (line 97), index.ts (line 109), index.ts (line 151).
Refactored LLM sub-auction creation/accept path to use parent jobId and parse emitted SubAuctionCreated id in index.ts (line 424), index.ts (line 429), index.ts (line 490).
Removed unused imports/constants in index.ts (line 1), index.ts (line 1), index.ts (line 1), index.ts (line 1), index.ts (line 23), and updated stale metrics comment in metrics.ts (line 101).
Explicit behavior changes:
DATA_LISTING_CREATED is no longer emitted when a listing id cannot be confirmed on-chain (index.ts (line 370)).
Findings now report correct auction jobId values instead of contract addresses in three bidding agents (index.ts (line 324), index.ts (line 387), index.ts (line 537)).
Bugs found
Bug: findings/job settlement key mismatch.
Location: orchestrator.js (line 247) expects numeric jobId; old agent payloads used contractAddress in index.ts / index.ts / index.ts.
Symptom: findings can be keyed under NaN/wrong job, causing incorrect aggregation/settlement behavior.
Severity: High.
Reproduce/why bug: run a normal auction with numeric job id; if findings publish hex contract address as jobId, orchestrator lookup by numeric key does not align with created job key.
Fix: propagate and emit real job id from pending-job state in all three agents.
Bug: invalid data listing announcements.
Location: static agent listing + publish path index.ts (line 341) and consumer logic index.ts (line 183).
Symptom: marketplace listing event could be announced without a valid listing id, leading buyers toward invalid purchases.
Severity: Medium-High.
Reproduce/why bug: listing tx fails or no parsable DataListed log; old code still emitted DATA_LISTING_CREATED.
Fix: parse receipt logs, require real listingId, and validate listing ids before storing/purchasing.
Bug: hardcoded sub-auction id 0.
Location: index.ts (line 109) and index.ts (line 151) (old behavior), plus parent creation/accept mismatches in index.ts (line 429) and index.ts (line 490).
Symptom: bids/results can target wrong sub-job on-chain.
Severity: High.
Reproduce/why bug: when sub-auction id is non-zero, dependency agent previously still submitted and delivered to id 0.
Fix: parse/normalize sub-auction id and use it in submit/deliver/accept calls.
Assumptions / guesses
Treated CURRENT_STATE_OF_PROJECT.md and AuditGuard_Revised.md as source-of-truth for what is core and must remain compatible.
Treated unreferenced demo/helper scripts as non-core only after both reference scan and script-entrypoint checks.
Preserved existing public script surface and did not remove ambiguous/possibly used paths without proof.
Considered current agents and AuditScheduler test failures pre-existing because changed files are outside those failing assertions/contracts.
Kept fallback numeric coercions (Number(...)?... (line 0)) to preserve existing tolerant behavior for malformed IDs rather than introducing strict rejects.
Incomplete / TODO items
Context-marked pending platform work remains unresolved: setAuditScheduler, setOrchestrator, AuditScheduler ABI export, HSS live test, dashboard HSS wiring (CURRENT_STATE_OF_PROJECT.md (line 235), CURRENT_STATE_OF_PROJECT.md (line 236), CURRENT_STATE_OF_PROJECT.md (line 237), CURRENT_STATE_OF_PROJECT.md (line 238), CURRENT_STATE_OF_PROJECT.md (line 240)).
Deployment script TODOs still present: deploy-day2.js (line 318), deploy-day3.js (line 428).
Known limitation still documented in tests/contracts: AuditGuard.test.js (line 399), DelegatedStaking.sol (line 800).
Existing failing tests not fixed in this refactor:
shared.test.ts failures at shared.test.ts (line 141), shared.test.ts (line 182), shared.test.ts (line 728).
timelock-pipeline.test.ts suite fails due module resolution of @0glabs/0g-serving-broker via zg-client.ts (line 2).
AuditScheduler.test.js has 12 failing cases (event emission / inactive schedule flow).
Risk & verification checklist
Verification run:
npm --prefix agents run test:invite passed.
npm --prefix orchestrator run test:mocks passed.
npm --prefix orchestrator run test:offline passed (generated offline-state.json, then restored).
npm --prefix orchestrator run test:e2e passed.
npm --prefix packages/dashboard test passed.
npm --prefix agents test failed (3 assertions + 1 suite, pre-existing env/module issues).
npm test failed due AuditScheduler suite (12 failures; core AuditGuard suite passes).
Refactor risk hotspots:
Message-schema compatibility where downstream consumers may have implicitly relied on old incorrect jobId payload values.
Event-log parsing dependence for DataListed/SubAuctionCreated; if ABI/event shape diverges, listings/sub-auction id extraction can degrade.
Remaining numeric fallback-to-0 paths for malformed IDs can mask upstream data-quality issues.
Recommended validation steps:
Run an end-to-end live flow (npm run agents + orchestrator) and confirm findings aggregate/settle under correct numeric job ids.
Observe DATA_LISTING_CREATED events and verify each contains a real on-chain listing id that can be purchased.
Exercise sub-auction flow and confirm dependency bid/delivery/accept all reference the same non-zero sub-auction id.

