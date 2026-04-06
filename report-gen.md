# AuditGuard — Report Generation Fix (Option A: Findings Store)

## Problem

The `FINDINGS_SUBMITTED` HCS message only carries counts + a hash:
```ts
{ jobId, findingsHash, findingsCount, criticalCount, highCount, mediumCount, lowCount }
```
Agents run as **separate child processes** (via `spawn` in `run-all.ts`), so there is no
shared memory. The report agent's `allFindings` reconstruction in `aggregateAndPublish()`
always produces an empty array — the IPFS Markdown report has `0 findings` in the body
even when agents found real vulnerabilities.

## Solution

Add a `/findings` store to `packages/static-analysis-service/` (3 new routes, ~60 lines).
Each audit agent POSTs its findings array after completing analysis. The report agent GETs
all findings for a job when it aggregates.

No new process. No new package.json. Fits the existing microservice pattern exactly.

---

## Architecture

```
Static Agent  ──POST /findings──▶
Fuzzer Agent  ──POST /findings──▶  static-analysis-service :4002  ◀──GET /findings/:jobId── Report Agent
LLM Agent     ──POST /findings──▶
```

### New routes in `packages/static-analysis-service/src/index.js`

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/findings` | Agent stores `{ jobId, agentId, findings[] }` after completing analysis |
| `GET`  | `/findings/:jobId` | Report agent fetches all findings for a job |
| `DELETE` | `/findings/:jobId` | Report agent cleans up after publishing |

In-memory store: `Map<jobId, { agentId, findings[], timestamp }[]>`

---

## Implementation Steps

### Step 1 — Add findings store routes to static-analysis-service

File: `packages/static-analysis-service/src/index.js`

Add after the existing `/analyze` and `/results` routes:

```js
// In-memory findings store: jobId → [{ agentId, findings, timestamp }]
const findingsStore = new Map();

// POST /findings
// Body: { jobId: string, agentId: string, findings: Finding[] }
app.post("/findings", (req, res) => {
  const { jobId, agentId, findings } = req.body ?? {};
  if (!jobId || !agentId || !Array.isArray(findings)) {
    return res.status(400).json({ error: "jobId, agentId, and findings[] are required" });
  }
  if (!findingsStore.has(jobId)) findingsStore.set(jobId, []);
  // Replace existing entry for same agentId (idempotent)
  const entries = findingsStore.get(jobId);
  const idx = entries.findIndex(e => e.agentId === agentId);
  const entry = { agentId, findings, timestamp: Date.now() };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  console.log(`[findings-store] Stored ${findings.length} findings for job ${jobId} from ${agentId}`);
  res.json({ ok: true, stored: findings.length });
});

// GET /findings/:jobId
app.get("/findings/:jobId", (req, res) => {
  const entries = findingsStore.get(req.params.jobId) ?? [];
  res.json({ jobId: req.params.jobId, agents: entries });
});

// DELETE /findings/:jobId
app.delete("/findings/:jobId", (req, res) => {
  findingsStore.delete(req.params.jobId);
  res.json({ ok: true });
});
```

### Step 2 — Add `postFindingsToStore()` helper to agents/shared

File: `agents/shared/findings-store-client.ts`

```ts
const FINDINGS_STORE_URL =
  process.env.STATIC_ANALYSIS_SERVICE_URL ?? "http://localhost:4002";

