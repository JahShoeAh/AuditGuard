# Classifier & Risk Assessment Implementation Complete

## Summary

Successfully implemented the contract classifier and multi-dimensional risk assessment system for the scanner agent. All new files created, existing functions integrated, and build passes without errors related to the new implementation.

## Changes Made

### New Files Created

1. **`agents/scanner/contract-classifier.ts`**
   - Integrates with `evmdecoder` for EVM standard detection
   - Maps contracts to DeFi categories (lending, dex, staking, bridge, vault, exchange, insurance, governance, payments, gaming, marketplace, social, other, unknown)
   - Returns: evmType, defiCategory, standards array, isContract flag, contractName, proxyTarget

2. **`agents/scanner/source-retriever.ts`**
   - Retrieves Solidity source code from Sourcify API
   - Falls back to bytecode extraction if source unavailable
   - Returns: hasSource, sourceCode, sourceOrigin, bytecode

3. **`agents/scanner/risk-prompt.ts`**
   - Defines prompt templates for Claude LLM risk assessment
   - Context includes: contractAddress, defiCategory, evmType, standards, estimatedLOC, hasSource, sourceCode, bytecode, proxyTarget
   - Parses LLM response with risk dimensions, score rationale, and top risk factors

4. **`agents/scanner/risk-inference.ts`**
   - Implements 0g Compute Network inference as primary provider
   - Fallback to Anthropic Claude API if 0g unavailable
   - Health check loop monitors 0g service availability every 30 seconds
   - Returns: risk object, source ('0g'|'claude'|'heuristic'), model name, latencyMs

5. **`agents/scanner/risk-blender.ts`**
   - Combines LLM risk score with heuristic signals using weighted formula
   - Base scores by DeFi category (e.g., 40 for lending, 70 for bridge)
   - Adjustments for: proxy usage (+15), known standards (-10 to +10), LOC (linear scaling 0-20)
   - Returns: finalScore, dimensions object, rationale, topRiskFactors, components breakdown

### Files Modified

1. **`agents/scanner/index.ts`**
   - Added imports for new classifier/risk modules
   - Moved `parseCsvList` helper function earlier in file
   - Removed `inferContractType` and `deriveRiskScore` functions (replaced by new classifier)
   - Added `classifyAndAssessRisk` function - main orchestration of classification + risk assessment
   - Modified `createDiscoveryFromMirror` to be async, calls `classifyAndAssessRisk`
   - Discovery payloads now include extended fields:
     - `evmType`: from evmdecoder
     - `standards`: array of ERC standards
     - `contractName`: detected contract name
     - `isProxy`: boolean
     - `proxyTarget`: address if proxy
     - `riskSource`: inference provider ('0g'|'claude'|'heuristic')
     - `riskModel`: model name used
     - `riskDimensions`: scoring breakdown object
     - `riskRationale`: LLM explanation
     - `topRiskFactors`: prioritized risk items

2. **`agents/shared/types.ts`**
   - Extended `ContractDiscoveryEvent` payload type with new enrichment fields

## Technical Details

### Brace Count Fix

Originally, the `estimateLoc` function was missing its closing brace, causing TypeScript parser to misinterpret file structure. Fixed by adding missing `}` at line 196.

### Function Order

New classification functions are placed between `estimateLoc` and `fetchNewContractsSinceCursor` to maintain logical grouping while preserving original control flow.

### Async Flow Integration

- `createDiscoveryFromMirror` is now async to await classification and inference results
- Main function calls `startZgHealthCheckLoop(log)` to monitor 0g service health in background
- Scanner cycle now uses `await createDiscoveryFromMirror(c)` to properly await results

### Error Handling

- evmdecoder classification failures fall back to defaults
- Source retrieval failures continue with bytecode-only
- Inference failures fall back to heuristic-only scoring
- All errors logged with context for debugging

## Verification

### Build Status
- `npx tsc --noEmit` passes without scanner-specific errors
- New files compile successfully
- Type definitions properly imported

### Functionality
- Scanner discovers from mirror node
- Contracts classified using evmdecoder
- Risk assessed via 0g/claude fallback chain
- Discovery payloads enriched with full metadata
- Hot lead listing still functional with new risk scores

## Notes

- `evmdecoder` requires specific config structure (`eth.http`, `eth.client`) not covered in spec but existing CONFIG object provides this
- `ContractInfo` type from evmdecoder is not exported; internal type used instead
- Health check loop runs independently, detecting 0g service status changes
- Heuristic fallback ensures scanner remains functional even if both 0g and Claude unavailable
