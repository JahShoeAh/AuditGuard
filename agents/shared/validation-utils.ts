import { ethers } from "ethers";

/**
 * Validates that a value is a valid EVM address.
 * Throws if invalid, returns normalized (lowercase, trimmed) address if valid.
 */
export function validateEVMAddress(address: unknown, fieldName = "address"): string {
  if (typeof address !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = address.toLowerCase().trim();
  if (!ethers.isAddress(normalized)) {
    throw new Error(`Invalid EVM ${fieldName}: ${address}`);
  }
  return normalized;
}

/**
 * Validates that a risk score is a finite number in the range [0, 100].
 * Throws if invalid, returns the score if valid.
 */
export function validateRiskScore(score: unknown): number {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error("Risk score must be a finite number");
  }
  if (score < 0 || score > 100) {
    throw new Error(`Risk score out of range [0, 100]: ${score}`);
  }
  return score;
}

/**
 * Validates that lines of code (LOC) is a finite positive number within reasonable bounds.
 * Throws if invalid, returns floored integer LOC if valid.
 */
export function validateLOC(loc: unknown): number {
  if (typeof loc !== "number" || !Number.isFinite(loc)) {
    throw new Error("LOC must be a finite number");
  }
  if (loc <= 0 || loc > 10_000_000) {
    throw new Error(`LOC out of range (0, 10000000]: ${loc}`);
  }
  return Math.floor(loc);
}

/**
 * Validates that an account balance is a non-negative bigint.
 * Throws if invalid, returns bigint balance if valid.
 */
export function validateAccountBalance(balance: unknown): bigint {
  try {
    const bn = BigInt(balance as string | number | bigint);
    if (bn < 0n) {
      throw new Error("Balance cannot be negative");
    }
    return bn;
  } catch (err) {
    // Check if error is from negative balance check
    if (err instanceof Error && err.message === "Balance cannot be negative") {
      throw err;
    }
    throw new Error(`Invalid account balance: ${balance}`);
  }
}

/**
 * Validates that a transaction hash is a non-empty string of reasonable length.
 * Throws if invalid, returns the hash if valid.
 */
export function validateTxHash(hash: unknown): string {
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("Transaction hash must be a non-empty string");
  }
  if (hash.length > 200) {
    throw new Error("Transaction hash too long");
  }
  return hash;
}

/**
 * Validates that bytecode is a valid hex string (with or without 0x prefix).
 * Throws if invalid, returns normalized bytecode (with 0x prefix) if valid.
 */
export function validateBytecode(bytecode: unknown): string {
  if (typeof bytecode !== "string") {
    throw new Error("Bytecode must be a string");
  }

  const normalized = bytecode.toLowerCase().trim();

  // Empty bytecode or "0x" are valid (EOA or undeployed contract)
  if (normalized === "" || normalized === "0x") {
    return "0x";
  }

  // Check if it's a valid hex string
  const withoutPrefix = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
  if (!/^[0-9a-f]*$/.test(withoutPrefix)) {
    throw new Error("Bytecode contains invalid hex characters");
  }

  // Bytecode should have even length (each byte = 2 hex chars)
  if (withoutPrefix.length % 2 !== 0) {
    throw new Error("Bytecode has odd length");
  }

  return `0x${withoutPrefix}`;
}

/**
 * Validates that a timestamp is a non-negative finite number.
 * Throws if invalid, returns the timestamp if valid.
 */
export function validateTimestamp(timestamp: unknown): number {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error("Timestamp must be a finite number");
  }
  if (timestamp < 0) {
    throw new Error("Timestamp cannot be negative");
  }
  return timestamp;
}

/**
 * Validates that a string is non-empty and within reasonable length bounds.
 * Throws if invalid, returns trimmed string if valid.
 */
export function validateNonEmptyString(value: unknown, fieldName = "field", maxLength = 1000): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  return trimmed;
}

/**
 * Validates that a budget is a positive finite number.
 * Throws if invalid, returns the budget if valid.
 */
export function validateBudget(budget: unknown): number {
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    throw new Error("Budget must be a finite number");
  }
  if (budget <= 0) {
    throw new Error("Budget must be positive");
  }
  return budget;
}
