# Prompt 1 Implementation Log

Date: February 19, 2026
Scope: Add on-chain `selectWinners()` plumbing and route fallback winner notifications to `agentComms` + `auditLog`.

## Files reviewed before implementation

- `orchestrator/src/contract-client.js`
- `orchestrator/src/orchestrator.js`
- `packages/sdk/abis/AuditAuction.json` (confirmed `selectWinners` exists in ABI)

## What was implemented

### 1) Contract client method added

File: `orchestrator/src/contract-client.js:65`

Added:

```js
async selectWinners(jobId, winningBidIndices) {
  const tx = await this.auction.selectWinners(jobId, winningBidIndices);
  const receipt = await tx.wait();
  return receipt;
}
```

Reason:
- Exposes a direct orchestrator-level helper for `AuditAuction.selectWinners(...)`.

Behavior impact:
- No behavioral change until called.

---

### 2) `selectWinnersFallback` now tries on-chain first, then HCS fallback on failure

File: `orchestrator/src/orchestrator.js:559`

Key updates:

- Changed function signature to async:
  - `selectWinnersFallback(jobId)` -> `async selectWinnersFallback(jobId)`
- Preserved existing scoring and winner-picking logic.
- Added `bidIndex` while scoring bids so on-chain indices can be submitted:
  - `job.bidders.map((b, bidIndex) => ...)`
- After winners are chosen:
  - Attempt on-chain selection via:
    - `await this.contracts.selectWinners(jobId, winningBidIndices)`
  - On success:
    - logs success
    - sets `job.winnerSource = "on-chain"`
    - returns
  - On failure:
    - logs warning
    - sets fallback metadata:
      - `job.selectionEpoch = Date.now()`
      - `job.winnerSource = "fallback"`
    - publishes `WINNERS_SELECTED_FALLBACK` to:
      - `CONFIG.hcsTopics.agentComms`
      - `CONFIG.hcsTopics.auditLog`

Fallback payload shape now:

```js
{
  type: "WINNERS_SELECTED_FALLBACK",
  payload: {
    jobId,
    winners: [{ agentId, evmAddress }],
    selectionEpoch,
    winnerSource: "fallback"
  }
}
```

Reason:
- Ensures agents listening on `agentComms` receive fallback winner notifications.
- Keeps dashboard visibility by still publishing to `auditLog`.

Behavior impact:
- Fallback winner message path now includes `agentComms`.
- Orchestrator now attempts a real on-chain winner selection first.

## Verification run

1. Confirmed fallback now publishes to `agentComms`:

Command:

```sh
grep -rn "agentComms" orchestrator/src/orchestrator.js
```

Relevant result:

- `orchestrator/src/orchestrator.js:633:    await this.hcs.publish(CONFIG.hcsTopics.agentComms, fallbackPayload);`

2. Syntax checks:

```sh
node --check orchestrator/src/contract-client.js
node --check orchestrator/src/orchestrator.js
```

Result:
- Both passed (no syntax errors).

## Potential bugs / deferred follow-ups

### A) No-bid (roster) path cannot produce real bid indices

Location:
- `orchestrator/src/orchestrator.js:608`

Symptom:
- In roster fallback mode, `selectedWinners` entries do not have true `bidIndex` values.
- `winningBidIndices` becomes `[undefined, ...]` and on-chain `selectWinners` is expected to fail/revert.

Severity:
- Medium (system still works via HCS fallback, but always logs on-chain failure in this branch).

Why this is a bug/risk:
- It causes predictable on-chain failure noise and extra failed tx attempts in no-bid scenarios.

Suggested later fix:
- Guard on-chain call to only run when valid numeric bid indices are available.

---

### B) Async fallback method is called in non-awaited contexts

Locations:
- `orchestrator/src/orchestrator.js:243` (`setTimeout(() => this.selectWinnersFallback(jobId), ...)`)
- `orchestrator/src/orchestrator.js:320` (`this.selectWinnersFallback(key);`)

Symptom:
- If async work inside `selectWinnersFallback` throws outside current try/catch scope (for example HCS publish failure), call sites do not await/catch, which can lead to unhandled promise rejection behavior.

Severity:
- Medium.

Why this is a bug/risk:
- Makes failure handling less deterministic under network issues.

Suggested later fix:
- Use `void this.selectWinnersFallback(...).catch(...)` at fire-and-forget call sites, or wrap internal publish block in local try/catch.

---

### C) Fallback message payload shape changed from address array to object array

Location:
- `orchestrator/src/orchestrator.js:626`

Symptom:
- Previous fallback payload used `winners: string[]` (addresses).
- New payload uses `winners: [{ agentId, evmAddress }]`.

Severity:
- Low to Medium (depends on consumer assumptions).

Why this is a bug/risk:
- Any downstream consumer expecting plain address array could break if not updated.

Suggested later fix:
- Confirm all consumers of `WINNERS_SELECTED_FALLBACK` parse the new structure, or include both formats temporarily during transition.

