# Prioritized Issue Backlog (Post-Fix)

## Open Issues

## P1

### 1) Dashboard preview smoke cannot bind localhost in this sandbox
- Repro: `npm --prefix packages/dashboard run preview -- --host 127.0.0.1 --port 4173`
- Expected: preview server binds and curl smoke check succeeds.
- Actual: `listen EPERM: operation not permitted 127.0.0.1:4173`.
- Impacted files: `packages/dashboard/package.json` (preview command), `recon/run-test-matrix.sh` (smoke step).
- Confidence: High.
- Minimal fix strategy: run preview smoke outside sandbox restrictions (or with approved escalated command); app build/tests already pass.
- Required tests: rerun preview smoke in unrestricted environment.

## P2

### 2) Root workspaces omit `agents`, requiring separate install path
- Repro: inspect root `package.json` workspaces + run clean bootstrap without `npm --prefix agents install`.
- Expected: one root install resolves all package deps.
- Actual: `agents` deps are not installed by root workspace install.
- Impacted files: `package.json`, `agents/package.json`.
- Confidence: High.
- Minimal fix strategy: add `agents` to root workspaces, or keep explicit bootstrap script that always runs `npm --prefix agents install`.
- Required tests: clean install + `npm --prefix agents test`.

### 3) Orchestrator live logs still emit non-fatal ENS warnings/noisy fallbacks
- Repro: run orchestrator live (`node orchestrator/src/index.js`) and inspect `recon/test-logs/orchestrator_live.log`.
- Expected: no repeated `network does not support ENS` warnings on Hedera testnet.
- Actual: warnings appear during some create/redeploy paths while flow continues.
- Impacted files: `orchestrator/src/contract-client.js`, `orchestrator/src/orchestrator.js`.
- Confidence: Medium.
- Minimal fix strategy: hard-set provider/static network options and sanitize address paths before ENS resolution.
- Required tests: rerun live smoke + verify warnings removed.

## P3

### 4) Documentation drift vs current deployed/tested state
- Repro: compare `CURRENT_STATE_OF_PROJECT.md` and `DELIVERABLES.md` to `packages/sdk/config.json` and `recon/test-matrix-final.csv`.
- Expected: docs match current token IDs, scheduler status, and validation status.
- Actual: docs still contain stale claims (older token/address values, pending statuses now completed).
- Impacted files: `CURRENT_STATE_OF_PROJECT.md`, `DELIVERABLES.md`, `PROJECT_ANALYSIS.md`.
- Confidence: High.
- Minimal fix strategy: refresh docs to latest deploy/test evidence.
- Required tests: docs traceability refresh (`recon/docs-traceability.md`) and manual review.

## Resolved Issues

### R1) `AuditScheduler` test path failures (resolved)
- Fix: selector-aware `MockHSS` behavior.
- Files: `packages/contracts/contracts/test/MockHSS.sol`.
- Validation: `contracts_auditscheduler` now passes (`19 passing`).

### R2) Missing SDK ABI export for `AuditScheduler` (resolved)
- Fix: exported ABI JSON.
- Files: `packages/sdk/abis/AuditScheduler.json`.
- Validation: ABI consistency check + contract tests pass.

### R3) Orchestrator HCS signature failures (resolved)
- Fix: robust private-key parsing for raw 64-hex keys.
- Files: `orchestrator/src/hcs-client.js`.
- Validation: live smoke receives `AUCTION_INVITE`.

### R4) Orchestrator test linger (~120s timers) (resolved)
- Fix: `.unref()` for scheduled timers.
- Files: `orchestrator/src/orchestrator.js`.
- Validation: orchestrator suites complete in ~1s.

### R5) Agents TS module type resolution failure (resolved)
- Fix: broker module declaration shim.
- Files: `agents/types.d.ts`.
- Validation: `npx tsc --noEmit -p agents/tsconfig.json` passes.

### R6) Agents suite flake in TimeLock pipeline (resolved)
- Fix: guarantee at least one high-severity LLM mock finding.
- Files: `agents/llm-contextual/index.ts`.
- Validation: `npm --prefix agents test` passes (`284 passing`).

## Fix Dependency Order (remaining)
1. Resolve P1 preview smoke environment path.
2. Decide/implement workspace bootstrap policy for `agents` (P2-2).
3. Clean orchestrator warning noise (P2-3).
4. Refresh project docs (P3-4).
