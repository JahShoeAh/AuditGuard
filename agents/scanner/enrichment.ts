import { ethers } from "ethers";
import type { ContractType } from "../shared/types.js";
import { inferBaselineContractType } from "./baseline-contract-type.js";

type DefiCategory = ContractType;
type RawDefiCategory = DefiCategory | "nft" | "unknown";

type ClassificationResult = {
  evmType: string;
  defiCategory: RawDefiCategory;
  standards: string[];
  isContract: boolean;
  contractName: string | null;
  proxyTarget: string | null;
};

type SourceRetrievalResult = {
  hasSource: boolean;
  sourceCode: string | null;
  sourceOrigin: "sourcify_full" | "sourcify_partial" | "bytecode_only";
  bytecode: string;
};

type LLMRiskResponse = {
  overallRisk: number;
  dimensions: Record<string, number>;
  rationale: string;
  topRiskFactors: string[];
};

type RiskPromptContext = {
  contractAddress: string;
  defiCategory: DefiCategory;
  evmType: string;
  standards: string[];
  estimatedLOC: number;
  hasSource: boolean;
  sourceCode: string | null;
  bytecode: string;
  proxyTarget: string | null;
};

type ClassifierModules = {
  classifyContract: (contractAddress: string) => Promise<ClassificationResult>;
  retrieveContractSource: (
    contractAddress: string,
    rpcUrl: string,
    knownBytecode?: string
  ) => Promise<SourceRetrievalResult>;
  assessRisk: (
    ctx: RiskPromptContext,
    logger: ScannerLogger
  ) => Promise<{
    risk: LLMRiskResponse;
    source: "0g" | "claude";
    model: string;
    latencyMs: number;
  }>;
  startZgHealthCheckLoop: (logger: ScannerLogger) => void;
  getCurrentInferenceSource: () => "0g" | "claude";
  getZgModel: () => string;
  getZgProviderAddress: () => string;
  blendRiskScore: (input: {
    llmRisk: LLMRiskResponse | null;
    defiCategory: DefiCategory;
    bytecodeHex: string;
    estimatedLOC: number;
    isProxy: boolean;
    standards: string[];
  }) => {
    finalScore: number;
    dimensions: Record<string, number> | null;
    rationale: string;
    topRiskFactors: string[];
    components: Record<string, number | null>;
  };
};

type MirrorContractLike = {
  bytecode?: string | null;
};

export type ScannerLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type DiscoveryEnrichment = {
  contractType: ContractType | "unknown";
  riskScore: number;
  estimatedLOC: number;
  enrichedPayload: Record<string, unknown> | null;
  mode: "classifier" | "baseline";
};

let classifierModulesLoadError: string | null = null;
let classifierModulesPromise: Promise<ClassifierModules> | null = null;

function inferContractType(contract: MirrorContractLike): ContractType {
  const inferred = inferBaselineContractType(contract);
  return inferred === "unknown" ? "vault" : inferred;
}

function normalizeDefiCategory(category: RawDefiCategory): DefiCategory {
  switch (category) {
    case "lending":
    case "dex":
    case "staking":
    case "bridge":
    case "vault":
      return category;
    case "nft":
    case "unknown":
    default:
      return "vault";
  }
}

function deriveRiskScore(contractAddress: string): number {
  const digest = ethers.keccak256(ethers.toUtf8Bytes(contractAddress.toLowerCase()));
  const seed = Number.parseInt(digest.slice(2, 4), 16);
  return 20 + (seed % 76); // 20..95
}

export function estimateLoc(contract: MirrorContractLike): number {
  const bytecode = typeof contract.bytecode === "string" ? contract.bytecode : "";
  if (bytecode.startsWith("0x") && bytecode.length > 2) {
    const byteLength = (bytecode.length - 2) / 2;
    return Math.max(200, Math.min(12_000, Math.round(byteLength * 1.6)));
  }
  return 1200;
}

function baselineClassification(contractAddress: string, contract: MirrorContractLike): DiscoveryEnrichment {
  const contractType = inferContractType(contract);
  return {
    contractType,
    riskScore: deriveRiskScore(contractAddress),
    estimatedLOC: estimateLoc(contract),
    enrichedPayload: null,
    mode: "baseline",
  };
}

async function loadClassifierModules(): Promise<ClassifierModules> {
  if (!classifierModulesPromise) {
    classifierModulesPromise = (async () => {
      const [
        classifierModule,
        sourceModule,
        riskInferenceModule,
        blenderModule,
      ] = await Promise.all([
        import("./contract-classifier.js"),
        import("./source-retriever.js"),
        import("./risk-inference.js"),
        import("./risk-blender.js"),
      ]);
      return {
        classifyContract: classifierModule.classifyContract as ClassifierModules["classifyContract"],
        retrieveContractSource: sourceModule.retrieveContractSource as ClassifierModules["retrieveContractSource"],
        assessRisk: riskInferenceModule.assessRisk as ClassifierModules["assessRisk"],
        startZgHealthCheckLoop:
          riskInferenceModule.startZgHealthCheckLoop as ClassifierModules["startZgHealthCheckLoop"],
        getCurrentInferenceSource:
          riskInferenceModule.getCurrentInferenceSource as ClassifierModules["getCurrentInferenceSource"],
        getZgModel: riskInferenceModule.getZgModel as ClassifierModules["getZgModel"],
        getZgProviderAddress:
          riskInferenceModule.getZgProviderAddress as ClassifierModules["getZgProviderAddress"],
        blendRiskScore: blenderModule.blendRiskScore as ClassifierModules["blendRiskScore"],
      };
    })().catch((err) => {
      classifierModulesPromise = null;
      throw err;
    });
  }
  return classifierModulesPromise;
}

