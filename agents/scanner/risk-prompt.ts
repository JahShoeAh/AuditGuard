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
  overallRisk: number;
  dimensions: {
    technicalVulnerabilities: number;
    designAndLogicFlaws: number;
    externalDependencies: number;
    operationalRisks: number;
    marketGovernanceRisks: number;
  };
  rationale: string;
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
- If analyzing bytecode only (no source), increase uncertainty - bias scores toward the 40-70 range unless clear red/green flags are present.
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
    const maxSourceLength = 12_000;
    const truncatedSource =
      ctx.sourceCode.length > maxSourceLength
        ? ctx.sourceCode.slice(0, maxSourceLength) + "\n// ... [truncated]"
        : ctx.sourceCode;

    prompt += `\n\nVerified Solidity Source:\n\`\`\`solidity\n${truncatedSource}\n\`\`\``;
  } else if (ctx.bytecode && ctx.bytecode.length > 4) {
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

export function parseRiskResponse(raw: string): LLMRiskResponse | null {
  if (!raw || !raw.trim()) return null;

  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch {
        try {
          parsed = JSON.parse(objMatch[0].replace(/,\s*([\]}])/g, "$1"));
        } catch {
          return null;
        }
      }
    }
  }

  if (!parsed) return null;

  const clamp = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50;
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
