import { EvmDecoder } from "evmdecoder";
import { resolveEvmAddress } from "./hedera-address.js";

export interface ClassificationResult {
  evmType: string;
  defiCategory: DefiCategory;
  standards: string[];
  isContract: boolean;
  contractName: string | null;
  proxyTarget: string | null;
}

export type DefiCategory =
  | "lending"      // Lending / borrowing (Aave, Compound, MakerDAO)
  | "dex"          // Decentralised exchanges (Uniswap, Curve)
  | "staking"      // Staking & liquid-staking (Lido, Rocket Pool)
  | "bridge"       // Cross-chain bridges (Hop, Stargate)
  | "vault"        // Yield aggregators / vaults (Yearn, Beefy)
  | "derivatives"  // Perpetuals, options, futures (GMX, dYdX, Synthetix)
  | "oracle"       // Price oracles (Chainlink, Pyth)
  | "governance"   // DAO governance (Governor Bravo, OpenZeppelin Governor)
  | "nft";         // NFT tokens / marketplaces (ERC-721, ERC-1155)

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
          http: {
            maxRetries: 3,
            maxBatchSplits: 5,
          },
          client: {
            maxBatchSize: 100,
            maxBatchTime: 100,
            individualReceipts: true,
            maxRetryTime: 300,
            tracerTimeout: 10,
          },
        },
        abi: {
          directory: "./abis",
          searchRecursive: true,
          fingerprintContracts: true,
          requireContractMatch: false,
          decodeAnonymous: true,
          reconcileStructShapeFromTuples: true,
        },
        contractInfo: {
          maxCacheEntries: 5_000,
        },
        logging: {
          showDecodeWarnings: false,
          showClassificationWarnings: false,
        },
      });
      await decoderInstance.initialize();
    })();
  }

  await initPromise;
  return decoderInstance!;
}

export async function classifyContract(
  contractAddress: string
): Promise<ClassificationResult> {
  // Normalise: accept both EVM (0x…) and Hedera entity IDs (0.0.N).
  const evmAddress = resolveEvmAddress(contractAddress);

  const decoder = await ensureDecoder();
  const info = await decoder.contractInfo({ address: evmAddress });

  if (!info?.isContract) {
    return {
      evmType: "EOA",
      defiCategory: "lending",
      standards: [],
      isContract: false,
      contractName: null,
      proxyTarget: null,
    };
  }

  const evmType = info.contractType?.name ?? "unknown";
  const standards: string[] = info.contractType?.standards ?? [];
  const contractName = info.contractName ?? null;

  let proxyTarget: string | null = null;
  if (info.contractType?.proxies && info.contractType.proxies.length > 0) {
    const lastProxy = info.contractType.proxies[info.contractType.proxies.length - 1];
    proxyTarget = lastProxy?.target ?? null;
  }

  const defiCategory = mapEvmTypeToDefiCategory(evmType, standards);

  return {
    evmType,
    defiCategory,
    standards,
    isContract: true,
    contractName,
    proxyTarget,
  };
}

function mapEvmTypeToDefiCategory(
  evmType: string,
  standards: string[]
): DefiCategory {
  const typeLower = evmType.toLowerCase();

  // ── Standards-based fast paths ───────────────────────────────────────────
  // evmdecoder contractType.name values: GnosisSafe, GnosisMultisig, DiamondProxy,
  //   Token (ERC20), NFT (ERC721), MultiToken (ERC1155), FlashLoan (ERC3156),
  //   TokenPair (Uniswap-style LP), ContractRegistry (ERC1820), OffchainResolver (ERC3668)
  if (standards.includes("ERC3156") || typeLower === "flashloan") return "lending";
  if (standards.includes("ERC721") || standards.includes("ERC1155")
      || typeLower === "nft" || typeLower === "multitoken") return "nft";
  if (typeLower === "gnosissafe" || typeLower === "gnosismultisig") return "vault";
  if (typeLower === "diamond" || typeLower === "diamondproxy") return "vault";  // ERC-2535
  if (typeLower === "tokenpair") return "dex";  // Uniswap-style LP pair

  // Note: function-selector heuristics require raw EVM bytecode. ContractInfo
  // from evmdecoder does not expose a bytecode field, so selector-based
  // classification cannot run here. Further bytecode-based refinement is
  // performed upstream in the enrichment pipeline (source-retriever + risk-blender).

  return "vault"; // conservative generic DeFi default for unrecognised contracts
}

export function _resetDecoder(): void {
  decoderInstance = null;
  initPromise = null;
}