async function classifyAndAssessRisk(
  contractAddress: string,
  contract: MirrorContractLike,
  logger: ScannerLogger
): Promise<DiscoveryEnrichment> {
  const modules = await loadClassifierModules();

  let classification: ClassificationResult;
  try {
    classification = await modules.classifyContract(contractAddress);
  } catch (err) {
    logger.warn(`classifier_pipeline_unavailable: evmdecoder classification failed for ${contractAddress}: ${err}`);
    classification = {
      evmType: "unknown",
      defiCategory: "vault",
      standards: [],
      isContract: true,
      contractName: null,
      proxyTarget: null,
    };
  }
  const normalizedCategory = normalizeDefiCategory(classification.defiCategory);

  const rpcUrl =
    process.env.SCANNER_EVM_RPC_URL ||
    process.env.HEDERA_JSON_RPC_URL ||
    "https://testnet.hashio.io/api";

  let sourceResult: SourceRetrievalResult = {
    hasSource: false,
    sourceCode: null,
    sourceOrigin: "bytecode_only",
    bytecode: "0x",
  };
  try {
    sourceResult = await modules.retrieveContractSource(
      contractAddress,
      rpcUrl,
      typeof contract.bytecode === "string" ? contract.bytecode : undefined
    );
  } catch (err) {
    logger.warn(`classifier_pipeline_unavailable: source retrieval failed for ${contractAddress}: ${err}`);
  }

  const estimatedLOC = estimateLoc({ bytecode: sourceResult.bytecode });
  const riskCtx: RiskPromptContext = {
    contractAddress,
    defiCategory: normalizedCategory,
    evmType: classification.evmType,
    standards: classification.standards,
    estimatedLOC,
    hasSource: sourceResult.hasSource,
    sourceCode: sourceResult.sourceCode,
    bytecode: sourceResult.bytecode,
    proxyTarget: classification.proxyTarget,
  };

  let llmRisk: LLMRiskResponse | null = null;
  let inferenceSource: "0g" | "claude" | "heuristic" = "heuristic";
  let inferenceModel = "none";
  let inferenceLatency = 0;
  try {
    const result = await modules.assessRisk(riskCtx, logger);
    llmRisk = result.risk;
    inferenceSource = result.source;
    inferenceModel = result.model;
    inferenceLatency = result.latencyMs;
  } catch (err) {
    logger.warn(`classifier_pipeline_unavailable: inference failed for ${contractAddress}: ${err}`);
  }

  const blended = modules.blendRiskScore({
    llmRisk,
    defiCategory: normalizedCategory,
    bytecodeHex: sourceResult.bytecode,
    estimatedLOC,
    isProxy: classification.proxyTarget !== null,
    standards: classification.standards,
  });

  return {
    contractType: normalizedCategory,
    riskScore: blended.finalScore,
    estimatedLOC,
    enrichedPayload: {
      evmType: classification.evmType,
      standards: classification.standards,
      contractName: classification.contractName,
      isProxy: classification.proxyTarget !== null,
      proxyTarget: classification.proxyTarget,
      riskSource: inferenceSource,
      riskModel: inferenceModel,
      riskDimensions: blended.dimensions,
      riskRationale: blended.rationale,
      topRiskFactors: blended.topRiskFactors,
      riskLatencyMs: inferenceLatency,
      riskComponents: blended.components,
      sourceOrigin: sourceResult.sourceOrigin,
    },
    mode: "classifier",
  };
}

export async function enrichContractDiscovery(
  contractAddress: string,
  contract: MirrorContractLike,
  classifierPipelineEnabled: boolean,
  logger: ScannerLogger
): Promise<DiscoveryEnrichment> {
  if (!classifierPipelineEnabled) {
    return baselineClassification(contractAddress, contract);
  }
  try {
    return await classifyAndAssessRisk(contractAddress, contract, logger);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (classifierModulesLoadError !== message) {
      classifierModulesLoadError = message;
      logger.warn(`classifier_pipeline_unavailable: ${message}. Falling back to baseline scanner classification.`);
    }
    return baselineClassification(contractAddress, contract);
  }
}

export function resolveScannerClassifierPipelineEnabled({
  strictLive,
  demoMode,
  testMode,
}: {
  strictLive: boolean;
  demoMode: boolean;
  testMode: boolean;
}): boolean {
  const defaultEnabled = strictLive && !demoMode && !testMode;
  const raw = process.env.SCANNER_CLASSIFIER_PIPELINE;
  if (raw == null || String(raw).trim() === "") return defaultEnabled;
  return String(raw).toLowerCase() !== "false";
}

export async function getClassifierRuntimeStatus(): Promise<{
  source: "0g" | "claude";
  model: string;
  providerAddress: string;
  startHealthLoop: (logger: ScannerLogger) => void;
}> {
  const modules = await loadClassifierModules();
  return {
    source: modules.getCurrentInferenceSource(),
    model: modules.getZgModel(),
    providerAddress: modules.getZgProviderAddress(),
    startHealthLoop: (logger: ScannerLogger) => modules.startZgHealthCheckLoop(logger),
  };
}
