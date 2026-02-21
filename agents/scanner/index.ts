import {
  HCSClient,
  ContractClient,
  ListingCategory,
  normalizeBidFailureReasonCode,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomInt,
  randomChoice,
  randomHex,
  hashOf,
  sleep,
} from "../shared/index.js";
import type { ContractType } from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "scanner-001";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const TEST_MODE = process.env.TEST_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_SCAN_INTERVAL_DEMO_MS = 30_000;
const SCAN_INTERVAL_MS = DEMO_MODE
  ? parsePositiveIntEnv(process.env.SCANNER_SCAN_INTERVAL_DEMO_MS, DEFAULT_SCAN_INTERVAL_DEMO_MS)
  : parsePositiveIntEnv(process.env.SCANNER_SCAN_INTERVAL_MS, DEFAULT_SCAN_INTERVAL_MS);
const HOT_LEAD_RISK_THRESHOLD = 80;
const HOT_LEAD_PRICE = ethers.parseUnits("0.1", 8);   // 0.1 GUARD
const HOT_LEAD_DELAY_MS = DEMO_MODE ? 10 * 1000 : 60 * 1000; // delay before public
const DEFAULT_BUDGET_GUARD = Number(process.env.SCANNER_DISCOVERY_BUDGET_GUARD ?? "30");
const DEFAULT_DISCOVERY_BUDGET_GUARD = Number(process.env.DEFAULT_DISCOVERY_BUDGET_GUARD ?? "100");
const MIRROR_NODE = process.env.SCANNER_MIRROR_NODE || "https://testnet.mirrornode.hedera.com";
const SCANNER_AUTO_REGISTER_ONCHAIN = (process.env.SCANNER_AUTO_REGISTER_ONCHAIN ?? "true") !== "false";
const SCANNER_ASSOCIATE_REGISTRY_ON_BOOT =
  (process.env.SCANNER_ASSOCIATE_REGISTRY_ON_BOOT ?? "false") === "true";
const SCANNER_REGISTRATION_STAKE_GUARD = Number(process.env.SCANNER_REGISTRATION_STAKE_GUARD ?? "100");
const SCANNER_REGISTRATION_UCP_ENDPOINT =
  process.env.SCANNER_REGISTRATION_UCP_ENDPOINT?.trim() || `hcs://${CONFIG.hcsTopics.agentComms}`;
const CONTRACT_FETCH_LIMIT = Number(process.env.SCANNER_CONTRACT_FETCH_LIMIT ?? "25");
const SCANNER_MAX_DISCOVERIES_PER_CYCLE = Number(
  process.env.SCANNER_MAX_DISCOVERIES_PER_CYCLE ?? (DEMO_MODE ? "3" : "5")
);
const START_LOOKBACK_SECONDS = Number(
  process.env.SCANNER_START_LOOKBACK_SECONDS ?? (DEMO_MODE ? "900" : "3600")
);
const MIRROR_RETRY_ATTEMPTS = 4;
const MIRROR_RETRY_BASE_MS = 500;
const MIRROR_RETRY_MAX_MS = 6_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const GUARD_DECIMALS = 8;
const DEFAULT_COMMODITY_STAKE_GUARD = 100;
const DEFAULT_SCANNER_SPECIALIZATIONS = ["discovery", "triage", "hot-leads"];
const SCANNER_REGISTRATION_SPECIALIZATIONS = parseCsvList(
  process.env.SCANNER_REGISTRATION_SPECIALIZATIONS,
  DEFAULT_SCANNER_SPECIALIZATIONS
);
const SCANNER_CLASSIFIER_PIPELINE = resolveScannerClassifierPipelineEnabled({
  strictLive: STRICT_LIVE,
  demoMode: DEMO_MODE,
  testMode: TEST_MODE,
});

const log = createAgentLogger(AGENT_ID, "scanner");

type DefiCategory = Exclude<ContractType, "unknown">;

type ClassificationResult = {
  evmType: string;
  defiCategory: DefiCategory;
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
    rpcUrl: string
  ) => Promise<SourceRetrievalResult>;
  assessRisk: (
    ctx: RiskPromptContext,
    logger: { info: (msg: string) => void; warn: (msg: string) => void }
  ) => Promise<{
    risk: LLMRiskResponse;
    source: "0g" | "claude";
    model: string;
    latencyMs: number;
  }>;
  startZgHealthCheckLoop: (logger: { info: (msg: string) => void; warn: (msg: string) => void }) => void;
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

