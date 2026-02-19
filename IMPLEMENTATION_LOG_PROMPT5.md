# Prompt 5 Implementation Log

Date: February 19, 2026  
Scope: Add test-contract source snapshot file, extend discovery type with `sourceRef`, add test contract config entries, and enable scanner test-mode discovery selection.

## Files read

- `packages/sdk/config.json`
- `agents/scanner/index.ts`
- `agents/shared/types.ts`

## Files changed

- `packages/sdk/test-contract-sources.json` (new)
- `agents/shared/types.ts`
- `packages/sdk/config.json`
- `agents/scanner/index.ts`
- `agents/shared/config.ts` (supporting change so scanner can read `testContracts` through existing shared `CONFIG`)

## What was implemented

### 1) Generated `packages/sdk/test-contract-sources.json`

Created by reading:
- `packages/contracts/contracts/test/VulnerableVault1.sol`
- `packages/contracts/contracts/test/VulnerableVault2.sol`
- `packages/contracts/contracts/test/VulnerableVault3.sol`

and writing JSON keys:
- `vault1`
- `vault2`
- `vault3`

Each key stores full Solidity source as a JSON string.

### 2) Added `sourceRef` to discovery payload type

File:
- `agents/shared/types.ts:26`

Change:
- Added optional field:
  - `sourceRef?: string;`
to `ContractDiscoveryEvent.payload`.

### 3) Added top-level `testContracts` array in SDK config

File:
- `packages/sdk/config.json:56`

Added placeholders:
- `vault1` -> `0x...0001`
- `vault2` -> `0x...0002`
- `vault3` -> `0x...0003`

with deployer placeholder `0x...0000`.

### 4) Scanner test mode discovery path

File:
- `agents/scanner/index.ts:29`

At top of `generateDiscovery()`:
- If `TEST_MODE === "true"`:
  - reads `CONFIG.testContracts`
  - randomly picks one configured test contract
  - returns a `CONTRACT_DISCOVERED` event using that address/deployer
  - sets:
    - `estimatedLOC: 150`
    - `riskScore: 75`
    - `contractType: "vault"`
    - `sourceRef: pick.key`
- Existing random generation remains intact as fallback.

### 5) Supporting shared config wiring

File:
- `agents/shared/config.ts`

Added:
- `testContracts` to `SdkConfig` interface
- `CONFIG.testContracts` mapped from `packages/sdk/config.json`

This keeps scanner on the same config-loading mechanism already used in agents.

## Verification commands and results

1. `cat packages/sdk/test-contract-sources.json | head -5`
- Result: JSON output visible with Solidity source strings under `vault1`, etc.

2. `grep -n "sourceRef" agents/scanner/index.ts`
- Result: `sourceRef` found in generated discovery payload.

3. `grep -n "sourceRef" agents/shared/types.ts`
- Result: `sourceRef?: string;` found in discovery payload type.

4. Optional type-check attempt:
- Command: `npx tsc --noEmit -p agents/tsconfig.json`
- Result: blocked by pre-existing dependency issue:
  - `agents/llm-contextual/zg-client.ts(52,57): Cannot find module '@0glabs/0g-serving-broker'`

## Potential bugs / follow-up notes

### 1) Placeholder test contract addresses will emit non-live discoveries

Location:
- `packages/sdk/config.json:56`

Impact:
- In `TEST_MODE`, scanner may emit discoveries for placeholder addresses until deploy output replaces them.

### 2) Source snapshot staleness risk

Location:
- `packages/sdk/test-contract-sources.json`

Impact:
- If any vulnerable contract source changes, this JSON becomes stale unless regenerated.

### 3) Fixed test-mode metadata narrows scenario coverage

Location:
- `agents/scanner/index.ts:44-46`

Impact:
- All test-mode events currently use `estimatedLOC=150`, `riskScore=75`, `contractType="vault"`, which may reduce coverage in downstream scoring logic.

