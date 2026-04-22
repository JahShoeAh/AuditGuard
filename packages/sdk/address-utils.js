/**
 * address-utils.js
 *
 * Chain-agnostic deployer address resolution.
 *
 * Problem: On Hedera, the mirror node's contract results API returns the
 * deployer as an EVM-mapped address (0x000000000000000000000000SSSSRRRRNNNNNNNN)
 * derived deterministically from the Hedera account ID. This differs from the
 * ECDSA wallet address (e.g. 0xC1E5...) that MetaMask/HashPack expose.
 *
 * This module resolves the canonical ECDSA address for any supported chain so
 * that deployer_address stored in the DB always matches what a connected wallet
 * reports — enabling correct dashboard filtering.
 *
 * Adding a new chain:
 *   1. Add a case to resolveDeployerAddress() for the new chain identifier.
 *   2. Implement the resolver function (or return address as-is if no mapping
 *      is needed, as is the case for most EVM chains).
 *
 * Supported chains:
 *   - hedera-testnet / hedera-mainnet  →  ECDSA alias via mirror node lookup
 *   - ethereum / polygon / avalanche / any EVM  →  pass-through (checksummed lower)
 *   - solana (future)  →  base58 public key, no conversion needed
 */

const HEDERA_EVM_MAPPED_RE = /^0x0{24}[0-9a-f]{16}$/i;

/**
 * Returns true if the address is a Hedera EVM-mapped form.
 * Format: 0x + 12 zero bytes (24 hex) + 4 shard bytes + 4 realm bytes + 4 num bytes
 * Total: 20 bytes (40 hex chars after 0x).
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isHederaEvmMapped(address) {
  return typeof address === "string" && HEDERA_EVM_MAPPED_RE.test(address);
}

/**
 * Converts a Hedera EVM-mapped address to its dotted account ID string.
 * e.g. "0x000000000000000000000000000000000079183a" → "0.0.7938106"
 *
 * @param {string} address  EVM-mapped address (42-char hex string with 0x prefix)
 * @returns {string}  Hedera account ID in "shard.realm.num" form
 */
export function hederaEvmMappedToAccountId(address) {
  const hex = address.slice(2).toLowerCase(); // drop 0x, 40 chars
  const shard = parseInt(hex.slice(16, 24), 16);
  const realm = parseInt(hex.slice(24, 32), 16);
  const num   = parseInt(hex.slice(32, 40), 16);
  return `${shard}.${realm}.${num}`;
}

/**
 * Fetches the ECDSA alias (evm_address) for a Hedera account via the mirror node.
 * Returns null if the account has no ECDSA alias or if the request fails.
 *
 * @param {string} accountId  Hedera account ID, e.g. "0.0.7938106"
 * @param {string} mirrorNodeBase  Base URL, e.g. "https://testnet.mirrornode.hedera.com"
 * @returns {Promise<string|null>}
 */
async function fetchHederaEcdsaAlias(accountId, mirrorNodeBase) {
  try {
    const url = `${mirrorNodeBase.replace(/\/$/, "")}/api/v1/accounts/${accountId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const evmAddress = body?.evm_address ?? body?.alias;
    if (!evmAddress || typeof evmAddress !== "string") return null;
    // evm_address on a Hedera account is the ECDSA alias (40-char hex, no 0x prefix on some versions)
    const normalized = evmAddress.startsWith("0x") ? evmAddress : `0x${evmAddress}`;
    // Sanity-check: must look like a real ECDSA address (non-zero, not EVM-mapped)
    if (isHederaEvmMapped(normalized)) return null;
    if (/^0x0{40}$/.test(normalized)) return null;
    return normalized.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolves the canonical deployer address for a Hedera contract.
 *
 * If the raw address is an EVM-mapped form, this function fetches the
 * account's ECDSA alias from the mirror node.  If the alias is unavailable
 * (ED25519-only account), the EVM-mapped address is returned unchanged.
 *
 * @param {string} rawAddress   Address as returned by the mirror node
 * @param {string} mirrorNodeBase
 * @returns {Promise<string>}
 */
export async function resolveHederaDeployerAddress(rawAddress, mirrorNodeBase) {
  if (!rawAddress) return "";
  const lower = rawAddress.toLowerCase();
  if (!isHederaEvmMapped(lower)) return lower;

  const accountId = hederaEvmMappedToAccountId(lower);
  const alias = await fetchHederaEcdsaAlias(accountId, mirrorNodeBase);
  return alias ?? lower;
}

/**
 * Chain-agnostic deployer address resolution.
 *
 * @param {string} chain           Chain identifier (e.g. "hedera-testnet", "ethereum", "solana")
 * @param {string} rawAddress      Raw address string from contract indexer / mirror node
 * @param {{ mirrorNodeBase?: string }} [options]
 * @returns {Promise<string>}      Canonical address for the given chain, lowercased
 */
export async function resolveDeployerAddress(chain, rawAddress, options = {}) {
  if (!rawAddress) return "";

  const normalizedChain = (chain ?? "").toLowerCase();

  if (normalizedChain === "hedera-testnet" || normalizedChain === "hedera-mainnet") {
    const mirrorNodeBase =
      options.mirrorNodeBase ??
      "https://testnet.mirrornode.hedera.com";
    return resolveHederaDeployerAddress(rawAddress, mirrorNodeBase);
  }

  // General EVM chains (ethereum, polygon, avalanche, bsc, arbitrum, optimism, …)
  // tx.from is already the ECDSA address — no conversion needed.
  if (
    normalizedChain.startsWith("ethereum") ||
    normalizedChain.startsWith("polygon") ||
    normalizedChain.startsWith("avalanche") ||
    normalizedChain.startsWith("bsc") ||
    normalizedChain.startsWith("arbitrum") ||
    normalizedChain.startsWith("optimism") ||
    normalizedChain.startsWith("base") ||
    normalizedChain === "evm"
  ) {
    return rawAddress.toLowerCase();
  }

  // Solana (future): base58 public keys are already canonical, no conversion.
  if (normalizedChain === "solana" || normalizedChain === "solana-devnet") {
    return rawAddress; // case-sensitive base58 — do not lowercase
  }

  // Unknown chain: return as-is, lowercased.
  return rawAddress.toLowerCase();
}
