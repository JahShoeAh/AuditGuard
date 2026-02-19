# Running Errors Report

Last updated: 2026-02-19

This report captures errors repeatedly observed in local runs, test runs, and integration wiring.

## 1) Runtime pipeline errors

### E-001 `INVALID_SIGNATURE` while processing discovery
- Evidence:
  - `Failed to process discovery: receipt ... contained error status INVALID_SIGNATURE`
- Where seen:
  - iNFT discovery listener flow (`packages/inft/src/discovery-listener.js` path)
- Likely cause:
  - Hedera operator account/key mismatch (or wrong key type) for the listener process.
- Impact:
  - Discovery message cannot complete iNFT mint path for that event.
- Status:
  - Open
- Next action:
  - Verify `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, `HEDERA_PRIVATE_KEY_TYPE` pairing in `.env`.

### E-002 On-chain bid reverts: `AuditAuction: job does not exist`
- Evidence:
  - Static/Fuzzer logs during `submitBid` calls.
- Where seen:
  - Agent bid submit path after `AUCTION_INVITE`
- Likely cause:
  - Invite/job ID mismatch when on-chain job creation did not finalize as expected (or stale job id propagated).
- Impact:
  - On-chain bid fails; system continues through HCS fallback behavior.
- Status:
  - Mitigated (not fully eliminated)
- Mitigations already added:
  - stricter on-chain job creation handling and resolved job id use in orchestrator.
- Next action:
  - Confirm `createAuditJob` tx succeeds for each discovery and invites use that exact on-chain id.

### E-003 Winner selection error: `this.contracts.selectWinners is not a function`
- Evidence:
  - Orchestrator warning at winner selection stage.
- Where seen:
  - `selectWinnersFallback` execution path.
- Likely cause:
  - Missing helper on contract client and/or stale process running old code.
- Impact:
  - On-chain winner selection skipped; fallback messaging used.
- Status:
  - Fixed in code (restart required)
- Fix applied:
  - `orchestrator/src/contract-client.js` now includes `selectWinners(jobId, winningBidIndices)`.

### E-004 Auto-buy error: `listing undefined` and `purchaseData is not a function`
- Evidence:
  - `Auto-buy failed for listing undefined: TypeError: this.contracts.dataMarketplace.purchaseData is not a function`
- Where seen:
  - Orchestrator `DATA_LISTING_CREATED` handling.
- Likely cause:
  - Invalid listing id payload and/or stale/fallback contract client object.
- Impact:
  - Auto-purchase path fails noisily.
- Status:
  - Mitigated
- Fixes applied:
  - Invalid/empty listing IDs are now skipped.
  - Orchestrator contract client initialization is strict (fails fast if required methods are missing).

### E-005 Report generated but not listed on DataMarketplace
- Evidence:
  - Report produced, but no usable listing id / listing creation failure.
- Where seen:
  - Report agent listing step.
- Likely cause:
  - `DataMarketplace.createListing` requires seller to be an active registered agent.
- Impact:
  - Dashboard receives report metadata but marketplace purchase path is incomplete.
- Status:
  - Mitigated
- Fixes applied:
  - Report agent now checks active status and can auto-register (env-gated).
- Required runtime config:
  - `REPORT_AGENT_AUTO_REGISTER=true`
  - `REPORT_AGENT_STAKE_GUARD`, `REPORT_ACCOUNT_ID`, `REPORT_PRIVATE_KEY` with funded GUARD balance.

## 2) Build / tooling errors

### E-006 TypeScript module resolution failure
- Evidence:
  - `TS2307: Cannot find module '@0glabs/0g-serving-broker'`
- Where seen:
  - `agents/llm-contextual/zg-client.ts`
- Impact:
  - Full TS compile checks stop early.
- Status:
  - Open

### E-007 NPM registry/network failure
- Evidence:
  - `ENOTFOUND registry.npmjs.org`
- Where seen:
  - Package execution/install attempts.
- Impact:
  - Can block dependency resolution and local run commands.
- Status:
  - Environment-dependent / Open

### E-008 `tsx` IPC/pipe permission failure in sandbox
- Evidence:
  - `Error: listen EPERM ... /tmp/...tsx...pipe`
- Where seen:
  - Running `tsx` directly in sandboxed execution.
- Impact:
  - Prevents local runtime checks in that sandbox mode.
- Status:
  - Environment-dependent / Open

## 3) Test-suite failures (pre-existing)

### E-009 Agent test suite failures
- Evidence:
  - Documented in `refactor.md` as pre-existing (`npm --prefix agents test failed`).
- Status:
  - Open

### E-010 AuditScheduler suite failures
- Evidence:
  - Documented in `refactor.md`: `AuditScheduler.test.js` has multiple failing cases.
- Status:
  - Open

## 4) Workflow errors encountered

### E-011 Merge/pull blocked by local changes
- Evidence:
  - `Your local changes ... would be overwritten by merge` (multiple markdown files listed).
- Impact:
  - Prevents pull/merge until stash/commit/overwrite strategy is chosen.
- Status:
  - Open workflow item

## 5) Known recurring risk areas (from implementation logs)

### E-012 Fallback timing race
- Evidence:
  - Logged in implementation notes: fallback winner message can arrive before local job context exists.
- Impact:
  - Winner may not start work in specific ordering races.
- Status:
  - Open

### E-013 Append-only dedup sets in agents
- Evidence:
  - `startedJobs` currently grows for process lifetime.
- Impact:
  - Slow memory growth over long runs.
- Status:
  - Open (low-medium)

---

If you want, I can split this into:
1. `OPEN_ERRORS.md` (only unresolved), and
2. `FIXED_ERRORS.md` (what we already resolved with file references).