let classifierModulesLoadError: string | null = null;
let classifierModulesPromise: Promise<ClassifierModules> | null = null;

// ── Helper Functions ──

function parseCsvList(raw: string | undefined, fallback: string[]): string[] {
  const values = String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveScannerClassifierPipelineEnabled(opts: {
  strictLive: boolean;
  demoMode: boolean;
  testMode: boolean;
}) {
  const defaultEnabled = opts.strictLive && !opts.demoMode && !opts.testMode;
  const raw = process.env.SCANNER_CLASSIFIER_PIPELINE;
  if (raw == null || raw.trim() === "") return defaultEnabled;
  return String(raw).toLowerCase() !== "false";
}

// ---- Mirror-node Discovery ----

type MirrorContract = {
  evm_address?: string | null;
  contract_id?: string | null;
  created_timestamp?: string | null;
  timestamp?: { from?: string; to?: string } | null;
  transaction_hash?: string | null;
  auto_renew_account_id?: string | null;
  bytecode?: string | null;
};

const seenContracts = new Set<string>();
let lastSeenTimestamp: string | null = makeInitialTimestamp();

// Round-robin index for test contract selection.
let _testContractIndex = 0;

function nextDiscoveryContract(): { key: string; address: string; deployer: string } {
  const contracts = CONFIG.testContracts;
  if (!contracts || contracts.length === 0) {
    return { key: "unknown", address: `0x${randomHex(40)}`, deployer: `0x${randomHex(40)}` };
  }
  const pick = contracts[_testContractIndex % contracts.length];
  _testContractIndex += 1;
  return {
    key: pick.key,
    address: pick.address.toLowerCase(),
    deployer: pick.deployer.toLowerCase(),
  };
}

// Backward-compatible helper for tests that import generateDiscovery().
// Runtime scanning now uses mirror-node discovery instead.
export function generateDiscovery() {
  const pick = nextDiscoveryContract();
  const isTestMode = process.env.TEST_MODE === "true";
  const types: ContractType[] = ["lending", "dex", "staking", "bridge", "vault"];
  const riskScore = isTestMode ? 75 : randomInt(20, 95);
  const estimatedLOC = isTestMode ? 150 : randomInt(500, 10000);
  const discoveryTimestamp = Math.floor(Date.now() / 1000);

  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress: pick.address,
      chain: "hedera-testnet",
      deployerAddress: pick.deployer,
      estimatedLOC,
      estimatedLineCount: estimatedLOC,
      contractType: isTestMode ? "vault" : randomChoice(types),
      riskScore,
      initialRiskScore: riskScore,
      budget: DEFAULT_BUDGET_GUARD,
      discoveryTimestamp,
      txHash: `0x${randomHex(64)}`,
      sourceRef: pick.key,
    },
  };
}

