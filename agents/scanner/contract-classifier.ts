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

export type DefiCategory = "lending" | "dex" | "staking" | "bridge" | "vault";

/**
 * Convert Hedera contract ID to EVM address.
 * Hedera contract IDs (0.0.X format) automatically map to EVM addresses.
 * Formula: EVM address is the 20-byte representation of the contract shard.realm.num
 * @param contractId Hedera contract ID like "0.0.7946509"
 * @returns EVM address like "0x00000000..."
 */
function hederaContractIdToEvmAddress(contractId: string): string {
  const parts = contractId.split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid Hedera contract ID format: ${contractId}`);
  }

  const shard = BigInt(parts[0]);
  const realm = BigInt(parts[1]);
  const num = BigInt(parts[2]);

  // Combine into 64-bit value: (shard << 40) | (realm << 24) | num
  const combined = (shard << BigInt(40)) | (realm << BigInt(24)) | num;

  // Convert to 20-byte hex (padded)
  const hex = combined.toString(16).padStart(40, "0");
  return "0x" + hex;
}

/**
 * Normalize contract address: accept either EVM format (0xXXX) or Hedera format (0.0.X)
 * and always return EVM format for evmdecoder.
 * @param address Either EVM address or Hedera contract ID
 * @returns EVM address
 */
function normalizeContractAddress(address: string): string {
  if (!address) {
    throw new Error("Contract address cannot be empty");
  }

  // If already EVM-like format (starts with 0x), pass through.
  // Decoder and RPC layer can still reject malformed addresses, but scanner
  // tests and mock flows intentionally use synthetic addresses.
  if (address.startsWith("0x")) {
    return address.toLowerCase();
  }

  // If Hedera format (0.0.X), convert to EVM
  if (address.includes(".")) {
    return hederaContractIdToEvmAddress(address);
  }

  throw new Error(`Unknown address format: ${address}`);
}

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
  const decoder = await ensureDecoder();

  // Normalize address: convert Hedera format (0.0.X) to EVM format (0xXXX) if needed
  let evmAddress: string;
  try {
    evmAddress = normalizeContractAddress(contractAddress);
  } catch (err) {
    throw new Error(`Failed to normalize contract address "${contractAddress}": ${err}`);
  }

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
