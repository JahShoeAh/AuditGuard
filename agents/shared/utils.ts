import crypto from "crypto";
import type { ContractType, Severity } from "./types.js";

// ---- Random generators ----

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomBool(probability = 0.5): boolean {
  return Math.random() < probability;
}

export function weightedRandom(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [key, weight] of entries) {
    r -= weight;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ---- Hashing ----

export function hashOf(data: unknown): string {
  return "0x" + crypto.createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
}

// ---- Timing ----

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Mock data helpers ----

const FINDING_TITLES: Record<ContractType, string[]> = {
  lending: [
    "Reentrancy in withdraw()",
    "Oracle manipulation via flash loan",
    "Missing liquidation threshold check",
    "Unchecked return value on token transfer",
    "Interest rate calculation overflow",
    "Collateral ratio bypass via donation",
  ],
  dex: [
    "Slippage protection bypass",
    "Front-running vulnerability in swap()",
    "Incorrect fee calculation",
    "Pool balance manipulation",
    "Missing deadline check",
  ],
  staking: [
    "Reward calculation rounding error",
    "Unstake reentrancy",
    "Missing withdrawal delay",
    "Reward distribution overflow",
  ],
  bridge: [
    "Message replay attack",
    "Insufficient validation of cross-chain proof",
    "Centralized relayer risk",
    "Token mapping inconsistency",
  ],
  vault: [
    "Share price manipulation via donation",
    "Missing slippage check on deposit",
    "Strategy migration rug vector",
    "Unauthorized strategy update",
  ],
  derivatives: [
    "Liquidation threshold bypass",
    "Funding rate manipulation",
    "Position size overflow",
    "Unchecked oracle price staleness",
  ],
  oracle: [
    "Price feed manipulation via flash loan",
    "Missing staleness check on latestRoundData",
    "Single point of failure in price aggregation",
    "Integer overflow in price scaling",
  ],
  governance: [
    "Governance vote manipulation via flash loan",
    "Proposal front-running attack",
    "Insufficient timelock on critical parameters",
    "Missing quorum validation",
  ],
  nft: [
    "Reentrancy in safeTransferFrom callback",
    "Unchecked return value on ERC721 transfer",
    "Royalty bypass via secondary market",
    "Missing access control on minting",
  ],
  unknown: [
    "Reentrancy vulnerability",
    "Unchecked external call return value",
    "Access control misconfiguration",
    "Integer overflow/underflow",
  ],
};

export function randomFindingTitle(contractType: ContractType): string {
  const titles = FINDING_TITLES[contractType] || FINDING_TITLES.lending;
  return randomChoice(titles);
}

export function randomSeverity(): Severity {
  return weightedRandom({
    critical: 0.05,
    high: 0.15,
    medium: 0.4,
    low: 0.35,
    info: 0.05,
  }) as Severity;
}

export function randomSeveritySkewedHigh(): Severity {
  return weightedRandom({
    critical: 0.2,
    high: 0.35,
    medium: 0.3,
    low: 0.1,
    info: 0.05,
  }) as Severity;
}

export function randomSeveritySkewedLow(): Severity {
  return weightedRandom({
    critical: 0.05,
    high: 0.15,
    medium: 0.4,
    low: 0.35,
    info: 0.05,
  }) as Severity;
}
