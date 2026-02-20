/**
 * Hedera ↔ EVM address conversion utilities.
 *
 * Hedera entity IDs have the form `shard.realm.num` (optionally suffixed with
 * `@<timestamp>` for scheduled transactions).  The canonical 20-byte EVM
 * address encoding used by Hedera is:
 *   bytes  0– 3  : shard  (uint32, big-endian)
 *   bytes  4–11  : realm  (uint64, big-endian)
 *   bytes 12–19  : num    (uint64, big-endian)
 *
 * Example: `0.0.12345` → `0x0000000000000000000000000000000000003039`
 */

const HEDERA_ID_RE = /^(\d+)\.(\d+)\.(\d+)(@[\d.]+)?$/;

/** Returns true if the input looks like a Hedera entity ID (e.g. `0.0.12345`). */
export function isHederaId(input: string): boolean {
  return HEDERA_ID_RE.test(input.trim());
}

/**
 * Converts a Hedera entity ID (`shard.realm.num`) to its canonical 20-byte
 * EVM address string.  Throws if the format is unrecognised.
 */
export function hederaIdToEvmAddress(input: string): string {
  const match = input.trim().match(HEDERA_ID_RE);
  if (!match) {
    throw new Error(`Not a valid Hedera entity ID: ${input}`);
  }

  const shard = BigInt(match[1]);
  const realm = BigInt(match[2]);
  const num   = BigInt(match[3]);

  const shardHex = shard.toString(16).padStart(8,  "0"); //  4 bytes
  const realmHex = realm.toString(16).padStart(16, "0"); //  8 bytes
  const numHex   = num.toString(16)  .padStart(16, "0"); //  8 bytes

  return `0x${shardHex}${realmHex}${numHex}`;
}

/**
 * Resolves an address string to lowercase EVM format.
 * - Already an EVM address (`0x…`)  → returned as-is (lowercased).
 * - Hedera entity ID (`0.0.N`)      → converted via `hederaIdToEvmAddress`.
 * - Otherwise                       → throws.
 */
export function resolveEvmAddress(input: string): string {
  const trimmed = input.trim();

  if (/^0x[0-9a-fA-F]{40}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (isHederaId(trimmed)) {
    return hederaIdToEvmAddress(trimmed);
  }

  throw new Error(`Cannot resolve to EVM address: ${input}`);
}
