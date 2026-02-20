# Classifier & Risk Assessment Implementation Guide

## Overview

This document specifies the implementation of two capabilities integrated **synchronously into the scanner agent** (`agents/scanner/index.ts`), executed **before** the `CONTRACT_DISCOVERED` event is published to HCS:

1. **Contract Classification** — Uses the `evmdecoder` npm package to identify the EVM standard (ERC20, ERC721, proxy, etc.) and maps the result to a DeFi protocol category (`lending | dex | staking | bridge | vault`).
2. **Risk Assessment** — Uses 0g Compute Network inference (with Claude API fallback) to produce a multi-dimensional risk score, blended with heuristic signals via a weighted formula.

**Default category when classification is indeterminate: `lending`.**

---

## Table of Contents

1. [Dependencies](#1-dependencies)
2. [evmdecoder Integration](#2-evmdecoder-integration)
3. [DeFi Category Mapping](#3-defi-category-mapping)
4. [Source Code Retrieval](#4-source-code-retrieval)
5. [Risk Assessment Prompt Design](#5-risk-assessment-prompt-design)
6. [0g Inference Client (Risk)](#6-0g-inference-client-risk)
7. [Claude API Fallback with Health-Check Loop](#7-claude-api-fallback-with-health-check-loop)
8. [Weighted Risk Blend Formula](#8-weighted-risk-blend-formula)
9. [Scanner Integration](#9-scanner-integration)
10. [Type Updates](#10-type-updates)
11. [Error Handling](#11-error-handling)
12. [Environment Variables](#12-environment-variables)
13. [Testing Strategy](#13-testing-strategy)

---

## 1. Dependencies

Install the following packages in the `agents/` workspace:

```bash
npm install evmdecoder @anthropic-ai/sdk
```

- `evmdecoder` — Bytecode analysis and contract type identification.
- `@anthropic-ai/sdk` — Claude API client for LLM fallback when 0g inference is unavailable.
- `@0glabs/0g-serving-broker` — Already installed; used for primary inference.

**No changes** to `ethers` (already a dependency).

---

## 2. evmdecoder Integration

### 2.1 New File: `agents/scanner/contract-classifier.ts`

This module initializes `evmdecoder` once and exposes a `classifyContract` function.

```typescript
import EvmDecoder from "evmdecoder";

// ── Types ──

export interface ClassificationResult {
  /** Raw EVM standard type from evmdecoder (e.g., "Token", "NFT", "Proxy") */
  evmType: string;
  /** Mapped DeFi protocol category */
  defiCategory: DefiCategory;
  /** ERC standards detected (e.g., ["ERC20", "ERC1967"]) */
  standards: string[];
  /** Whether the address is a contract at all */
  isContract: boolean;
  /** Contract name if identifiable (e.g., "USDC") */
  contractName: string | null;
  /** Proxy target address if applicable */
  proxyTarget: string | null;
}

export type DefiCategory = "lending" | "dex" | "staking" | "bridge" | "vault";

// ── Singleton ──

let decoderInstance: EvmDecoder | null = null;
let initPromise: Promise<void> | null = null;

function getRpcUrl(): string {
  return (
    process.env.SCANNER_EVM_RPC_URL ||
    process.env.HEDERA_JSON_RPC_URL ||
    "https://testnet.hashio.io/api"
  );
}

async function ensureDecoder(): Promise<EvmDecoder> {
  if (decoderInstance) return decoderInstance;

  if (!initPromise) {
    initPromise = (async () => {
      decoderInstance = new EvmDecoder({
        eth: {
          url: getRpcUrl(),
          timeout: 15_000,
        },
        abi: {
          directory: "./abis",
          searchRecursive: true,
          requireContractMatch: false,
        },
        contractInfo: {
          maxCacheEntries: 5_000,
        },
      });
      await decoderInstance.initialize();
    })();
  }

  await initPromise;
  return decoderInstance!;
}

// ── Public API ──

export async function classifyContract(
  contractAddress: string
): Promise<ClassificationResult> {
  const decoder = await ensureDecoder();
  const info = await decoder.contractInfo({ address: contractAddress });

  if (!info.isContract) {
    return {
      evmType: "EOA",
      defiCategory: "lending", // default
      standards: [],
      isContract: false,
      contractName: null,
      proxyTarget: null,
    };
  }

  const evmType = info.contractType?.name ?? "unknown";
  const standards: string[] = info.contractType?.standards ?? [];
  const contractName = info.contractName ?? null;

  // Extract proxy target if present
  let proxyTarget: string | null = null;
  if (info.contractType?.proxies && info.contractType.proxies.length > 0) {
    const lastProxy = info.contractType.proxies[info.contractType.proxies.length - 1];
    proxyTarget = lastProxy?.target ?? null;
  }

  const defiCategory = mapEvmTypeToDefiCategory(evmType, standards, info);

  return {
    evmType,
    defiCategory,
    standards,
    isContract: true,
    contractName,
    proxyTarget,
  };
}

/** Reset decoder state (for tests). */
export function _resetDecoder(): void {
  decoderInstance = null;
  initPromise = null;
}
```

### 2.2 Key Implementation Notes

- **Singleton pattern**: `evmdecoder` is initialized once per process lifetime. The `initialize()` call fetches ABI fingerprints and sets up the WASM module — this is expensive and must not run per-contract.
- **RPC URL**: Uses the Hedera JSON-RPC relay (Hashio) since evmdecoder needs `eth_getCode` and `eth_call` which the Hedera Mirror Node REST API does not support.
- **Proxy resolution**: If `contractType.proxies` is populated, the decoder has detected a proxy pattern. The implementation address is the final entry's `target`. The classifier should analyze the **implementation** contract type, not the proxy shell.

---

## 3. DeFi Category Mapping

### 3.1 Mapping Function

Add this to `agents/scanner/contract-classifier.ts`:

```typescript
/**
 * Maps evmdecoder's EVM standard type + detected standards to a DeFi
 * protocol category. Falls back to "lending" when indeterminate.
 *
 * Mapping rationale:
 * - ERC20 Token alone → likely a standalone token; default "lending" (most
 *   common DeFi primitive that handles tokens)
 * - ERC721/ERC1155 NFT → "vault" (NFT vaults, wrapped NFTs)
 * - ERC3156 (flash loan) → "lending"
 * - GnosisSafe/Multisig → "vault" (treasury/multisig vaults)
 * - Diamond (ERC2535) → "vault" (complex multi-facet contracts)
 * - Proxy patterns → classify the implementation, not the proxy
 * - unknown → "lending" (default)
 *
 * Function selector heuristics (checked against bytecode):
 * - swap/addLiquidity/removeLiquidity selectors → "dex"
 * - stake/unstake/delegate selectors → "staking"
 * - deposit/withdraw + crossChain/bridge selectors → "bridge"
 * - borrow/repay/liquidate selectors → "lending"
 * - deposit/withdraw (without bridge selectors) → "vault"
 */
const FUNCTION_SELECTOR_HINTS: Record<string, DefiCategory> = {
  // DEX selectors
  "0x38ed1739": "dex",     // swapExactTokensForTokens
  "0x7ff36ab5": "dex",     // swapExactETHForTokens
  "0xe8e33700": "dex",     // addLiquidity
  "0xbaa2abde": "dex",     // removeLiquidity
  "0x128acb08": "dex",     // swap (Uniswap V3)
  "0x022c0d9f": "dex",     // swap (Uniswap V2 pair)

  // Lending selectors
  "0xc5ebeaec": "lending", // borrow
  "0x0e752702": "lending", // repay
  "0x573ade81": "lending", // repayBorrow
  "0xe9c714f2": "lending", // liquidateBorrow
  "0xa0712d68": "lending", // mint (cToken style)

  // Staking selectors
  "0xa694fc3a": "staking", // stake
  "0x2e17de78": "staking", // unstake
  "0x5c19a95c": "staking", // delegate
  "0xb88d4fde": "staking", // safeTransferFrom (staking NFTs)

  // Bridge selectors
  "0x0f5287b0": "bridge",  // bridgeOut
  "0x8b7bfd70": "bridge",  // bridge
  "0xa44bbb15": "bridge",  // sendToL2
  "0x3805550f": "bridge",  // depositERC20

  // Vault selectors
  "0xb6b55f25": "vault",   // deposit(uint256)
  "0x2e1a7d4d": "vault",   // withdraw(uint256)
  "0xba087652": "vault",   // harvest
};

function mapEvmTypeToDefiCategory(
  evmType: string,
  standards: string[],
  info: any
): DefiCategory {
  const typeLower = evmType.toLowerCase();

  // 1. Direct standard-based mapping
  if (standards.includes("ERC3156")) return "lending"; // flash loans
  if (typeLower === "gnosissafe" || typeLower === "gnosis multisig") return "vault";
  if (typeLower === "diamond") return "vault";

  // 2. NFT types → vault
  if (standards.includes("ERC721") || standards.includes("ERC1155")) return "vault";

  // 3. Proxy → the evmType reflects the proxy, not the impl.
  //    The impl type is in contractType.proxies[last].
  //    If we can't determine the impl type, fall through to selector analysis.

  // 4. Function selector heuristic analysis
  //    evmdecoder exposes the bytecode fingerprint; we check known selectors
  //    against the bytecode if available.
  const bytecode: string | undefined = info?.bytecode;
  if (bytecode && bytecode.length > 10) {
    const selectorHits: Record<DefiCategory, number> = {
      lending: 0,
      dex: 0,
      staking: 0,
      bridge: 0,
      vault: 0,
    };

    for (const [selector, category] of Object.entries(FUNCTION_SELECTOR_HINTS)) {
      // Remove "0x" prefix and check if the selector appears in bytecode
      const selectorHex = selector.slice(2);
      if (bytecode.includes(selectorHex)) {
        selectorHits[category]++;
      }
    }

    // Pick category with most selector hits (minimum 1 hit required)
    let bestCategory: DefiCategory = "lending";
    let bestCount = 0;
    for (const [cat, count] of Object.entries(selectorHits)) {
      if (count > bestCount) {
        bestCount = count;
        bestCategory = cat as DefiCategory;
      }
    }

    if (bestCount > 0) return bestCategory;
  }

  // 5. ERC20 token with no distinguishing selectors → lending (default)
  // 6. unknown → lending (default)
  return "lending";
}
```

### 3.2 Mapping Decision Matrix

| evmdecoder `contractType.name` | Standards Detected | Mapped DeFi Category |
|---|----|---|
| Token | ERC20 | Selector-based, fallback `lending` |
| Token | ERC20 + ERC3156 | `lending` |
| NFT | ERC721 | `vault` |
| NFT | ERC1155 | `vault` |
| GnosisSafe | — | `vault` |
| Diamond | ERC2535 | `vault` |
| Proxy | ERC1967/ERC897 | Selector-based on impl bytecode |
| Clone | ERC1167 | Selector-based |
| unknown | — | `lending` (default) |

---

## 4. Source Code Retrieval

### 4.1 New File: `agents/scanner/source-retriever.ts`

Before calling the LLM for risk assessment, attempt to retrieve verified Solidity source. This provides dramatically better risk analysis than bytecode alone.

```typescript
import { ethers } from "ethers";

export interface SourceRetrievalResult {
  /** Whether verified source was found */
  hasSource: boolean;
  /** Solidity source code (null if not found) */
  sourceCode: string | null;
  /** Where the source was retrieved from */
  sourceOrigin: "sourcify_full" | "sourcify_partial" | "bytecode_only";
  /** Raw bytecode hex (always available) */
  bytecode: string;
}

const SOURCIFY_BASE = "https://sourcify.dev/server/files";
const HEDERA_CHAIN_ID = 296; // Hedera testnet

/**
 * Attempts to retrieve verified Solidity source for a contract.
 * Tries Sourcify first (full match → partial match), falls back to
 * raw bytecode from the JSON-RPC relay.
 */
export async function retrieveContractSource(
  contractAddress: string,
  rpcUrl: string
): Promise<SourceRetrievalResult> {
  const checksumAddress = ethers.getAddress(contractAddress);

  // 1. Always fetch bytecode (needed for fallback and heuristic scoring)
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let bytecode = "";
  try {
    bytecode = await provider.getCode(checksumAddress);
  } catch {
    bytecode = "0x";
  }

  // 2. Try Sourcify full match
  const fullMatchSource = await fetchSourcify(checksumAddress, "full");
  if (fullMatchSource) {
    return {
      hasSource: true,
      sourceCode: fullMatchSource,
      sourceOrigin: "sourcify_full",
      bytecode,
    };
  }

  // 3. Try Sourcify partial match
  const partialMatchSource = await fetchSourcify(checksumAddress, "partial");
  if (partialMatchSource) {
    return {
      hasSource: true,
      sourceCode: partialMatchSource,
      sourceOrigin: "sourcify_partial",
      bytecode,
    };
  }

  // 4. No verified source available
  return {
    hasSource: false,
    sourceCode: null,
    sourceOrigin: "bytecode_only",
    bytecode,
  };
}

async function fetchSourcify(
  address: string,
  matchType: "full" | "partial"
): Promise<string | null> {
  const matchPath = matchType === "full" ? "full_match" : "partial_match";
  // Sourcify stores files at: /files/{matchType}/{chainId}/{address}/
  // The main contract source is typically the largest .sol file
  const metadataUrl =
    `${SOURCIFY_BASE}/${matchPath}/${HEDERA_CHAIN_ID}/${address}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(metadataUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const files: any[] = await res.json();
    if (!Array.isArray(files)) return null;

    // Find the primary .sol file (not interfaces/libraries)
    const solFiles = files.filter(
      (f: any) =>
        typeof f.path === "string" &&
        f.path.endsWith(".sol") &&
        !f.path.includes("/interfaces/") &&
        !f.path.includes("/libraries/")
    );

    if (solFiles.length === 0) return null;

    // Pick the largest source file (heuristic: main contract is usually largest)
    solFiles.sort(
      (a: any, b: any) =>
        (b.content?.length ?? 0) - (a.content?.length ?? 0)
    );

    return solFiles[0].content ?? null;
  } catch {
    return null;
  }
}
```

### 4.2 Why Source Retrieval Matters for Risk

- **With Solidity source**: The LLM can identify reentrancy guards, access control patterns, oracle dependencies, flash loan callbacks, governance logic, and upgradeability risks with high confidence.
- **With bytecode only**: The LLM can analyze function selectors, identify known vulnerable patterns (e.g., DELEGATECALL in fallback), estimate complexity, but confidence is significantly lower.
- The risk prompt (Section 5) adapts its instructions based on whether source is available.

---

## 5. Risk Assessment Prompt Design

### 5.1 New File: `agents/scanner/risk-prompt.ts`

The LLM risk assessment prompt requests a structured JSON response with scores across five risk dimensions.

```typescript
import type { DefiCategory } from "./contract-classifier.js";

export interface RiskPromptContext {
  contractAddress: string;
  defiCategory: DefiCategory;
  evmType: string;
  standards: string[];
  estimatedLOC: number;
  hasSource: boolean;
  sourceCode: string | null;
  bytecode: string;
  proxyTarget: string | null;
}

export interface LLMRiskResponse {
  /** Overall composite risk score 0-100 */
  overallRisk: number;
  /** Individual dimension scores, each 0-100 */
  dimensions: {
    technicalVulnerabilities: number;
    designAndLogicFlaws: number;
    externalDependencies: number;
    operationalRisks: number;
    marketGovernanceRisks: number;
  };
  /** Brief justification for the overall risk */
  rationale: string;
  /** Top 3 identified risk factors */
  topRiskFactors: string[];
}

export function buildRiskSystemPrompt(): string {
  return `You are an expert smart contract risk assessor. Your task is to evaluate the risk profile of a smart contract across five dimensions. You MUST respond with valid JSON only. No prose, no markdown outside of the JSON block.

Response format:
{
  "overallRisk": <integer 0-100>,
  "dimensions": {
    "technicalVulnerabilities": <integer 0-100>,
    "designAndLogicFlaws": <integer 0-100>,
    "externalDependencies": <integer 0-100>,
    "operationalRisks": <integer 0-100>,
    "marketGovernanceRisks": <integer 0-100>
  },
  "rationale": "<2-3 sentence justification>",
  "topRiskFactors": ["<factor1>", "<factor2>", "<factor3>"]
}

Dimension definitions:

1. technicalVulnerabilities (0-100): Reentrancy, integer overflow/underflow, unchecked external calls, storage collisions, flash loan attack vectors, front-running susceptibility, denial of service vectors, delegatecall misuse.

2. designAndLogicFlaws (0-100): Business logic correctness, state machine integrity, edge case handling, invariant violations, incorrect access control hierarchy, missing input validation, improper event emission.

3. externalDependencies (0-100): Oracle reliance and manipulation risk, cross-contract call trust assumptions, imported library vulnerabilities, upgradeability proxy risks, reliance on external price feeds, composability attack surface.

4. operationalRisks (0-100): Admin key centralization, privileged function exposure, lack of timelocks on critical operations, missing pause/emergency mechanisms, deployment configuration errors, susceptibility to human error in parameter setting.

5. marketGovernanceRisks (0-100): Token economic model risks, governance manipulation (flash loan governance), liquidity concentration, rug pull indicators (unrestricted minting, hidden transfer fees), regulatory exposure, MEV extraction vulnerability.

Scoring guide:
- 0-20: Minimal risk. Well-audited patterns, battle-tested code.
- 21-40: Low risk. Minor concerns, standard DeFi patterns.
- 41-60: Medium risk. Notable concerns requiring attention.
- 61-80: High risk. Significant vulnerabilities or design issues.
- 81-100: Critical risk. Exploitable vulnerabilities or severe design flaws.

Rules:
- All scores MUST be integers between 0 and 100.
- overallRisk should reflect a weighted consideration of all five dimensions, not a simple average.
- topRiskFactors must contain exactly 3 strings, each under 80 characters.
- If analyzing bytecode only (no source), increase uncertainty — bias scores toward the 40-70 range unless clear red/green flags are present.
- Consider the contract's DeFi category when assessing risks (e.g., lending contracts face oracle manipulation; bridges face cross-chain replay; DEXes face sandwich attacks).`;
}

export function buildRiskUserPrompt(ctx: RiskPromptContext): string {
  let prompt = `Assess the risk profile of the following smart contract:

Contract Address: ${ctx.contractAddress}
DeFi Category: ${ctx.defiCategory}
EVM Type: ${ctx.evmType}
Standards: ${ctx.standards.length > 0 ? ctx.standards.join(", ") : "none detected"}
Estimated Lines of Code: ${ctx.estimatedLOC}
Proxy: ${ctx.proxyTarget ? `Yes (implementation: ${ctx.proxyTarget})` : "No"}
Source Available: ${ctx.hasSource ? "Yes (verified Solidity)" : "No (bytecode only)"}`;

  if (ctx.hasSource && ctx.sourceCode) {
    // Truncate source to ~12000 chars to stay within token limits
    const maxSourceLength = 12_000;
    const truncatedSource =
      ctx.sourceCode.length > maxSourceLength
        ? ctx.sourceCode.slice(0, maxSourceLength) + "\n// ... [truncated]"
        : ctx.sourceCode;

    prompt += `\n\nVerified Solidity Source:\n\`\`\`solidity\n${truncatedSource}\n\`\`\``;
  } else if (ctx.bytecode && ctx.bytecode.length > 4) {
    // Provide first 2000 chars of bytecode for pattern analysis
    const truncatedBytecode = ctx.bytecode.slice(0, 2000);
    prompt += `\n\nBytecode (first 1000 bytes):\n${truncatedBytecode}`;
    prompt += `\nTotal bytecode length: ${ctx.bytecode.length} hex chars (${Math.floor((ctx.bytecode.length - 2) / 2)} bytes)`;
  }

  prompt += `\n\nProvide your risk assessment as JSON. Consider the "${ctx.defiCategory}" category's specific attack vectors.`;

  return prompt;
}

export function buildRiskMessages(
  ctx: RiskPromptContext
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: buildRiskSystemPrompt() },
    { role: "user", content: buildRiskUserPrompt(ctx) },
  ];
}
```

### 5.2 Response Parsing

Add to `agents/scanner/risk-prompt.ts`:

```typescript
export function parseRiskResponse(raw: string): LLMRiskResponse | null {
  if (!raw || !raw.trim()) return null;

  let text = raw.trim();

  // Strip markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Try direct parse, then extract first JSON object
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch {
        // Clean trailing commas and retry
        try {
          parsed = JSON.parse(objMatch[0].replace(/,\s*([\]}])/g, "$1"));
        } catch {
          return null;
        }
      }
    }
  }

  if (!parsed) return null;

  // Validate and clamp
  const clamp = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50; // default uncertainty
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  const dims = parsed.dimensions;
  if (!dims || typeof dims !== "object") return null;

  return {
    overallRisk: clamp(parsed.overallRisk),
    dimensions: {
      technicalVulnerabilities: clamp(dims.technicalVulnerabilities),
      designAndLogicFlaws: clamp(dims.designAndLogicFlaws),
      externalDependencies: clamp(dims.externalDependencies),
      operationalRisks: clamp(dims.operationalRisks),
      marketGovernanceRisks: clamp(dims.marketGovernanceRisks),
    },
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    topRiskFactors: Array.isArray(parsed.topRiskFactors)
      ? parsed.topRiskFactors.filter((f: unknown) => typeof f === "string").slice(0, 3)
      : [],
  };
}
```

---

## 6. 0g Inference Client (Risk)

### 6.1 New File: `agents/scanner/risk-inference.ts`

This module reuses the existing 0g broker infrastructure from `agents/llm-contextual/zg-client.ts` but is purpose-built for the scanner's risk assessment calls. It does **not** share broker state with the LLM-contextual agent (they run in separate processes).

```typescript
import { ethers } from "ethers";
import type { RiskPromptContext, LLMRiskResponse } from "./risk-prompt.js";
import { buildRiskMessages, parseRiskResponse } from "./risk-prompt.js";

// ── Types ──

export interface RiskInferenceResult {
  risk: LLMRiskResponse;
  source: "0g" | "claude";
  model: string;
  latencyMs: number;
}

// ── 0g Broker (scanner-local instance) ──

let broker: any = null;
let brokerReady = false;
let zgHealthy = true;
let healthCheckTimer: NodeJS.Timeout | null = null;

function getZgPrivateKey(): string {
  return (process.env.ZG_PRIVATE_KEY ?? "").trim();
}

function getZgProviderAddress(): string {
  return (process.env.ZG_PROVIDER_ADDRESS ?? "").trim();
}

function getZgRpcUrl(): string {
  return (process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai").trim();
}

function getZgModel(): string {
  return (process.env.ZG_MODEL ?? "qwen-2.5-7b-instruct").trim();
}

function getZgTimeoutMs(): number {
  return Number(process.env.ZG_RISK_TIMEOUT_MS ?? 30_000);
}

async function initZgBroker(): Promise<void> {
  if (broker) return;

  const privateKey = getZgPrivateKey();
  const rpcUrl = getZgRpcUrl();
  if (!privateKey || !getZgProviderAddress()) {
    zgHealthy = false;
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
      provider
    );
    const { createZGComputeNetworkBroker } = await import(
      "@0glabs/0g-serving-broker"
    );
    broker = await createZGComputeNetworkBroker(wallet);

    // Fund ledger if needed
    try {
      const ledger = await broker.ledger.getLedger();
      if (BigInt(ledger?.availableBalance ?? 0n) <= 0n) {
        await broker.ledger.depositFund(5);
      }
    } catch {
      await broker.ledger.depositFund(5);
    }

    // Acknowledge provider
    await broker.inference.acknowledgeProviderSigner(getZgProviderAddress());
    brokerReady = true;
    zgHealthy = true;
  } catch {
    zgHealthy = false;
  }
}

async function callZgInference(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  if (!broker || !brokerReady) throw new Error("0g broker not ready");

  const providerAddress = getZgProviderAddress();
  const { endpoint, model: metaModel } =
    await broker.inference.getServiceMetadata(providerAddress);

  const model = getZgModel() || metaModel;
  const content = messages.map((m) => m.content).join("\n");
  const headers = await broker.inference.getRequestHeaders(
    providerAddress,
    content
  );

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getZgTimeoutMs());

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`0g returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const responseContent = data?.choices?.[0]?.message?.content;
    if (!responseContent) throw new Error("0g returned empty content");

    // Process billing
    const chatId =
      res.headers.get("ZG-Res-Key") || res.headers.get("zg-res-key");
    if (data.usage) {
      await broker.inference
        .processResponse(providerAddress, chatId, JSON.stringify(data.usage))
        .catch(() => {});
    }

    return responseContent;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Claude API Fallback ──

async function callClaudeInference(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsgs = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ role: "user" as const, content: m.content }));

  const response = await client.messages.create({
    model: process.env.CLAUDE_RISK_MODEL ?? "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemMsg,
    messages: userMsgs,
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text;
}

// ── Health Check Loop ──

/**
 * Starts a background loop that checks 0g availability every 30 seconds
 * when the service is currently marked as unhealthy. Automatically
 * switches back to 0g when connectivity is restored.
 */
export function startZgHealthCheckLoop(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  if (healthCheckTimer) return;

  const HEALTH_CHECK_INTERVAL_MS = Number(
    process.env.ZG_HEALTH_CHECK_INTERVAL_MS ?? 30_000
  );

  healthCheckTimer = setInterval(async () => {
    if (zgHealthy) return; // Already healthy, skip

    log.info("0g health check: attempting reconnection...");

    try {
      // Re-initialize broker from scratch
      broker = null;
      brokerReady = false;
      await initZgBroker();

      if (!brokerReady) {
        log.warn("0g health check: broker init failed, staying on Claude fallback");
        return;
      }

      // Probe with a minimal request
      const providerAddress = getZgProviderAddress();
      const { endpoint, model } =
        await broker.inference.getServiceMetadata(providerAddress);
      const headers = await broker.inference.getRequestHeaders(
        providerAddress,
        "health-check"
      );

      const url = endpoint.replace(/\/$/, "") + "/chat/completions";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "health-check" }],
            temperature: 0,
            max_tokens: 16,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          zgHealthy = true;
          log.info("0g health check: connection restored, switching back to 0g inference");
        } else {
          log.warn(`0g health check: provider returned ${res.status}, staying on Claude`);
        }
      } catch {
        clearTimeout(timeout);
        log.warn("0g health check: probe failed, staying on Claude fallback");
      }
    } catch (err) {
      log.warn(`0g health check: reconnection failed: ${err}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

export function stopZgHealthCheckLoop(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ── Public API ──

/**
 * Performs risk assessment inference. Uses 0g as primary, Claude as fallback.
 * Automatically marks 0g as unhealthy on failure and uses Claude until
 * the health check loop restores 0g connectivity.
 */
export async function assessRisk(
  ctx: RiskPromptContext,
  log: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<RiskInferenceResult> {
  const messages = buildRiskMessages(ctx);
  const start = Date.now();

  // Attempt 0g first (if healthy)
  if (zgHealthy) {
    try {
      await initZgBroker();

      if (brokerReady) {
        const raw = await callZgInference(messages);
        const risk = parseRiskResponse(raw);

        if (risk) {
          return {
            risk,
            source: "0g",
            model: getZgModel(),
            latencyMs: Date.now() - start,
          };
        }
        log.warn("0g inference returned unparseable risk response, falling back to Claude");
      }
    } catch (err) {
      zgHealthy = false;
      log.warn(`0g inference failed, switching to Claude fallback: ${err}`);
    }
  }

  // Claude fallback
  try {
    const raw = await callClaudeInference(messages);
    const risk = parseRiskResponse(raw);

    if (!risk) {
      throw new Error("Claude returned unparseable risk response");
    }

    return {
      risk,
      source: "claude",
      model: process.env.CLAUDE_RISK_MODEL ?? "claude-sonnet-4-20250514",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    throw new Error(`Both 0g and Claude inference failed. Claude error: ${err}`);
  }
}

/** Returns the current inference source being used. */
export function getCurrentInferenceSource(): "0g" | "claude" {
  return zgHealthy ? "0g" : "claude";
}

/** Reset state (for tests). */
export function _resetRiskInference(): void {
  broker = null;
  brokerReady = false;
  zgHealthy = true;
  stopZgHealthCheckLoop();
}
```

---

## 7. Claude API Fallback with Health-Check Loop

Already implemented in Section 6. Summary of the failover behavior:

### 7.1 State Machine

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   START ──► 0g HEALTHY                               │
│                │                                     │
│                │ inference call fails                 │
│                ▼                                     │
│           0g UNHEALTHY ──► use Claude fallback       │
│                │                                     │
│                │ health check every 30s              │
│                │                                     │
│                ├──► probe fails ──► stay on Claude   │
│                │                                     │
│                └──► probe succeeds ──► 0g HEALTHY    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 7.2 Key Behaviors

1. **On startup**: Attempt 0g initialization. If it fails, immediately fall back to Claude. The health check loop starts regardless.
2. **On inference failure**: Mark `zgHealthy = false`. All subsequent calls route to Claude until the health check restores 0g.
3. **Health check probe**: Every 30 seconds (configurable via `ZG_HEALTH_CHECK_INTERVAL_MS`), re-initializes the broker and sends a minimal inference request. If the probe succeeds, `zgHealthy = true` and the next real inference call goes to 0g.
4. **Claude failure**: If both 0g AND Claude fail, the `assessRisk` function throws. The scanner should catch this and fall back to heuristic-only scoring (Section 8).

---

## 8. Weighted Risk Blend Formula

### 8.1 New File: `agents/scanner/risk-blender.ts`

Combines the LLM risk score with heuristic signals using configurable weights.

```typescript
import type { LLMRiskResponse } from "./risk-prompt.js";
import type { DefiCategory } from "./contract-classifier.js";

// ── Configurable Weights (env vars) ──

interface BlendWeights {
  llm: number;
  bytecodeComplexity: number;
  contractTypeRisk: number;
  proxyRisk: number;
  codeSize: number;
}

function getWeights(): BlendWeights {
  return {
    llm: Number(process.env.RISK_WEIGHT_LLM ?? 0.55),
    bytecodeComplexity: Number(process.env.RISK_WEIGHT_BYTECODE ?? 0.15),
    contractTypeRisk: Number(process.env.RISK_WEIGHT_TYPE ?? 0.12),
    proxyRisk: Number(process.env.RISK_WEIGHT_PROXY ?? 0.08),
    codeSize: Number(process.env.RISK_WEIGHT_SIZE ?? 0.10),
  };
}

// ── DeFi Category Inherent Risk Multipliers ──
// These represent the base risk profile of each DeFi category.

const CATEGORY_RISK_BASE: Record<DefiCategory, number> = {
  bridge: 78,   // highest: cross-chain risks, message verification
  lending: 68,  // high: oracle manipulation, liquidation logic
  dex: 58,      // medium-high: sandwich attacks, impermanent loss
  staking: 42,  // medium: lockup logic, reward calculation
  vault: 48,    // medium: deposit/withdraw logic, share accounting
};

// ── Heuristic Scoring Functions ──

/**
 * Bytecode complexity heuristic.
 * Longer bytecode → more code paths → higher risk surface.
 * Also penalizes very short bytecode (possible proxy-only shells).
 */
function scoreBytecodeComplexity(bytecodeHex: string): number {
  const byteLength = bytecodeHex.startsWith("0x")
    ? (bytecodeHex.length - 2) / 2
    : bytecodeHex.length / 2;

  if (byteLength < 200) return 35;       // very small — likely proxy or minimal
  if (byteLength < 1_000) return 30;     // small contract
  if (byteLength < 5_000) return 45;     // moderate
  if (byteLength < 15_000) return 60;    // large, complex
  if (byteLength < 30_000) return 75;    // very large
  return 85;                              // massive — high attack surface
}

/**
 * Code size risk score.
 * More LOC = more potential for bugs.
 */
function scoreCodeSize(estimatedLOC: number): number {
  if (estimatedLOC < 200) return 25;
  if (estimatedLOC < 500) return 35;
  if (estimatedLOC < 1_500) return 50;
  if (estimatedLOC < 5_000) return 65;
  if (estimatedLOC < 10_000) return 78;
  return 88;
}

/**
 * Proxy risk score.
 * Proxy contracts have inherent upgradeability risks.
 */
function scoreProxyRisk(isProxy: boolean, standards: string[]): number {
  if (!isProxy) return 10; // non-proxy: minimal upgradeability risk

  // Different proxy standards have different risk profiles
  if (standards.includes("ERC1967")) return 55;  // transparent/UUPS — standard
  if (standards.includes("ERC1167")) return 35;  // minimal clone — lower risk
  if (standards.includes("ERC2535")) return 70;  // diamond — complex
  if (standards.includes("ERC897")) return 60;   // older delegate proxy
  return 50; // unknown proxy type
}

// ── Public API ──

export interface BlendedRiskResult {
  /** Final blended risk score (0-100) */
  finalScore: number;
  /** Individual component scores */
  components: {
    llmScore: number | null;
    bytecodeComplexity: number;
    contractTypeRisk: number;
    proxyRisk: number;
    codeSizeRisk: number;
  };
  /** Weights used in the blend */
  weights: BlendWeights;
  /** LLM's detailed dimension breakdown (if available) */
  dimensions: LLMRiskResponse["dimensions"] | null;
  /** LLM's rationale (if available) */
  rationale: string;
  /** LLM's top risk factors (if available) */
  topRiskFactors: string[];
}

/**
 * Blends the LLM risk assessment with heuristic signals.
 *
 * If llmRisk is null (both inference providers failed), uses heuristic-only
 * scoring with the LLM weight redistributed proportionally across heuristics.
 */
export function blendRiskScore(params: {
  llmRisk: LLMRiskResponse | null;
  defiCategory: DefiCategory;
  bytecodeHex: string;
  estimatedLOC: number;
  isProxy: boolean;
  standards: string[];
}): BlendedRiskResult {
  const weights = getWeights();
  const {
    llmRisk,
    defiCategory,
    bytecodeHex,
    estimatedLOC,
    isProxy,
    standards,
  } = params;

  const bytecodeScore = scoreBytecodeComplexity(bytecodeHex);
  const typeScore = CATEGORY_RISK_BASE[defiCategory];
  const proxyScore = scoreProxyRisk(isProxy, standards);
  const sizeScore = scoreCodeSize(estimatedLOC);

  let finalScore: number;

  if (llmRisk) {
    // Full blend: LLM + heuristics
    finalScore =
      weights.llm * llmRisk.overallRisk +
      weights.bytecodeComplexity * bytecodeScore +
      weights.contractTypeRisk * typeScore +
      weights.proxyRisk * proxyScore +
      weights.codeSize * sizeScore;
  } else {
    // Heuristic-only: redistribute LLM weight proportionally
    const heuristicTotal =
      weights.bytecodeComplexity +
      weights.contractTypeRisk +
      weights.proxyRisk +
      weights.codeSize;
    const scale = 1 / heuristicTotal; // normalize to 1.0

    finalScore =
      (weights.bytecodeComplexity * scale) * bytecodeScore +
      (weights.contractTypeRisk * scale) * typeScore +
      (weights.proxyRisk * scale) * proxyScore +
      (weights.codeSize * scale) * sizeScore;
  }

  // Clamp to 0-100
  finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

  return {
    finalScore,
    components: {
      llmScore: llmRisk?.overallRisk ?? null,
      bytecodeComplexity: bytecodeScore,
      contractTypeRisk: typeScore,
      proxyRisk: proxyScore,
      codeSizeRisk: sizeScore,
    },
    weights,
    dimensions: llmRisk?.dimensions ?? null,
    rationale: llmRisk?.rationale ?? "Heuristic-only scoring (LLM unavailable)",
    topRiskFactors: llmRisk?.topRiskFactors ?? [],
  };
}
```

### 8.2 Default Weight Distribution

| Component | Weight | Rationale |
|---|---|---|
| LLM Risk Score | 0.55 (55%) | Primary signal — multi-dimensional analysis |
| Bytecode Complexity | 0.15 (15%) | Attack surface indicator |
| Contract Type Risk | 0.12 (12%) | Category-inherent risk profile |
| Code Size | 0.10 (10%) | Bug density correlation |
| Proxy Risk | 0.08 (8%) | Upgradeability/storage collision risk |

All weights are configurable via `RISK_WEIGHT_*` environment variables. They are **not required** to sum to 1.0 — the formula uses them as raw multipliers. However, keeping them normalized to 1.0 ensures the output stays in the 0-100 range.

---

## 9. Scanner Integration

### 9.1 Modifications to `agents/scanner/index.ts`

The following changes integrate classification and risk assessment into the scanner's discovery pipeline.

#### 9.1.1 New Imports

```typescript
import { classifyContract } from "./contract-classifier.js";
import type { DefiCategory, ClassificationResult } from "./contract-classifier.js";
import { retrieveContractSource } from "./source-retriever.js";
import { assessRisk, startZgHealthCheckLoop, getCurrentInferenceSource } from "./risk-inference.js";
import { blendRiskScore } from "./risk-blender.js";
import type { RiskPromptContext } from "./risk-prompt.js";
```

#### 9.1.2 Replace `inferContractType` Function

Remove the existing stub:

```typescript
// REMOVE THIS:
function inferContractType(c: MirrorContract): ContractType {
  void c;
  return "unknown";
}
```

#### 9.1.3 Replace `deriveRiskScore` Function

Remove the existing hash-based derivation:

```typescript
// REMOVE THIS:
function deriveRiskScore(contractAddress: string): number {
  const digest = ethers.keccak256(ethers.toUtf8Bytes(contractAddress.toLowerCase()));
  const seed = Number.parseInt(digest.slice(2, 4), 16);
  return 20 + (seed % 76);
}
```

#### 9.1.4 New Classification + Risk Function

Add this function to replace both removed functions:

```typescript
/**
 * Performs synchronous classification and risk assessment for a discovered contract.
 * This blocks the scan cycle until both operations complete.
 *
 * Flow:
 * 1. evmdecoder → contract type + DeFi category
 * 2. Source retrieval (Sourcify → bytecode fallback)
 * 3. 0g inference → risk assessment (Claude fallback)
 * 4. Weighted blend → final risk score
 */
async function classifyAndAssessRisk(contractAddress: string): Promise<{
  defiCategory: DefiCategory;
  riskScore: number;
  classification: ClassificationResult;
  riskDetails: {
    source: "0g" | "claude" | "heuristic";
    model: string;
    latencyMs: number;
    dimensions: Record<string, number> | null;
    rationale: string;
    topRiskFactors: string[];
    components: Record<string, number | null>;
  };
}> {
  // 1. Classification via evmdecoder
  let classification: ClassificationResult;
  try {
    classification = await classifyContract(contractAddress);
  } catch (err) {
    log.warn(`evmdecoder classification failed for ${contractAddress}: ${err}`);
    classification = {
      evmType: "unknown",
      defiCategory: "lending", // default
      standards: [],
      isContract: true,
      contractName: null,
      proxyTarget: null,
    };
  }

  // 2. Source retrieval
  const rpcUrl =
    process.env.SCANNER_EVM_RPC_URL ||
    process.env.HEDERA_JSON_RPC_URL ||
    "https://testnet.hashio.io/api";

  let sourceResult;
  try {
    sourceResult = await retrieveContractSource(contractAddress, rpcUrl);
  } catch (err) {
    log.warn(`Source retrieval failed for ${contractAddress}: ${err}`);
    sourceResult = {
      hasSource: false,
      sourceCode: null,
      sourceOrigin: "bytecode_only" as const,
      bytecode: "0x",
    };
  }

  const estimatedLOC = estimateLoc({
    bytecode: sourceResult.bytecode,
  } as MirrorContract);

  // 3. Risk assessment via LLM
  const riskCtx: RiskPromptContext = {
    contractAddress,
    defiCategory: classification.defiCategory,
    evmType: classification.evmType,
    standards: classification.standards,
    estimatedLOC,
    hasSource: sourceResult.hasSource,
    sourceCode: sourceResult.sourceCode,
    bytecode: sourceResult.bytecode,
    proxyTarget: classification.proxyTarget,
  };

  let llmRisk = null;
  let inferenceSource: "0g" | "claude" | "heuristic" = "heuristic";
  let inferenceModel = "none";
  let inferenceLatency = 0;

  try {
    const result = await assessRisk(riskCtx, log);
    llmRisk = result.risk;
    inferenceSource = result.source;
    inferenceModel = result.model;
    inferenceLatency = result.latencyMs;
  } catch (err) {
    log.warn(
      `All inference providers failed for ${contractAddress}: ${err}. ` +
      "Using heuristic-only risk scoring."
    );
  }

  // 4. Weighted blend
  const blended = blendRiskScore({
    llmRisk,
    defiCategory: classification.defiCategory,
    bytecodeHex: sourceResult.bytecode,
    estimatedLOC,
    isProxy: classification.proxyTarget !== null,
    standards: classification.standards,
  });

  return {
    defiCategory: classification.defiCategory,
    riskScore: blended.finalScore,
    classification,
    riskDetails: {
      source: inferenceSource,
      model: inferenceModel,
      latencyMs: inferenceLatency,
      dimensions: blended.dimensions,
      rationale: blended.rationale,
      topRiskFactors: blended.topRiskFactors,
      components: blended.components,
    },
  };
}
```

#### 9.1.5 Update `createDiscoveryFromMirror`

Replace the existing function to use the new classification pipeline:

```typescript
async function createDiscoveryFromMirror(contract: MirrorContract) {
  const contractAddress = (contract.evm_address || "").toLowerCase();
  const createdTs = extractCreatedTimestamp(contract) || String(Date.now());
  const txHash =
    contract.transaction_hash ||
    hashOf({
      contractAddress,
      createdTs,
      source: "hedera-mirror",
    });

  // ── Synchronous classification + risk assessment ──
  const {
    defiCategory,
    riskScore,
    classification,
    riskDetails,
  } = await classifyAndAssessRisk(contractAddress);

  log.info(
    `Classified ${contractAddress.slice(0, 12)}... ` +
    `evm=${classification.evmType} defi=${defiCategory} ` +
    `risk=${riskScore} via=${riskDetails.source} ` +
    `(${riskDetails.latencyMs}ms)`
  );

  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress,
      chain: "hedera-testnet",
      deployerAddress: ZERO_ADDRESS,
      estimatedLOC: estimateLoc(contract),
      contractType: defiCategory,
      riskScore,
      budget: DEFAULT_DISCOVERY_BUDGET_GUARD,
      txHash,
      // ── New enrichment fields ──
      evmType: classification.evmType,
      standards: classification.standards,
      contractName: classification.contractName,
      isProxy: classification.proxyTarget !== null,
      proxyTarget: classification.proxyTarget,
      riskSource: riskDetails.source,
      riskModel: riskDetails.model,
      riskDimensions: riskDetails.dimensions,
      riskRationale: riskDetails.rationale,
      topRiskFactors: riskDetails.topRiskFactors,
    },
  };
}
```

**IMPORTANT**: The function signature changes from synchronous to `async`. Update the call site in the scan cycle:

```typescript
// In the scanCycle function, change:
// const discovery = createDiscoveryFromMirror(c);
// To:
const discovery = await createDiscoveryFromMirror(c);
```

#### 9.1.6 Start Health Check Loop

In the `main()` function, after wallet initialization and before the first scan cycle:

```typescript
async function main() {
  log.info("Scanner Agent starting...");
  // ... existing setup ...

  // Start 0g health check loop (runs every 30s when 0g is unhealthy)
  startZgHealthCheckLoop(log);
  log.info(`Inference source: ${getCurrentInferenceSource()}`);

  // ... rest of main() ...
}
```

---

## 10. Type Updates

### 10.1 Update `agents/shared/types.ts`

The `ContractType` type must be updated to reflect the new DeFi categories. Remove `"unknown"` since the classifier always resolves to a concrete category (default: `"lending"`).

```typescript
// CHANGE FROM:
export type ContractType = "lending" | "dex" | "staking" | "bridge" | "vault" | "unknown";

// CHANGE TO:
export type ContractType = "lending" | "dex" | "staking" | "bridge" | "vault";
```

### 10.2 Update `ContractDiscoveryEvent` Payload

Extend the discovery event payload with the new enrichment fields:

```typescript
export interface ContractDiscoveryEvent extends HCSMessage {
  type: "CONTRACT_DISCOVERED";
  payload: {
    contractAddress: string;
    chain: string;
    deployerAddress: string;
    estimatedLOC: number;
    contractType: ContractType;
    riskScore: number;
    budget: number;
    txHash: string;
    sourceRef?: string;
    // ── New fields ──
    evmType?: string;
    standards?: string[];
    contractName?: string | null;
    isProxy?: boolean;
    proxyTarget?: string | null;
    riskSource?: "0g" | "claude" | "heuristic";
    riskModel?: string;
    riskDimensions?: Record<string, number> | null;
    riskRationale?: string;
    topRiskFactors?: string[];
  };
}
```

### 10.3 Impact on Downstream Consumers

The following files reference `ContractType` and may need `"unknown"` handling removed:

- `agents/static-analysis/index.ts` — specializations array
- `agents/llm-contextual/index.ts` — specializations and bid logic
- `agents/fuzzer/index.ts` — specializations
- `agents/llm-contextual/prompt-builder.ts` — `AuditContext.contractType`
- `agents/llm-contextual/response-parser.ts` — `_contractType` parameter
- `packages/dashboard/src/` — display components

Each of these files must be audited. Remove any `"unknown"` case handling and ensure the 5 DeFi categories are handled. Since `"unknown"` was previously the default, any `=== "unknown"` checks should be removed or replaced with the appropriate category logic.

---

## 11. Error Handling

### 11.1 Failure Modes and Recovery

| Failure | Recovery | Impact on Discovery |
|---|---|---|
| evmdecoder `contractInfo()` throws | Default to `{ evmType: "unknown", defiCategory: "lending" }` | Classification defaults to lending |
| evmdecoder `initialize()` throws | Log error, use defaults for all contracts this cycle | All classifications default to lending |
| Sourcify fetch fails/times out | Use bytecode-only mode for LLM prompt | Lower confidence risk scores |
| RPC `eth_getCode` fails | Empty bytecode, heuristic scoring only | Risk score based on type + size only |
| 0g inference fails | Switch to Claude API, start health check | Seamless, slightly higher cost |
| Claude API fails | Use heuristic-only scoring (no LLM) | Lower accuracy, wider score range |
| 0g + Claude both fail | Heuristic-only blend (redistributed weights) | Reduced accuracy but non-blocking |
| Risk response unparseable | Retry once, then fall back to next provider | Minor latency increase |

### 11.2 Critical Constraint

**The scanner MUST NOT crash or skip publishing a discovery because of classifier/risk failures.** Every failure mode above degrades gracefully to a less accurate but still valid discovery event. The `classifyAndAssessRisk` function is wrapped in a try/catch at the call site level (Section 9.1.5), and individual sub-operations have their own error boundaries.

---

## 12. Environment Variables

### 12.1 New Variables

| Variable | Default | Description |
|---|---|---|
| `SCANNER_EVM_RPC_URL` | `https://testnet.hashio.io/api` | JSON-RPC endpoint for evmdecoder |
| `ANTHROPIC_API_KEY` | (none, required for fallback) | Claude API key for LLM fallback |
| `CLAUDE_RISK_MODEL` | `claude-sonnet-4-20250514` | Claude model for risk assessment |
| `ZG_RISK_TIMEOUT_MS` | `30000` | 0g inference timeout for risk calls |
| `ZG_HEALTH_CHECK_INTERVAL_MS` | `30000` | 0g health check poll interval |
| `RISK_WEIGHT_LLM` | `0.55` | Weight for LLM risk score in blend |
| `RISK_WEIGHT_BYTECODE` | `0.15` | Weight for bytecode complexity |
| `RISK_WEIGHT_TYPE` | `0.12` | Weight for contract type risk |
| `RISK_WEIGHT_PROXY` | `0.08` | Weight for proxy risk |
| `RISK_WEIGHT_SIZE` | `0.10` | Weight for code size risk |

### 12.2 Existing Variables (Unchanged)

| Variable | Usage |
|---|---|
| `ZG_PRIVATE_KEY` | 0g Compute Network wallet key |
| `ZG_PROVIDER_ADDRESS` | 0g inference provider address |
| `ZG_RPC_URL` | 0g chain RPC (for broker, not evmdecoder) |
| `ZG_MODEL` | 0g inference model name |

---

## 13. Testing Strategy

### 13.1 Unit Tests

#### `contract-classifier.test.ts`

```typescript
import { classifyContract, _resetDecoder } from "./contract-classifier";

// Mock evmdecoder
jest.mock("evmdecoder", () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    contractInfo: jest.fn().mockImplementation(({ address }) => {
      // Return different types based on address for testing
      if (address.endsWith("1111")) {
        return {
          isContract: true,
          contractType: { name: "Token", standards: ["ERC20", "ERC3156"] },
          contractName: "FlashLender",
        };
      }
      if (address.endsWith("2222")) {
        return {
          isContract: true,
          contractType: { name: "NFT", standards: ["ERC721"] },
          contractName: "VaultNFT",
        };
      }
      return {
        isContract: true,
        contractType: { name: "unknown", standards: [] },
        contractName: null,
      };
    }),
  }));
});

afterEach(() => _resetDecoder());

test("ERC20 + ERC3156 maps to lending", async () => {
  const result = await classifyContract("0x" + "1111".padStart(40, "0"));
  expect(result.defiCategory).toBe("lending");
});

test("ERC721 maps to vault", async () => {
  const result = await classifyContract("0x" + "2222".padStart(40, "0"));
  expect(result.defiCategory).toBe("vault");
});

test("unknown type defaults to lending", async () => {
  const result = await classifyContract("0x" + "9999".padStart(40, "0"));
  expect(result.defiCategory).toBe("lending");
});
```

#### `risk-prompt.test.ts`

```typescript
import { parseRiskResponse } from "./risk-prompt";

test("parses valid risk response", () => {
  const raw = JSON.stringify({
    overallRisk: 65,
    dimensions: {
      technicalVulnerabilities: 70,
      designAndLogicFlaws: 55,
      externalDependencies: 80,
      operationalRisks: 45,
      marketGovernanceRisks: 60,
    },
    rationale: "High oracle dependency with moderate access controls.",
    topRiskFactors: [
      "Chainlink oracle single point of failure",
      "No timelock on admin functions",
      "Unbounded loop in liquidation",
    ],
  });
  const result = parseRiskResponse(raw);
  expect(result).not.toBeNull();
  expect(result!.overallRisk).toBe(65);
  expect(result!.dimensions.externalDependencies).toBe(80);
  expect(result!.topRiskFactors).toHaveLength(3);
});

test("clamps out-of-range scores", () => {
  const raw = JSON.stringify({
    overallRisk: 150,
    dimensions: {
      technicalVulnerabilities: -10,
      designAndLogicFlaws: 200,
      externalDependencies: 50,
      operationalRisks: 50,
      marketGovernanceRisks: 50,
    },
    rationale: "Test",
    topRiskFactors: [],
  });
  const result = parseRiskResponse(raw);
  expect(result!.overallRisk).toBe(100);
  expect(result!.dimensions.technicalVulnerabilities).toBe(0);
  expect(result!.dimensions.designAndLogicFlaws).toBe(100);
});

test("returns null for invalid JSON", () => {
  expect(parseRiskResponse("not json")).toBeNull();
});
```

#### `risk-blender.test.ts`

```typescript
import { blendRiskScore } from "./risk-blender";

test("blends LLM score with heuristics", () => {
  const result = blendRiskScore({
    llmRisk: {
      overallRisk: 70,
      dimensions: {
        technicalVulnerabilities: 80,
        designAndLogicFlaws: 60,
        externalDependencies: 75,
        operationalRisks: 50,
        marketGovernanceRisks: 65,
      },
      rationale: "Test",
      topRiskFactors: ["a", "b", "c"],
    },
    defiCategory: "lending",
    bytecodeHex: "0x" + "ff".repeat(5000), // ~5000 bytes
    estimatedLOC: 2000,
    isProxy: false,
    standards: [],
  });

  expect(result.finalScore).toBeGreaterThanOrEqual(0);
  expect(result.finalScore).toBeLessThanOrEqual(100);
  expect(result.components.llmScore).toBe(70);
});

test("heuristic-only when LLM is null", () => {
  const result = blendRiskScore({
    llmRisk: null,
    defiCategory: "bridge",
    bytecodeHex: "0x" + "ff".repeat(20000),
    estimatedLOC: 8000,
    isProxy: true,
    standards: ["ERC1967"],
  });

  expect(result.components.llmScore).toBeNull();
  expect(result.finalScore).toBeGreaterThan(50); // bridge + large + proxy
  expect(result.rationale).toContain("Heuristic-only");
});
```

### 13.2 Integration Tests

Integration tests should run against a local or testnet Hedera JSON-RPC relay:

1. **evmdecoder against known contracts**: Call `classifyContract` with known Hedera testnet contract addresses (e.g., USDC, an NFT collection) and assert correct EVM type detection.
2. **Full pipeline mock**: Mock the 0g broker and Claude client, run `classifyAndAssessRisk` with a real contract address, verify the blended score is in range and the discovery event payload is well-formed.
3. **Failover test**: Mock 0g to throw, verify Claude is called. Mock both to throw, verify heuristic-only scoring produces a valid score.
4. **Health check loop test**: Mark 0g unhealthy, verify Claude is used, then restore 0g mock, advance timer by 30s, verify next call uses 0g.

### 13.3 Build Verification

After implementation, run:

```bash
cd agents && npx tsc --noEmit   # type check
npm test                         # unit tests
```

Ensure no build errors are introduced by the `ContractType` change (removing `"unknown"`).

---

## File Manifest

| New File | Purpose |
|---|---|
| `agents/scanner/contract-classifier.ts` | evmdecoder integration + DeFi category mapping |
| `agents/scanner/source-retriever.ts` | Sourcify + bytecode source retrieval |
| `agents/scanner/risk-prompt.ts` | LLM prompt construction + response parsing |
| `agents/scanner/risk-inference.ts` | 0g + Claude inference client with health check |
| `agents/scanner/risk-blender.ts` | Weighted risk score blending |

| Modified File | Changes |
|---|---|
| `agents/scanner/index.ts` | New imports, replace `inferContractType`/`deriveRiskScore`, async `createDiscoveryFromMirror`, health check startup |
| `agents/shared/types.ts` | Remove `"unknown"` from `ContractType`, extend discovery event payload |
| `package.json` | Add `evmdecoder`, `@anthropic-ai/sdk` dependencies |

Sources:
- [evmdecoder npm](https://www.npmjs.com/package/evmdecoder)
- [evmdecoder GitHub](https://github.com/j4ys0n/evmdecoder)
- [0G Inference SDK Docs](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference)
- [0G Compute Network Overview](https://docs.0g.ai/build-with-0g/compute-network/overview)
