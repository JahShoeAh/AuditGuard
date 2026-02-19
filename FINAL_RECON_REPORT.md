# AuditGuard Final Recon Report

Date: 2026-02-19

## Scope Executed
- Full repo inventory/classification and functionality mapping.
- Static verification across contracts, agents, orchestrator, dashboard, and iNFT.
- Automated test matrix rerun.
- Live redeploy and live orchestrator smoke validation on Hedera testnet.
- Post-fix issue triage and backlog refresh.
- Non-root `node_modules` cleanup reapplied per request after validation.

## Works
- Contracts compile and core suites pass:
  - `packages/contracts/test/AuditGuard.test.js` (`68 passing`)
  - `packages/contracts/test/AuditScheduler.test.js` (`19 passing`)
- Agents:
  - TypeScript compile passes (`npx tsc --noEmit -p agents/tsconfig.json`)
  - Vitest suite passes (`284 passing`)
- Orchestrator:
  - All offline/integration test scripts pass (`10/10`, plus flow/e2e scripts)
  - Live smoke receives `AUCTION_INVITE` end-to-end (`recon/test-logs/live_smoke_after_fix.log`)
- Dashboard:
  - Unit tests pass (`store`, `event-listener`)
  - Production build passes.
- iNFT:
  - Module load smoke passes.
  - Discovery/event listener startup smokes pass.
- Live config coherence:
  - Current deploy IDs/addresses reflected in `packages/sdk/config.json`.

## Works With Caveats
- Dashboard preview smoke in this environment is blocked by sandbox bind restrictions (`EPERM` on `127.0.0.1:4173`), not by build/test failures.
- Orchestrator live logs still show non-fatal ENS warning noise on some Hedera paths.
- `agents` is not in root workspaces, so clean bootstrap still needs separate `npm --prefix agents install`.

## Broken
- No currently reproducible product-blocking failures in offline automated suites after fixes.

## Not Implemented / Not Fully Re-Exercised
- Full manual live walkthrough of every business flow in one continuous run (all marketplace/staking/vault/iNFT/dashboard route scenarios together) was not re-executed as a single monolithic script in this pass.
- Documentation refresh is incomplete; key project status docs are stale versus code/runtime.

## Key Fixes Applied In This Cycle
- `orchestrator/src/hcs-client.js`: robust private key parsing for HCS signing.
- `orchestrator/src/orchestrator.js`: timer `.unref()` to eliminate long test tail hangs.
- `packages/contracts/contracts/test/MockHSS.sol`: selector-aware mock behavior for scheduler tests.
- `package.json`: `deploy:audit-scheduler` now uses explicit Hardhat config path.
- `agents/types.d.ts`: module declaration for `@0glabs/0g-serving-broker`.
- `agents/tests/shared.test.ts`: env-sensitive test assumptions corrected.
- `agents/tests/llm-0g-integration.test.ts`: mock restore/clear stability improvements.
- `agents/llm-contextual/index.ts`: deterministic high-severity guarantee in mock findings to remove pipeline flake.
- `packages/sdk/abis/AuditScheduler.json`: ABI export added.

## Final Artifacts
- `recon/file-manifest.txt`
- `recon/file-classification.csv`
- `recon/file-classification-summary.csv`
- `recon/functionality-map-with-header.csv`
- `recon/docs-traceability.md`
- `recon/static-verification.md`
- `recon/test-matrix-final.csv`
- `recon/issue-backlog.md`
- `recon/test-logs/*`

## Live-Mode Stabilization Patch (Implemented)
- Scanner live discovery correctness fixed:
  - Strict-valid 20-byte EVM address generation.
  - `budget` is now always populated with non-zero default.
  - Scanner payload validation added before publish.
- Orchestrator strict live behavior added:
  - Discovery payload guardrails (address/risk/LOC/budget).
  - On-chain create failure is terminal in strict mode (`JOB_FAILED` + `ONCHAIN_TX_FAILED`).
  - String-safe job ID handling end-to-end (no unsafe `Number(jobId)` path for settlement/state keys).
  - Auto-buy now requires active registered buyer in strict mode; otherwise explicit skip event.
- Agent strict live fail-fast paths added:
  - Static/Fuzzer/LLM/Dependency/Report publish explicit `*_FAILED` audit events and stop path on on-chain tx failure when strict live is enabled.
- Identity alignment patch:
  - Deployment/seed scripts now use canonical env keys (`SCANNER/STATIC/FUZZER/LLM/DEPENDENCY/REPORT/ALERT`) with legacy fallback mapping.
  - `orchestrator/scripts/seed-live-agents.js` now seeds using real configured wallets only (no random addresses).
  - Added `scripts/verify-live-agents.js` for env/balance/registry preflight.

## Current Validation Snapshot (Post-Patch)
- Local/offline suites: passing
  - `npm run test:all` passes end-to-end.
  - `bash recon/run-test-matrix.sh` passes all suites except dashboard preview smoke.
- Remaining non-code environment blockers:
  - Dashboard preview smoke fails in this sandbox with `EPERM` bind error on `127.0.0.1:4173`.
  - Live smoke/preflight in this sandbox cannot resolve Hedera mirror DNS (`UNAVAILABLE: Name resolution failed`), so strict on-chain live verification must be run from a network-enabled host.
