import { EvmDecoder } from "evmdecoder";
import type { ContractInfo } from "evmdecoder";
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
  // ── DEX ──────────────────────────────────────────────────────────────────
  "0x38ed1739": "dex",   // swapExactTokensForTokens (Uniswap V2)
  "0x7ff36ab5": "dex",   // swapExactETHForTokens   (Uniswap V2)
  "0xe8e33700": "dex",   // addLiquidity             (Uniswap V2)
  "0xbaa2abde": "dex",   // removeLiquidity          (Uniswap V2)
  "0x128acb08": "dex",   // swap                     (Uniswap V3 pool)
  "0x022c0d9f": "dex",   // swap                     (Uniswap V2 pair)
  "0x3df02124": "dex",   // exchange                  (Curve)
  "0xa6417ed6": "dex",   // exchange_underlying       (Curve)

  // ── Lending ───────────────────────────────────────────────────────────────
  "0xc5ebeaec": "lending",  // borrow     (Compound)
  "0x0e752702": "lending",  // repayBorrow (Compound)
  "0x573ade81": "lending",  // repay      (Aave V1)
  "0xe9c714f2": "lending",  // liquidateBorrow (Compound)
  "0xa0712d68": "lending",  // mint       (Compound cToken)
  "0x69328dec": "lending",  // withdraw   (Aave)
  "0xab9c4b5d": "lending",  // flashLoan  (Aave V1)

  // ── Staking ───────────────────────────────────────────────────────────────
  "0xa694fc3a": "staking",  // stake
  "0x2e17de78": "staking",  // unstake
  "0x5c19a95c": "staking",  // delegate   (vote-escrowed)
  "0xb88d4fde": "staking",  // safeTransferFrom (liquid staking receipt)
  "0x3d18b912": "staking",  // getReward  (Synthetix-style)

  // ── Bridge ────────────────────────────────────────────────────────────────
  "0x0f5287b0": "bridge",   // bridgeOut
  "0x8b7bfd70": "bridge",   // sendToChain
  "0xa44bbb15": "bridge",   // depositETH
  "0x3805550f": "bridge",   // execute    (cross-chain message)

  // ── Vault / Yield ─────────────────────────────────────────────────────────
  "0xb6b55f25": "vault",    // deposit    (ERC-4626)
  "0x2e1a7d4d": "vault",    // withdraw   (ERC-4626)
  "0xba087652": "vault",    // redeem     (ERC-4626)
  "0xef8b30f7": "vault",    // depositFor (Yearn-style)

  // ── Derivatives ───────────────────────────────────────────────────────────
  "0x09d68a6e": "derivatives",  // createOrder   (GMX-style)
  "0xa6a47078": "derivatives",  // liquidatePosition
  "0x44b81396": "derivatives",  // createPosition
  "0xf2b9fdb8": "derivatives",  // openPosition
  "0x96c144f0": "derivatives",  // increasePosition (GMX)

  // ── Oracle ────────────────────────────────────────────────────────────────
  "0x50d25bcd": "oracle",  // latestAnswer     (Chainlink AggregatorV3)
  "0xfeaf968c": "oracle",  // latestRoundData  (Chainlink AggregatorV3)
  "0x668a0f02": "oracle",  // latestRound      (Chainlink)
  "0x9a6b3eff": "oracle",  // getPrice         (generic oracle)

  // ── Governance ────────────────────────────────────────────────────────────
  "0xfe0d94c1": "governance",  // execute      (Governor Bravo)
  "0x160cbed7": "governance",  // propose      (Governor Bravo)
  "0x15373e3d": "governance",  // castVoteWithReason
  "0x56781388": "governance",  // castVote

  // ── NFT ───────────────────────────────────────────────────────────────────
  "0x6352211e": "nft",   // ownerOf         (ERC-721)
  "0x42842e0e": "nft",   // safeTransferFrom (ERC-721)
  "0x1249c58b": "nft",   // mint
  "0x731133e9": "nft",   // mint (ERC-1155)
};

function mapEvmTypeToDefiCategory(
  evmType: string,
  standards: string[],
  info: any
): DefiCategory {
  const typeLower = evmType.toLowerCase();

  // ── Standards-based fast paths ───────────────────────────────────────────
  if (standards.includes("ERC3156")) return "lending";              // Flash-loan standard
  if (standards.includes("ERC721") || standards.includes("ERC1155")) return "nft";
  if (typeLower === "gnosissafe" || typeLower === "gnosis multisig") return "vault";
  if (typeLower === "diamond") return "vault";                      // ERC-2535 multi-facet

  // ── Function-selector heuristic ──────────────────────────────────────────
  const bytecode: string | undefined = info?.bytecode;
  if (bytecode && bytecode.length > 10) {
    const selectorHits: Record<DefiCategory, number> = {
      lending: 0,
      dex: 0,
      staking: 0,
      bridge: 0,
      vault: 0,
      derivatives: 0,
      oracle: 0,
      governance: 0,
      nft: 0,
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
