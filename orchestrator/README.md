# Orchestrator Agent (isolated branch-safe scaffold)

> Current build notes (2026-02-19): `JOB_CREATED` is published for dashboard/live listeners; orchestrator key precedence favors `ORCHESTRATOR_*` then `HEDERA_*` then `OPERATOR_*`.

This folder contains a self-contained orchestrator implementation so we avoid touching the in-flight sub-agent files.

## What’s here
- `src/orchestrator.js` — event loop: listens to discovery, invites eligible agents, opens auctions (best-effort), fallback winner selection, heartbeat PING/PONG.
- `src/roster.js` — in-memory roster with stake/reputation gating and liveness pruning.
- `src/hcs-client.js` — minimal HCS JSON pub/sub.
- `src/contract-client.js` — ethers.js wrappers wired to deployed addresses from `packages/sdk/config.json` when present.
- `src/config.js` — loads topics/contracts + demo defaults; timeouts/stake thresholds are configurable.
- `src/types.js` — message type constants.
- `package.json` — local deps so we don’t modify the root workspace.

## Running (local, isolated)
```bash
cd orchestrator
npm install
OPERATOR_ACCOUNT_ID=0.0.x OPERATOR_PRIVATE_KEY=... npm start
```
Set `DEMO_MODE=true` to keep timeouts short.

## Deferred integrations (do later to avoid merge conflicts)
- Add a root script alias (e.g., `orchestrator`: `node orchestrator/src/index.js`).
- Optionally add this folder to the root workspaces for dependency hoisting.
- Swap local `types.js` for the shared `agents/shared/types.ts` once that branch lands.
- Replace the placeholder `auction.createJob` call with the final ABI method name after contracts stabilize.
- Add signature verification for PONG messages (reuse agent helpers when available).
- Persist roster/cache if desired; today it is in-memory only.
- Replace the lightweight stub modules in `orchestrator/node_modules/` with real npm installs when permissions allow (stubs are only for local tests).

## Tests (offline-friendly)
- A minimal test harness lives at `orchestrator/test/run-tests.js` (Node + assert; no external runner).
- Run with `npm test` inside `orchestrator/`. It exercises agent registration, discovery invites, and fallback winner selection using mocks.

## BYO-Agent touchpoints
- Uses `AGENT_REGISTERED` messages on auditLog topic to onboard agents.
- Sends PING on AgentComms; expects signed PONG (signature check can be added once the sub-agents publish their helper).
- Filters invites by stake/reputation/specializations and publishes `AUCTION_INVITE` messages.
