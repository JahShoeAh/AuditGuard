/**
 * Type declarations for packages/sdk/address-utils.js
 * Consumed by the TypeScript agent layer.
 */

/**
 * Returns true if the address is a Hedera EVM-mapped form.
 */
export function isHederaEvmMapped(address: string): boolean;

/**
 * Converts a Hedera EVM-mapped address to its dotted account ID string.
 * e.g. "0x000000000000000000000000000000000079183a" → "0.0.7938106"
 */
export function hederaEvmMappedToAccountId(address: string): string;

/**
 * Resolves the canonical deployer address for a Hedera contract.
 * If the raw address is an EVM-mapped form, fetches the account ECDSA alias.
 */
export function resolveHederaDeployerAddress(
  rawAddress: string,
  mirrorNodeBase: string
): Promise<string>;

/**
 * Chain-agnostic deployer address resolution.
 */
export function resolveDeployerAddress(
  chain: string,
  rawAddress: string,
  options?: { mirrorNodeBase?: string }
): Promise<string>;
