import { EvmDecoder } from "evmdecoder";
import type { ContractInfo } from "evmdecoder";
import { ethers } from "ethers";

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

  // If already EVM format (starts with 0x), return as-is
  if (address.startsWith("0x")) {
    if (ethers.isAddress(address)) {
      return address.toLowerCase();
    }
    throw new Error(`Invalid EVM address: ${address}`);
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

const FUNCTION_SELECTOR_HINTS: Record<string, DefiCategory> = {
  "0x38ed1739": "dex",
  "0x7ff36ab5": "dex",
  "0xe8e33700": "dex",
  "0xbaa2abde": "dex",
  "0x128acb08": "dex",
  "0x022c0d9f": "dex",
  "0xc5ebeaec": "lending",
  "0x0e752702": "lending",
  "0x573ade81": "lending",
  "0xe9c714f2": "lending",
  "0xa0712d68": "lending",
  "0xa694fc3a": "staking",
  "0x2e17de78": "staking",
  "0x5c19a95c": "staking",
  "0xb88d4fde": "staking",
  "0x0f5287b0": "bridge",
  "0x8b7bfd70": "bridge",
  "0xa44bbb15": "bridge",
  "0x3805550f": "bridge",
  "0xb6b55f25": "vault",
  "0x2e1a7d4d": "vault",
  "0xba087652": "vault",
};

function mapEvmTypeToDefiCategory(
  evmType: string,
  standards: string[],
  info: any
): DefiCategory {
  const typeLower = evmType.toLowerCase();

  if (standards.includes("ERC3156")) return "lending";
  if (typeLower === "gnosissafe" || typeLower === "gnosis multisig") return "vault";
  if (typeLower === "diamond") return "vault";

  if (standards.includes("ERC721") || standards.includes("ERC1155")) return "vault";

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
      const selectorHex = selector.slice(2);
      if (bytecode.includes(selectorHex)) {
        selectorHits[category]++;
      }
    }

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

  return "lending";
}

export function _resetDecoder(): void {
  decoderInstance = null;
  initPromise = null;
}