export async function postFindingsToStore(
  jobId: string,
  agentId: string,
  findings: unknown[],
  log: { warn: (msg: string) => void }
): Promise<void> {
  try {
    await fetch(`${FINDINGS_STORE_URL}/findings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, agentId, findings }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[findings-store] Could not store findings: ${msg} (report will fall back to count-only)`);
  }
}
```

Export from `agents/shared/index.ts`.

### Step 3 — Wire agents to POST findings after analysis

**agents/static-analysis/index.ts** — end of `simulateAuditCycle()`, after `findings` is computed:
```ts
import { postFindingsToStore } from "../shared/index.js";
// ...
await postFindingsToStore(jobId, AGENT_ID, findings, log);
```

**agents/fuzzer/index.ts** — end of `simulateAuditCycle()`, after `findings` is computed:
```ts
import { postFindingsToStore } from "../shared/index.js";
// ...
await postFindingsToStore(jobId, AGENT_ID, findings, log);
```

**agents/llm-contextual/index.ts** — same pattern after findings are generated.

### Step 4 — Fix report agent to fetch real findings

File: `agents/report/index.ts`

Replace the dead `allFindings` reconstruction in `aggregateAndPublish()`:

```ts
// BEFORE (broken — always empty):
const allFindings: ReportFinding[] = agentFindings.flatMap((af: any) =>
  (af?.findings || af?.results || af?.payload?.findings || []).map(...)
);

