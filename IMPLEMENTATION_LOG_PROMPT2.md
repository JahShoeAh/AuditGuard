# Prompt 2 Implementation Log

Date: February 19, 2026  
Scope: Add `WINNERS_SELECTED_FALLBACK` handling to all bidding agents and prevent duplicate audit starts.

## Files updated

- `agents/static-analysis/index.ts`
- `agents/fuzzer/index.ts`
- `agents/llm-contextual/index.ts`
- `agents/dependency/index.ts`

## What was changed

### 1) Added module-level dedup tracking in all 4 agents

- Added `const startedJobs = new Set<string>();` in:
  - `agents/static-analysis/index.ts:38`
  - `agents/fuzzer/index.ts:38`
  - `agents/llm-contextual/index.ts:51`
  - `agents/dependency/index.ts:17`

### 2) Added `WINNERS_SELECTED_FALLBACK` handling to all 4 `agentComms` handlers

- Static analysis:
  - `agents/static-analysis/index.ts:256`
  - Dedupe key format: ``${jobId}:${selectionEpoch ?? "0"}``
  - Winner detection checks both winner shapes:
    - object format: `{ evmAddress }`
    - legacy format: `string` address
  - On win:
    - logs winner via fallback
    - marks dedup key
    - removes job from `pendingJobs`
    - starts `simulateAuditCycle(...)`

- Fuzzer:
  - `agents/fuzzer/index.ts:273`
  - Same dedupe/winner/start pattern as static analysis
  - Starts `simulateAuditCycle(...)` on fallback win

- LLM contextual:
  - `agents/llm-contextual/index.ts:353`
  - Same dedupe/winner/start pattern as static analysis
  - Starts `simulateAuditCycle(...)` on fallback win

- Dependency agent (special case):
  - `agents/dependency/index.ts:82`
  - Handles fallback message with dedupe + explicit ignore log:
    - `"[DependencyAgent-8] Received main job fallback — ignoring (sub-contractor only)"`
  - Does not start main-job audit cycle (sub-auction worker only)

### 3) Static-analysis special-case timeout gating (double-fire prevention)

- Added helper:
  - `hasStartedJob(jobId: string)` at `agents/static-analysis/index.ts:40`
- Gated the existing auto-simulate timeout:
  - `agents/static-analysis/index.ts:234`
  - It now skips if the job is already started (dedupe set)
- Timeout path now marks started:
  - `startedJobs.add(\`${jobId}:timeout\`)`

## Verification performed

### Required grep

Command:

```sh
grep -rn "WINNERS_SELECTED_FALLBACK" agents/
```

Result (all 4 agent files contain handler):

- `agents/static-analysis/index.ts:256`
- `agents/fuzzer/index.ts:273`
- `agents/llm-contextual/index.ts:353`
- `agents/dependency/index.ts:82`

### TypeScript compile check

Command:

```sh
npx tsc --noEmit -p agents/tsconfig.json
```

Result:

- Fails due to pre-existing environment/dependency issue unrelated to this prompt’s edits:
  - `agents/llm-contextual/zg-client.ts(52,57): error TS2307: Cannot find module '@0glabs/0g-serving-broker'`

No new compile error from the modified files was surfaced before that failure.

## Potential bugs / follow-up notes

### 1) Fallback message can arrive before local job context exists

Location:
- `agents/static-analysis/index.ts:269`
- `agents/fuzzer/index.ts:286`
- `agents/llm-contextual/index.ts:366`

Symptom:
- If fallback winner message is received before `AUCTION_INVITE` is processed locally, `pendingJobs.get(jobId)` is missing and audit start is skipped.

Impact:
- Winner might not start work unless another trigger arrives.

Suggested follow-up:
- Buffer fallback wins briefly or recover job context from message payload if missing.

### 2) `startedJobs` is append-only for process lifetime

Location:
- all four agents where `startedJobs` is used.

Symptom:
- Set entries are never removed.

Impact:
- Small memory growth over long-running sessions with high job volume.

Suggested follow-up:
- Add pruning policy (e.g., delete entries after completion/settlement or cap with LRU behavior).

