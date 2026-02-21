import type { ContractType } from "../shared/types.js";

type BytecodeLike = {
  bytecode?: string | null;
};

const SELECTORS: Record<ContractType, string[]> = {
  lending: [
    "c5ebeaec", // borrow
    "0e752702", // repay
    "573ade81", // repayBorrow
    "e9c714f2", // liquidateBorrow
    "a0712d68", // mint (cToken style)
  ],
  dex: [
    "38ed1739", // swapExactTokensForTokens
    "7ff36ab5", // swapExactETHForTokens
    "18cbafe5", // swapExactTokensForETH
    "e8e33700", // addLiquidity
    "baa2abde", // removeLiquidity
    "022c0d9f", // pair.swap
    "128acb08", // v3 swap
  ],
  staking: [
    "a694fc3a", // stake
    "2e17de78", // unstake
    "5c19a95c", // delegate
    "3d18b912", // claimRewards
  ],
  bridge: [
    "0f5287b0", // bridgeOut
    "8b7bfd70", // bridge
    "a44bbb15", // sendToL2
    "3805550f", // depositERC20
  ],
  vault: [
    "b6b55f25", // deposit(uint256)
    "2e1a7d4d", // withdraw(uint256)
    "ba087652", // harvest
    "d0e30db0", // deposit()
  ],
};

const ERC20_SELECTOR_SET = [
  "18160ddd", // totalSupply
  "70a08231", // balanceOf
  "a9059cbb", // transfer
  "23b872dd", // transferFrom
  "095ea7b3", // approve
];

const NFT_SELECTOR_SET = [
  "6352211e", // ownerOf
  "42842e0e", // safeTransferFrom(address,address,uint256)
  "b88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "c87b56dd", // tokenURI
  "f242432a", // ERC1155 safeTransferFrom
  "2eb2c2d6", // ERC1155 safeBatchTransferFrom
];

function normalizeBytecode(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith("0x")) return "";
  return trimmed.slice(2);
}

function countSelectorHits(bytecodeHex: string, selectors: string[]): number {
  let hits = 0;
  for (const selector of selectors) {
    if (bytecodeHex.includes(selector.toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * Best-effort fallback contract typing when full classifier pipeline is disabled/unavailable.
 * Returns "unknown" only when no usable bytecode is available.
 */
export function inferBaselineContractType(input: BytecodeLike): ContractType | "unknown" {
  const bytecodeHex = normalizeBytecode(input?.bytecode);
  if (!bytecodeHex) return "unknown";

  let bestType: ContractType | null = null;
  let bestScore = 0;

  for (const type of Object.keys(SELECTORS) as ContractType[]) {
    const score = countSelectorHits(bytecodeHex, SELECTORS[type]);
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  if (bestType && bestScore > 0) return bestType;

  // Standards-like selector hints without full ABI/classifier context.
  const erc20Hits = countSelectorHits(bytecodeHex, ERC20_SELECTOR_SET);
  if (erc20Hits >= 3) return "lending";

  const nftHits = countSelectorHits(bytecodeHex, NFT_SELECTOR_SET);
  if (nftHits >= 2) return "vault";

  // Default deterministic fallback for bytecode-bearing contracts.
  return "lending";
}