// AFTER (fetches from findings store):
let allFindings: ReportFinding[] = [];
try {
  const storeEntries = await getFindingsFromStore(jobId);
  if (storeEntries.length > 0) {
    allFindings = storeEntries.flatMap(({ findings }) =>
      findings.map((f: any) => ({
        severity: String(f?.severity || "MEDIUM").toUpperCase(),
        title: f?.title || "Unnamed Finding",
        description: f?.description || "",
        location: f?.location || undefined,
        recommendation: f?.recommendation || undefined,
      }))
    );
    log.info(`[ReportAgent] Fetched ${allFindings.length} findings from store`);
    await deleteFindingsFromStore(jobId); // cleanup
  } else {
    log.warn(`[ReportAgent] No findings in store — report will show counts only`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log.warn(`[ReportAgent] Could not fetch findings from store: ${msg}`);
}
```

### Step 5 — Update shared/index.ts exports

Add `postFindingsToStore`, `getFindingsFromStore`, `deleteFindingsFromStore` to the barrel export.

### Step 6 — Add test coverage

File: `agents/tests/report-gen.test.ts`

Tests covering:
- `postFindingsToStore()` — POSTs correctly, idempotent per agentId, silent on error, multiple agents
- `getFindingsFromStore()` / `deleteFindingsFromStore()` — fetch, empty, unavailable, delete, cleanup
- `formatReport()` — Markdown structure, severity counts, critical banner, sort order, location/recommendation, disclaimer, emoji icons
- Full integration — findings store → report agent → populated Markdown with real finding titles/descriptions
- Real agent mock findings → report round-trip (static + fuzzer `generateFindings` → `formatReport`)
- Store route logic — upsert behavior, severity normalization, missing severity defaults

---

## Files Changed

| File | Change |
|------|--------|
| `packages/static-analysis-service/src/index.js` | Add 3 findings store routes + in-memory Map |
| `agents/shared/findings-store-client.ts` | New file — `postFindingsToStore`, `getFindingsFromStore`, `deleteFindingsFromStore` |
| `agents/shared/index.ts` | Export all 3 findings store functions |
| `agents/static-analysis/index.ts` | Call `postFindingsToStore` in `simulateAuditCycle` |
| `agents/fuzzer/index.ts` | Call `postFindingsToStore` in `simulateAuditCycle` |
| `agents/llm-contextual/index.ts` | Call `postFindingsToStore` in `simulateAuditCycle` |
| `agents/report/index.ts` | Replace broken `allFindings` extraction with `getFindingsFromStore` + `deleteFindingsFromStore` |
| `agents/tests/report-gen.test.ts` | New test file — 30 tests, all passing |

---

## Environment Variables

No new env vars needed. The findings store lives on the same URL as the static-analysis-service:
```
STATIC_ANALYSIS_SERVICE_URL=http://localhost:4002   # already set
```

---

## Graceful Degradation

If the static-analysis-service is down:
- Agents log a warning and continue (findings not stored, but audit still completes)
- Report agent logs a warning and generates a counts-only report (same as prior behavior)
- No crash, no blocking

---

## Test Results

```
 Tests  30 passed (30)
 Duration  508ms
```

All 6 sections pass:
1. `postFindingsToStore()` — 5 tests
2. `getFindingsFromStore()` / `deleteFindingsFromStore()` — 6 tests
3. `formatReport()` Markdown content — 10 tests
4. Full integration findings store → report — 3 tests
5. Real agent findings → report round-trip — 3 tests
6. Store route logic — 3 tests

---

## What the Fixed Report Looks Like

```markdown
# Smart Contract Audit Report

| Field | Value |
|---|---|
| Contract | `0xabc...` |
| Chain | hedera-testnet |
| Type | lending |
| Auditors | static-analysis-047, fuzzer-012 |

## Executive Summary

This automated audit identified **9 findings**:

- **HIGH**: 2
- **MEDIUM**: 5
- **LOW**: 2

## Findings

### 🟠 [HIGH] Reentrancy Eth (Slither)

Contract.withdraw() sends ETH before updating state. An attacker can
re-enter and drain the contract balance.

---

### 🟠 [HIGH] Integer overflow found (ItyFuzz)

Arithmetic overflow detected in withdraw() function via fuzz corpus input
0xabcd1234...

---
... (all findings listed with descriptions)
```

Instead of the previous broken output:
```markdown
This automated audit identified **0 findings**:
```

---

## Static Analysis & Fuzzer Agent Implementation

### Tools Installed

| Tool | Install Method | Path | Purpose |
|------|---------------|------|---------|
| Slither | `pipx install slither-analyzer` | `~/.local/bin/slither` | 90+ detectors, Solidity source |
| Aderyn | `brew install cyfrin/tap/aderyn` | `/opt/homebrew/bin/aderyn` | Cyfrin Rust-based, 50+ detectors |
| Semgrep | `pipx install semgrep` | `~/.local/bin/semgrep` | DeFi exploit pattern matching |
| ItyFuzz | Docker / fuzzer-service | port 4001 | Bytecode-level fuzzing |
| Mythril | Docker / fuzzer-service | port 4001 | Symbolic execution |

PATH note: pipx installs to `~/.local/bin/` — `dev:all:unsafe` in root `package.json` prepends `$HOME/.local/bin` to PATH.

### Static Analysis Service (`packages/static-analysis-service/`)

Express API on port 4002, mirroring the fuzzer-service pattern.

| Route | Purpose |
|-------|---------|
| `GET /health` | Liveness check |
| `POST /analyze` | Submit job `{ contractAddress, sourceDir?, chainForkUrl }` |
| `GET /results/:jobId` | Poll for results |
| `POST /findings` | Store findings (cross-process) |
| `GET /findings/:jobId` | Fetch findings for report agent |
| `DELETE /findings/:jobId` | Cleanup after report published |

Runners run Slither → Aderyn → Semgrep in sequence; findings are deduplicated by title across tools. Finding IDs prefixed `SA-SLTH-`, `SA-ADERYN-`, `SA-SEMG-`.

### Agent Fallback Pattern

Both static and fuzzer agents follow the same graceful degradation:
```
runStaticAnalysisOrFallback() / runFuzzOrFallback()
  ├─ Submit job to service
  ├─ Poll for results (timeout: budget seconds)
  ├─ If results.length > 0 → return real findings
  └─ Else → return generateFindings() mock (always produces valid output)
```

### Test Coverage (agents/tests/)

| File | Tests | Coverage |
|------|-------|----------|
| `static-fuzzer-service.test.ts` | 76 | Static agent bid/findings/analysis, fuzzer bid/findings/fuzz, competition, cross-agent reports, service parser unit tests, E2E flow |
| `report-gen.test.ts` | 30 | Findings store client, formatReport Markdown, full integration, real agent round-trip, store route logic |
| **Total** | **106** | **All passing** |