function makeInitialTimestamp() {
  const initialFromEnv = process.env.SCANNER_START_TIMESTAMP?.trim();
  if (initialFromEnv) return initialFromEnv;
  const startMs = Date.now() - START_LOOKBACK_SECONDS * 1000;
  const seconds = Math.floor(startMs / 1000);
  const nanos = (startMs % 1000) * 1_000_000;
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

function toConsensusBigInt(ts?: string | null): bigint | null {
  if (!ts || !ts.includes(".")) return null;
  const [secRaw, nanoRaw] = ts.split(".");
  if (!secRaw || !nanoRaw) return null;
  const sec = BigInt(secRaw);
  const nanos = BigInt((nanoRaw + "000000000").slice(0, 9));
  return sec * 1_000_000_000n + nanos;
}

function isRetriableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MIRROR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok && isRetriableStatus(res.status)) {
        throw new Error(`Mirror node responded ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= MIRROR_RETRY_ATTEMPTS) break;
      const jitter = Math.floor(Math.random() * 150);
      const backoff = Math.min(
        MIRROR_RETRY_MAX_MS,
        MIRROR_RETRY_BASE_MS * (2 ** (attempt - 1))
      );
      await sleep(backoff + jitter);
    }
  }

  throw lastError ?? new Error("Mirror node request failed");
}

function extractCreatedTimestamp(c: MirrorContract): string | null {
  return c.created_timestamp ?? c.timestamp?.from ?? null;
}


function estimateLoc(c: MirrorContract): number {
  const bytecode = typeof c.bytecode === "string" ? c.bytecode : "";
  if (bytecode.startsWith("0x") && bytecode.length > 2) {
    const byteLength = (bytecode.length - 2) / 2;
    return Math.max(200, Math.min(12_000, Math.round(byteLength * 1.6)));
  }
  return 1200;
}

function inferContractType(c: MirrorContract): ContractType {
  // Baseline path remains intentionally conservative; downstream agents refine type.
  void c;
  return "unknown";
}

function deriveRiskScore(contractAddress: string): number {
  const digest = ethers.keccak256(ethers.toUtf8Bytes(contractAddress.toLowerCase()));
  const seed = Number.parseInt(digest.slice(2, 4), 16);
  return 20 + (seed % 76); // 20..95
}

function baselineClassification(contractAddress: string, contract: MirrorContract) {
  const contractType = inferContractType(contract);
  return {
    contractType,
    riskScore: deriveRiskScore(contractAddress),
    enrichedPayload: null as Record<string, unknown> | null,
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
  contractAddress: string
): Promise<{
  contractType: ContractType;
  riskScore: number;
  enrichedPayload: Record<string, unknown> | null;
}> {
  const modules = await loadClassifierModules();

  let classification: ClassificationResult;
  try {
    classification = await modules.classifyContract(contractAddress);
  } catch (err) {
    log.warn(`classifier_pipeline_unavailable: evmdecoder classification failed for ${contractAddress}: ${err}`);
    classification = {
      evmType: "unknown",
      defiCategory: "lending",
      standards: [],
      isContract: true,
      contractName: null,
      proxyTarget: null,
    };
  }

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
    sourceResult = await modules.retrieveContractSource(contractAddress, rpcUrl);
  } catch (err) {
    log.warn(`classifier_pipeline_unavailable: source retrieval failed for ${contractAddress}: ${err}`);
  }

  const estimatedLOC = estimateLoc({ bytecode: sourceResult.bytecode } as MirrorContract);
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

  let llmRisk: LLMRiskResponse | null = null;
  let inferenceSource: "0g" | "claude" | "heuristic" = "heuristic";
  let inferenceModel = "none";
  let inferenceLatency = 0;
  try {
    const result = await modules.assessRisk(riskCtx, log);
    llmRisk = result.risk;
    inferenceSource = result.source;
    inferenceModel = result.model;
    inferenceLatency = result.latencyMs;
  } catch (err) {
    log.warn(`classifier_pipeline_unavailable: inference failed for ${contractAddress}: ${err}`);
  }

  const blended = modules.blendRiskScore({
    llmRisk,
    defiCategory: classification.defiCategory,
    bytecodeHex: sourceResult.bytecode,
    estimatedLOC,
    isProxy: classification.proxyTarget !== null,
    standards: classification.standards,
  });

  return {
    contractType: classification.defiCategory,
    riskScore: blended.finalScore,
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
  };
}

async function resolveDiscoveryClassification(contractAddress: string, contract: MirrorContract) {
  if (!SCANNER_CLASSIFIER_PIPELINE) {
    return baselineClassification(contractAddress, contract);
  }
  try {
    return await classifyAndAssessRisk(contractAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (classifierModulesLoadError !== message) {
      classifierModulesLoadError = message;
      log.warn(`classifier_pipeline_unavailable: ${message}. Falling back to baseline scanner classification.`);
    }
    return baselineClassification(contractAddress, contract);
  }
}

async function createDiscoveryFromMirror(contract: MirrorContract) {
  const contractAddress = (contract.evm_address || '').toLowerCase();
  const createdTs = extractCreatedTimestamp(contract) || String(Date.now());
  const txHash = contract.transaction_hash || hashOf({
    contractAddress,
    createdTs,
    source: 'hedera-mirror',
  });

  const classification = await resolveDiscoveryClassification(contractAddress, contract);
  log.info(
    `Classified ${contractAddress.slice(0, 12)}.. type=${classification.contractType} ` +
    `risk=${classification.riskScore}` +
    (SCANNER_CLASSIFIER_PIPELINE ? " (classifier pipeline)" : " (baseline)")
  );

  return {
    type: 'CONTRACT_DISCOVERED' as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress,
      chain: 'hedera-testnet',
      deployerAddress: ZERO_ADDRESS,
      estimatedLOC: estimateLoc(contract),
      contractType: classification.contractType,
      riskScore: classification.riskScore,
      budget: DEFAULT_DISCOVERY_BUDGET_GUARD,
      txHash,
      ...(classification.enrichedPayload || {}),
    },
  };
}


async function fetchNewContractsSinceCursor() {
  const base = `${MIRROR_NODE}/api/v1/contracts?order=desc&limit=${CONTRACT_FETCH_LIMIT}`;
  const cursorUrl = lastSeenTimestamp
    ? `${base}&timestamp=gt:${encodeURIComponent(lastSeenTimestamp)}`
    : base;

  let res = await fetchWithRetry(cursorUrl);

  // Some mirror-node versions reject timestamp filtering on this endpoint.
  if (res.status === 400 && lastSeenTimestamp) {
    res = await fetchWithRetry(base);
  }

  if (!res.ok) {
    throw new Error(`Mirror node responded ${res.status}`);
  }

  const body = await res.json() as { contracts?: MirrorContract[] };
  const contracts = body.contracts || [];
  const cursorTs = toConsensusBigInt(lastSeenTimestamp);

  return contracts
    .filter((c) => typeof c.evm_address === "string" && ethers.isAddress(c.evm_address))
    .filter((c) => {
      if (!cursorTs) return true;
      const ts = toConsensusBigInt(extractCreatedTimestamp(c));
      return ts !== null && ts > cursorTs;
    })
    .sort((a, b) => {
      const ta = toConsensusBigInt(extractCreatedTimestamp(a)) || 0n;
      const tb = toConsensusBigInt(extractCreatedTimestamp(b)) || 0n;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
}

function validateDiscoveryPayload(payload: {
  contractAddress: string;
  estimatedLOC: number;
  riskScore: number;
  budget: number;
}) {
  if (!ethers.isAddress(payload.contractAddress)) {
    throw new Error(`invalid contractAddress: ${payload.contractAddress}`);
  }
  if (!Number.isInteger(payload.estimatedLOC) || payload.estimatedLOC <= 0) {
    throw new Error(`invalid estimatedLOC: ${payload.estimatedLOC}`);
  }
  if (!Number.isInteger(payload.riskScore) || payload.riskScore < 0 || payload.riskScore > 100) {
    throw new Error(`invalid riskScore: ${payload.riskScore}`);
  }
  if (typeof payload.budget !== "number" || !Number.isFinite(payload.budget) || payload.budget <= 0) {
    throw new Error(`invalid budget: ${payload.budget}`);
  }
}

function formatGuardUnits(amountWei: bigint): string {
  return Number(ethers.formatUnits(amountWei, GUARD_DECIMALS)).toFixed(2);
}

function isHtsTransferFailure(error: string): boolean {
  return error.toLowerCase().includes("hts transfer failed");
}

function isInsufficientPayerBalanceError(error: unknown): boolean {
  return String(error ?? "").toUpperCase().includes("INSUFFICIENT_PAYER_BALANCE");
}

// ---- Main ----

async function main() {
  log.info("Scanner Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");
  if (TEST_MODE) log.info("TEST MODE — emitting mock discoveries");

  const wallet = createAgentWallet("SCANNER");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  if (SCANNER_CLASSIFIER_PIPELINE) {
    try {
      const modules = await loadClassifierModules();
      modules.startZgHealthCheckLoop(log);
      const providerAddress = modules.getZgProviderAddress();
      const providerHint = providerAddress ? `${providerAddress.substring(0, 12)}...` : "unset";
      log.info(`Inference source: ${modules.getCurrentInferenceSource()}`);
      log.info(`0g Model: ${modules.getZgModel()} (Provider: ${providerHint})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`classifier_pipeline_unavailable: ${message}. Baseline scanner mode will continue.`);
    }
  } else {
    log.info("classifier_pipeline_disabled: using baseline scanner discovery path");
  }

  let hotLeadListingEnabled = true;
  let payerBalanceExhausted = false;

  async function publishAuditLogSafe(message: any): Promise<boolean> {
    try {
      await hcs.publishAuditLog(message);
      return true;
    } catch (err) {
      if (isInsufficientPayerBalanceError(err)) {
        payerBalanceExhausted = true;
      }
      log.error(`AuditLog publish failed: ${err}`);
      return false;
    }
  }

  async function publishDiscoverySafe(message: any): Promise<boolean> {
    try {
      await hcs.publishDiscovery(message);
      return true;
    } catch (err) {
      if (isInsufficientPayerBalanceError(err)) {
        payerBalanceExhausted = true;
      }
      log.error(`Discovery publish failed: ${err}`);
      return false;
    }
  }

  log.info(`Wallet: ${wallet.evmAddress}`);
  log.info(`Listening interval: ${SCAN_INTERVAL_MS / 1000}s`);
  log.info(`Hot lead threshold: risk > ${HOT_LEAD_RISK_THRESHOLD}`);
  log.info(`Mirror node: ${MIRROR_NODE}`);
  if (SCANNER_AUTO_REGISTER_ONCHAIN) {
    log.info("On-chain auto-registration for scanner is enabled");
  }
  if (lastSeenTimestamp) {
    log.info(`Initial contract cursor: ${lastSeenTimestamp}`);
  }

  async function ensureMarketplaceListingReady(): Promise<boolean> {
    const configuredRegistryAddress = String(contracts.agentRegistry.target).toLowerCase();

    let active = false;
    try {
      active = await contracts.isActiveAgent(wallet.evmAddress);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: active-agent check failed: ${error}`);
      return false;
    }
    if (!active) {
      log.warn("Startup preflight: wallet is not an active on-chain agent");
      if (!SCANNER_AUTO_REGISTER_ONCHAIN || TEST_MODE) {
        return false;
      }

      let minCommodityStakeWei = ethers.parseUnits(
        DEFAULT_COMMODITY_STAKE_GUARD.toFixed(2),
        GUARD_DECIMALS
      );
      try {
        minCommodityStakeWei = await contracts.getCommodityMinStake();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Startup preflight: failed to read commodity min stake, using default: ${error}`);
      }

      const configuredStakeGuard = Number.isFinite(SCANNER_REGISTRATION_STAKE_GUARD) &&
        SCANNER_REGISTRATION_STAKE_GUARD > 0
        ? SCANNER_REGISTRATION_STAKE_GUARD
        : DEFAULT_COMMODITY_STAKE_GUARD;
      let stakeWei = ethers.parseUnits(configuredStakeGuard.toFixed(2), GUARD_DECIMALS);
      if (stakeWei < minCommodityStakeWei) {
        log.warn(
          `Configured scanner stake ${configuredStakeGuard.toFixed(2)} GUARD is below minimum ` +
          `${formatGuardUnits(minCommodityStakeWei)} GUARD; using protocol minimum`
        );
        stakeWei = minCommodityStakeWei;
      }

      try {
        const guardBalance = await contracts.getGuardBalance(wallet.evmAddress);
        if (guardBalance < stakeWei) {
          log.warn(
            `Startup preflight: cannot auto-register scanner, GUARD balance ` +
            `${formatGuardUnits(guardBalance)} is below required ${formatGuardUnits(stakeWei)}`
          );
          return false;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Startup preflight: failed to read GUARD balance before registration: ${error}`);
      }

      try {
        const register = async () => {
          const tx = await contracts.registerAgent(
            AGENT_ID,
            SCANNER_REGISTRATION_UCP_ENDPOINT,
            SCANNER_REGISTRATION_SPECIALIZATIONS,
            stakeWei
          );
          await tx.wait?.();
        };

        try {
          await register();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (!isHtsTransferFailure(error) || !SCANNER_ASSOCIATE_REGISTRY_ON_BOOT) {
            throw err;
          }

          log.warn(
            "Startup preflight: registration hit HTS transfer failure; " +
            "SCANNER_ASSOCIATE_REGISTRY_ON_BOOT=true so attempting registry GUARD association"
          );
          try {
            const ownerAddress = String(await contracts.agentRegistry.owner());
            if (ownerAddress.toLowerCase() !== wallet.evmAddress.toLowerCase()) {
              throw new Error(
                `scanner wallet is not AgentRegistry owner (${ownerAddress}), cannot associate token`
              );
            }
            const associationTx = await contracts.agentRegistry.associateGuardToken();
            await associationTx.wait?.();
            log.info("Startup preflight: AgentRegistry GUARD association transaction confirmed");
          } catch (associateErr) {
            const associationError = associateErr instanceof Error
              ? associateErr.message
              : String(associateErr);
            throw new Error(`AgentRegistry association failed: ${associationError}`);
          }

          await register();
        }

        log.info(
          `Startup preflight: registered scanner on-chain with ` +
          `${formatGuardUnits(stakeWei)} GUARD stake`
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Startup preflight: auto-registration failed: ${error}`);
        return false;
      }
    }

    let currentMarketplaceRegistry = "";
    try {
      currentMarketplaceRegistry = String(await contracts.dataMarketplace.agentRegistry()).toLowerCase();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: failed to read DataMarketplace.agentRegistry: ${error}`);
      return false;
    }

    if (currentMarketplaceRegistry !== configuredRegistryAddress) {
      try {
        const marketplaceOwner = String(await contracts.dataMarketplace.owner()).toLowerCase();
        if (marketplaceOwner !== wallet.evmAddress.toLowerCase()) {
          log.warn(
            `Startup preflight: DataMarketplace registry points to ${currentMarketplaceRegistry}, ` +
            `but scanner wallet is not owner (${marketplaceOwner}); cannot sync`
          );
          return false;
        }
        const tx = await contracts.dataMarketplace.setAgentRegistry(configuredRegistryAddress);
        await tx.wait?.();
        currentMarketplaceRegistry = configuredRegistryAddress;
        log.info(`Startup preflight: synced DataMarketplace registry to ${configuredRegistryAddress}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`Startup preflight: failed to sync DataMarketplace registry: ${error}`);
        return false;
      }
    }

    try {
      const registryForMarketplace = new ethers.Contract(
        currentMarketplaceRegistry,
        contracts.agentRegistry.interface,
        contracts.wallet
      );
      const activeInMarketplaceRegistry = await registryForMarketplace.isActiveAgent(wallet.evmAddress);
      if (!activeInMarketplaceRegistry) {
        log.warn(
          `Startup preflight: scanner is inactive in marketplace registry ${currentMarketplaceRegistry}`
        );
      }
      return Boolean(activeInMarketplaceRegistry);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: failed to verify scanner in marketplace registry: ${error}`);
      return false;
    }
  }

  hotLeadListingEnabled = await ensureMarketplaceListingReady();
  if (!hotLeadListingEnabled) {
    log.warn("Hot lead listing disabled: scanner wallet is not an active marketplace agent");
    await publishAuditLogSafe({
      type: "LISTING_DISABLED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        phase: "hot_lead_listing",
        reasonCode: "inactive_agent",
        strictLive: STRICT_LIVE,
        evmAddress: wallet.evmAddress,
      },
    });
  }

  async function scanCycle() {
    payerBalanceExhausted = false;
    if (TEST_MODE) {
      const discovery = generateDiscovery();
      const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

      try {
        validateDiscoveryPayload(discovery.payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`Mock discovery payload rejected: ${reason}`);
        await publishAuditLogSafe({
          type: "DISCOVERY_REJECTED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            reason,
            strictLive: STRICT_LIVE,
            contractAddress,
          },
        });
        return;
      }

      const publishedDiscovery = await publishDiscoverySafe(discovery);
      if (!publishedDiscovery) {
        if (payerBalanceExhausted) {
          log.warn("Stopping scan cycle early: scanner payer has insufficient HBAR for HCS publishes");
        }
        return;
      }
      const auctionLogPublished = await publishAuditLogSafe({
        type: "AUCTION_CREATED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          contractAddress,
          contractType,
          riskScore,
          estimatedLOC,
        },
      });
      if (!auctionLogPublished && payerBalanceExhausted) {
        log.warn("Stopping scan cycle early: scanner payer has insufficient HBAR for auditLog publishes");
        return;
      }
      log.info(
        `Published mock discovery: ${contractAddress.slice(0, 12)}... ` +
        `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
      );
      log.info(`Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
      return;
    }

    let discoveredContracts: MirrorContract[] = [];
    try {
      discoveredContracts = await fetchNewContractsSinceCursor();
    } catch (err) {
      log.warn(`Mirror-node scan failed: ${err}`);
      await publishAuditLogSafe({
        type: "DISCOVERY_FETCH_FAILED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          error: err instanceof Error ? err.message : String(err),
          mirrorNode: MIRROR_NODE,
        },
      });
      return;
    }

    if (discoveredContracts.length === 0) {
      log.info(`No new deployed contracts found. Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
      return;
    }

    let processedThisCycle = 0;
    for (const c of discoveredContracts) {
      if (processedThisCycle >= SCANNER_MAX_DISCOVERIES_PER_CYCLE) {
        log.info(
          `Reached per-cycle discovery cap (${SCANNER_MAX_DISCOVERIES_PER_CYCLE}); ` +
          "remaining contracts will be processed next cycle"
        );
        break;
      }
      const discovery = await createDiscoveryFromMirror(c);
      const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

      if (seenContracts.has(contractAddress)) continue;
      seenContracts.add(contractAddress);

      try {
        validateDiscoveryPayload(discovery.payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`Discovery payload rejected: ${reason}`);
        await publishAuditLogSafe({
          type: "DISCOVERY_REJECTED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            reason,
            strictLive: STRICT_LIVE,
            contractAddress,
          },
        });
        if (STRICT_LIVE && !DEMO_MODE) continue;
      }

      log.info(
        `Discovered deployed contract: ${contractAddress.slice(0, 12)}... ` +
        `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
      );

      // ── Hot Lead: sell early access on DataMarketplace ──
      if (riskScore > HOT_LEAD_RISK_THRESHOLD) {
        if (!hotLeadListingEnabled) {
          log.info(
            `HIGH RISK (${riskScore}) — skipping hot lead listing (scanner is not active on-chain)`
          );
        } else {
          log.info(`HIGH RISK (${riskScore}) — listing as hot lead for 0.1 GUARD`);

          const dataHash = hashOf(discovery.payload);

          try {
            await contracts.createListing(
              0,                                        // parentJobId (no job yet)
              `Hot lead: ${contractType} contract`,     // title
              `Hot lead: ${contractType} contract, risk ${riskScore}`, // description
              ListingCategory.HOT_LEAD,                 // category (uint8)
              HOT_LEAD_PRICE,                           // price
              dataHash,                                 // contentHash (bytes32)
            );
            log.info("Hot lead listed on DataMarketplace");
            log.info(`Delaying public discovery by ${HOT_LEAD_DELAY_MS / 1000}s...`);
            await sleep(HOT_LEAD_DELAY_MS);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const reasonCode = normalizeBidFailureReasonCode(error);
            log.warn(`DataMarketplace listing failed (continuing): ${error}`);
            if (reasonCode === "inactive_agent") {
              hotLeadListingEnabled = false;
              log.warn("Disabling hot lead listing for this run: scanner wallet is inactive on-chain");
            }
            await publishAuditLogSafe({
              type: "ONCHAIN_TX_FAILED",
              agentId: AGENT_ID,
              timestamp: Date.now(),
              payload: {
                phase: "hot_lead_listing",
                strictLive: STRICT_LIVE && !DEMO_MODE,
                reasonCode,
                error,
                contractAddress,
              },
            });
            if (STRICT_LIVE && !DEMO_MODE && reasonCode !== "inactive_agent") {
              continue;
            }
          }
        }
      }

      // ── Public Discovery: broadcast to all agents ──
      const publishedDiscovery = await publishDiscoverySafe(discovery);
      if (!publishedDiscovery) {
        if (payerBalanceExhausted) {
          log.warn("Stopping scan cycle early: scanner payer has insufficient HBAR for HCS publishes");
          break;
        }
        continue;
      }
      log.info(`Published discovery to HCS topic ${CONFIG.hcsTopics.discovery}`);
      processedThisCycle += 1;

      await publishAuditLogSafe({
        type: "AUCTION_CREATED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          contractAddress,
          contractType,
          riskScore,
          estimatedLOC,
        },
      });

      const createdTs = extractCreatedTimestamp(c);
      if (createdTs) lastSeenTimestamp = createdTs;
    }

    log.info(`Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
  }

  // Run first cycle immediately, then on interval
  await scanCycle();
  setInterval(scanCycle, SCAN_INTERVAL_MS);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
