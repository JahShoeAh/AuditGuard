import type { LLMRiskResponse } from "./risk-prompt.js";
import type { DefiCategory } from "./contract-classifier.js";

export interface BlendWeights {
  llm: number;
  bytecodeComplexity: number;
  contractTypeRisk: number;
  proxyRisk: number;
  codeSize: number;
}

export function getWeights(): BlendWeights {
  return {
    llm: Number(process.env.RISK_WEIGHT_LLM ?? 0.55),
    bytecodeComplexity: Number(process.env.RISK_WEIGHT_BYTECODE ?? 0.15),
    contractTypeRisk: Number(process.env.RISK_WEIGHT_TYPE ?? 0.12),
    proxyRisk: Number(process.env.RISK_WEIGHT_PROXY ?? 0.08),
    codeSize: Number(process.env.RISK_WEIGHT_SIZE ?? 0.10),
  };
}

export const CATEGORY_RISK_BASE: Record<DefiCategory, number> = {
  bridge: 78,
  lending: 68,
  dex: 58,
  staking: 42,
  vault: 48,
};

export function scoreBytecodeComplexity(bytecodeHex: string): number {
  const byteLength = bytecodeHex.startsWith("0x")
    ? (bytecodeHex.length - 2) / 2
    : bytecodeHex.length / 2;

  if (byteLength < 200) return 35;
  if (byteLength < 1_000) return 30;
  if (byteLength < 5_000) return 45;
  if (byteLength < 15_000) return 60;
  if (byteLength < 30_000) return 75;
  return 85;
}

export function scoreCodeSize(estimatedLOC: number): number {
  if (estimatedLOC < 200) return 25;
  if (estimatedLOC < 500) return 35;
  if (estimatedLOC < 1_500) return 50;
  if (estimatedLOC < 5_000) return 65;
  if (estimatedLOC < 10_000) return 78;
  return 88;
}

export function scoreProxyRisk(isProxy: boolean, standards: string[]): number {
  if (!isProxy) return 10;

  if (standards.includes("ERC1967")) return 55;
  if (standards.includes("ERC1167")) return 35;
  if (standards.includes("ERC2535")) return 70;
  if (standards.includes("ERC897")) return 60;
  return 50;
}

export interface BlendedRiskResult {
  finalScore: number;
  components: {
    llmScore: number | null;
    bytecodeComplexity: number;
    contractTypeRisk: number;
    proxyRisk: number;
    codeSizeRisk: number;
  };
  weights: BlendWeights;
  dimensions: LLMRiskResponse["dimensions"] | null;
  rationale: string;
  topRiskFactors: string[];
}

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
    finalScore =
      weights.llm * llmRisk.overallRisk +
      weights.bytecodeComplexity * bytecodeScore +
      weights.contractTypeRisk * typeScore +
      weights.proxyRisk * proxyScore +
      weights.codeSize * sizeScore;
  } else {
    const heuristicTotal =
      weights.bytecodeComplexity +
      weights.contractTypeRisk +
      weights.proxyRisk +
      weights.codeSize;
    const scale = 1 / heuristicTotal;

    finalScore =
      (weights.bytecodeComplexity * scale) * bytecodeScore +
      (weights.contractTypeRisk * scale) * typeScore +
      (weights.proxyRisk * scale) * proxyScore +
      (weights.codeSize * scale) * sizeScore;
  }

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
