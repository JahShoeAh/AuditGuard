# Project Guardrails

Use this file to lock scope before refactors so we keep core behavior stable.

> Last updated: 2026-02-19

## Goal / Non-goals

### Goal
- Keep the end-to-end AuditGuard flow stable: discovery -> auction invite -> bidding -> findings -> report/alert.
- Improve reliability and maintainability without changing expected user-facing behavior.

### Non-goals
- Rewriting architecture or replacing Hedera/HCS stack.
- Changing tokenomics/business rules unless explicitly planned.
- UI redesigns unrelated to functional correctness.

## What "core functionality" means (must-keep behaviors, APIs, outputs)

### Must-keep behaviors
- Orchestrator consumes discovery events and opens/tracks jobs.
- Orchestrator publishes `AUCTION_INVITE` to eligible agents.
- Agents respond to orchestrator liveness checks (`PING` -> `PONG`).
- Bidding agents submit bids for invite-driven jobs.
- Findings are published and report aggregation can complete.
- Dashboard can surface live auction/job activity from event streams.

### Must-keep APIs/contracts
- Existing HCS message types and payload shapes used across orchestrator/agents/UI.
- Existing npm script entrypoints used by team workflows (`dev:all`, `dev:test`, `test:all`, etc.).
- Existing smart contract method signatures used by orchestrator/agents.

### Must-keep outputs
- Logs remain actionable for tracing lifecycle stages.
- Test commands produce deterministic pass/fail for CI/offline flows.

## Test strategy (what tests exist, what should remain, what can be deleted)

### Existing tests (current baseline)
- Contracts: Hardhat suite under `packages/contracts/test`.
- Orchestrator: mock/offline/e2e-style tests under `orchestrator/test`.
- Agents: Vitest suites under `agents/tests` including `auction-invite.test.ts`.
- Dashboard: tests under `packages/dashboard`.

### Should remain
- Coverage for invite handling + bid submission path.
- Coverage for liveness behavior (`PING`/`PONG`) and roster eligibility assumptions.
- Coverage for report publication path and alert trigger conditions.

### Can be deleted/refactored
- Redundant tests that assert identical behavior at the same layer.
- Overly brittle log-string assertions that do not validate functional outcomes.

## Constraints (languages, build system, CI, perf, backward compat)

- Languages: TypeScript/JavaScript + Solidity.
- Build/test tools: npm, Vitest, Hardhat.
- CI expectation: `npm run dev:test` and `npm run test:all` stay valid.
- Performance: avoid changes that significantly increase event-loop/blocking work in long-running agents.
- Backward compatibility: keep existing env var patterns and message compatibility unless migration is documented.

## Known pain points / suspected bugs

- Agent liveness pruning when `PONG` is missing or delayed.
- `AUCTION_INVITE` race conditions when discovery and invite ordering differ.
- Hedera key/signature mismatches causing HCS publish failures (`INVALID_SIGNATURE`).
- UI not reflecting newly created auctions when event ingestion is delayed or mismatched.

## Open decisions

- Decide source of truth for live UI updates when on-chain event polling and HCS timing diverge.
- Decide if we enforce strict schema validation on all HCS messages.
- Decide minimum required agent set for considering an auction "healthy".
