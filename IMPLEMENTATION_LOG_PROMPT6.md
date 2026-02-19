# Prompt 6 Implementation Log

Date: February 19, 2026  
Scope: Load contract source by `sourceRef` and include Solidity source in LLM prompt context.

## Files read

- `agents/llm-contextual/index.ts`
- `agents/llm-contextual/prompt-builder.ts`

## Files changed

- `agents/shared/contract-source.ts` (new)
- `agents/llm-contextual/prompt-builder.ts`
- `agents/llm-contextual/index.ts`

## What was implemented

### 1) New shared source loader

Created:
- `agents/shared/contract-source.ts`

Added:
- in-memory cache `sourceCache`
- `loadContractSource(sourceRef: string): string | null`
- file loading from:
  - `packages/sdk/test-contract-sources.json`
  - using the same relative-path style as shared config (via `import.meta.url` + `dirname` + `join`)

### 2) Prompt context extended with `contractSource`

Updated:
- `agents/llm-contextual/prompt-builder.ts:11`

Change:
- `AuditContext` now includes:
  - `contractSource?: string;`

Prompt update:
- `buildUserPrompt` now appends a Solidity code block + explicit vulnerability instruction block when `ctx.contractSource` is present.

### 3) LLM contextual agent now loads source by `sourceRef`

Updated:
- `agents/llm-contextual/index.ts`

Changes:
- imported:
  - `loadContractSource` from `../shared/contract-source.js`
- threaded `sourceRef` through job flow:
  - discovery queue state now stores optional `sourceRef`
  - pending job state now stores optional `sourceRef`
  - `simulateAuditCycle` now accepts `sourceRef`
- before calling `analyzeWithAI`, source is loaded when `sourceRef` exists:
  - logs: `[LLMContextual-3] Loaded <len> chars of source for <sourceRef>`
- passed `contractSource` into the `AuditContext` object sent to inference.

## Verification

Required checks:

1. `grep -n "contractSource" agents/llm-contextual/prompt-builder.ts`
- Found:
  - context field
  - prompt append block

2. `grep -n "loadContractSource" agents/llm-contextual/index.ts`
- Found:
  - import
  - usage before inference

Additional check:

- `npx tsc --noEmit -p agents/tsconfig.json` still fails on pre-existing dependency issue:
  - `agents/llm-contextual/zg-client.ts(52,57): Cannot find module '@0glabs/0g-serving-broker'`

## Potential bugs / follow-up notes

### 1) `sourceRef` may be missing in some runtime paths

Location:
- `agents/llm-contextual/index.ts` around AUCTION_INVITE + pending job creation

Risk:
- If orchestrator invite messages do not carry `sourceRef` and local discovery queue entry is absent, source loading will be skipped.

Impact:
- LLM falls back to metadata-only prompt for that job.

### 2) Source file path may depend on execution mode

Location:
- `agents/shared/contract-source.ts:11`

Risk:
- Path assumes same layout approach as shared config. If runtime execution base changes unexpectedly, loader could fail and log warning.

Impact:
- Source enrichment disabled; audit still runs.

### 3) Existing risk-score behavior remains unchanged

Location:
- `agents/llm-contextual/index.ts:573`

Observation:
- `analyzeWithAI` context still passes `riskScore: 0` during audit cycle.

Impact:
- Prompt may under-represent risk severity signal.

Status:
- Not changed in this prompt to avoid unrelated behavior changes.

