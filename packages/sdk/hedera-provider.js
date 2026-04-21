/**
 * packages/sdk/hedera-provider.js
 *
 * Shared Hedera JSON-RPC provider utilities consumed by both the orchestrator
 * (plain JS ESM) and the agent layer (TypeScript via tsx).
 *
 * Centralises three things that were previously copy-pasted in every ContractClient:
 *   1. The Hedera legacy gas-price override (prevents silent EIP-1559 reverts)
 *   2. The PollingEventSubscriber patch (Hedera doesn't support eth_newFilter)
 *   3. RPC candidate resolution + FallbackProvider construction
 */

import { ethers } from "ethers";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

// Hedera JSON-RPC relays don't implement eth_newFilter / eth_getFilterChanges.
// PollingEventSubscriber forces eth_getLogs-based polling instead.
// It is not exposed in ethers' package exports map — require the CJS build directly.
const { PollingEventSubscriber } = _require(
  "../../node_modules/ethers/lib.commonjs/providers/subscriber-polling.js"
);

// ─── Constants ─────────────────────────────────────────────────────────────

export const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };

export const DEFAULT_HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";

/**
 * Hedera testnet minimum gas price (~1010 gwei).
 *
 * The EIP-1559 fee history endpoint on hashio.io returns a near-zero baseFee,
 * causing ethers.js to build type-2 txs with maxFeePerGas ≈ 200 wei — far below
 * the relay minimum. This results in silent reverts (status=0, gasUsed=0).
 * Overriding getFeeData forces type-0 (legacy) transactions at the correct price.
 *
 * Override via HEDERA_LEGACY_GAS_PRICE env var (default: 1111000000000 wei).
 */
export const HEDERA_LEGACY_GAS_PRICE = BigInt(
  process.env.HEDERA_LEGACY_GAS_PRICE ?? "1111000000000"
);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Validate that `value` is a checksummed EVM address. Throws if not.
 * @param {string} value
 * @param {string} label - used in the error message
 * @returns {string} the validated address
 */
export function assertAddress(value, label) {
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid ${label} address: ${value}`);
  }
  return value;
}

/**
 * Patch a provider's getFeeData to always return legacy type-0 gas parameters.
 * Must be applied to every JsonRpcProvider AND any wrapping FallbackProvider.
 * @param {object} provider - ethers JsonRpcProvider or FallbackProvider
 */
export function patchProviderFeeData(provider) {
  provider.getFeeData = async () => ({
    gasPrice: HEDERA_LEGACY_GAS_PRICE,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  });
}

/**
 * Patch a JsonRpcProvider to use PollingEventSubscriber for all event
 * subscriptions (required for Hedera JSON-RPC compatibility).
 * @param {ethers.JsonRpcProvider} provider
 */
export function applyPollingSubscriber(provider) {
  const _orig = provider._getSubscriber.bind(provider);
  provider._getSubscriber = (sub) => {
    if (sub.type === "event") return new PollingEventSubscriber(provider, sub.filter);
    return _orig(sub);
  };
}

/**
 * Parse the list of RPC endpoints from env vars.
 * Primary: HEDERA_JSON_RPC_URL or HEDERA_RPC_URL (falls back to hashio.io).
 * Additional fallbacks: comma-separated HEDERA_JSON_RPC_FALLBACK_URLS.
 * Deduplicates the list.
 * @returns {string[]}
 */
export function parseRpcCandidates() {
  const primary =
    process.env.HEDERA_JSON_RPC_URL ||
    process.env.HEDERA_RPC_URL ||
    DEFAULT_HEDERA_TESTNET_RPC;
  const fallbackRaw = process.env.HEDERA_JSON_RPC_FALLBACK_URLS || "";
  const fallbacks = fallbackRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set([primary, ...fallbacks]));
}

/**
 * Build an ethers provider for Hedera testnet with:
 *   - Polling interval tuned for Hedera (~3s block time)
 *   - PollingEventSubscriber for eth_getLogs compatibility
 *   - Legacy gas price override to prevent EIP-1559 silent reverts
 *   - FallbackProvider when multiple RPC endpoints are configured
 *
 * @returns {ethers.AbstractProvider}
 */
export function buildProviderWithFallback() {
  const candidates = parseRpcCandidates();

  const providers = candidates.map((rpcUrl) => {
    const provider = new ethers.JsonRpcProvider(rpcUrl, HEDERA_NETWORK, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
    provider.pollingInterval = 5000;
    applyPollingSubscriber(provider);
    patchProviderFeeData(provider);
    return provider;
  });

  if (providers.length === 1) return providers[0];

  const fallback = new ethers.FallbackProvider(
    providers.map((provider, index) => ({
      provider,
      priority: index + 1,
      weight: 1,
      stallTimeout: 2500,
    })),
    HEDERA_NETWORK,
    { quorum: 1, pollingInterval: 5000 }
  );
  // Patch the FallbackProvider itself so wallet.sendTransaction also uses legacy gas.
  patchProviderFeeData(fallback);
  return fallback;
}
