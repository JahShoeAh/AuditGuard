# Orchestrator Agent (isolated branch-safe scaffold)

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
- Wire to shared agent types once sub-agent branch lands; currently uses local `types.js`.
- Replace the placeholder `auction.createJob` call with the final ABI method name after contracts stabilize.
- Hook settlement flow: collect `FINDINGS_SUBMITTED` and call `paymentSettlement.settleJob`.
- Persist roster/cache if desired; today it is in-memory only.

## BYO-Agent touchpoints
- Uses `AGENT_REGISTERED` messages on auditLog topic to onboard agents.
- Sends PING on AgentComms; expects signed PONG (signature check can be added once the sub-agents publish their helper).
- Filters invites by stake/reputation/specializations and publishes `AUCTION_INVITE` messages.
