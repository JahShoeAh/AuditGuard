import { describe, it, expect } from "vitest";
import {
  validateEVMAddress,
  validateRiskScore,
  validateLOC,
  validateAccountBalance,
  validateTxHash,
  validateBytecode,
  validateTimestamp,
  validateNonEmptyString,
  validateBudget,
} from "../shared/validation-utils.js";

describe("validation-utils.ts", () => {
  describe("validateEVMAddress", () => {
    it("accepts valid EVM addresses (lowercase)", () => {
      const addr = "0x742d35cc6634c0532925a3b844bc9e7595f0beb0";
      expect(validateEVMAddress(addr)).toBe(addr.toLowerCase());
    });

    it("accepts valid EVM addresses (checksum)", () => {
      const addr = "0x742d35Cc6634C0532925a3b844Bc9e7595f0beb0";
      expect(validateEVMAddress(addr)).toBe(addr.toLowerCase());
    });

    it("normalizes and trims addresses", () => {
      const addr = "  0x742d35cc6634c0532925a3b844bc9e7595f0beb0  ";
      expect(validateEVMAddress(addr)).toBe("0x742d35cc6634c0532925a3b844bc9e7595f0beb0");
    });

    it("rejects non-string values", () => {
      expect(() => validateEVMAddress(123)).toThrow("address must be a string");
      expect(() => validateEVMAddress(null)).toThrow("address must be a string");
      expect(() => validateEVMAddress(undefined)).toThrow("address must be a string");
    });

    it("rejects invalid EVM addresses", () => {
      expect(() => validateEVMAddress("0xinvalid")).toThrow("Invalid EVM address");
      expect(() => validateEVMAddress("not-an-address")).toThrow("Invalid EVM address");
      expect(() => validateEVMAddress("0x123")).toThrow("Invalid EVM address");
    });

    it("uses custom field name in error message", () => {
      expect(() => validateEVMAddress("invalid", "contractAddress")).toThrow(
        "Invalid EVM contractAddress"
      );
    });
  });

  describe("validateRiskScore", () => {
    it("accepts valid risk scores in range [0, 100]", () => {
      expect(validateRiskScore(0)).toBe(0);
      expect(validateRiskScore(50)).toBe(50);
      expect(validateRiskScore(100)).toBe(100);
      expect(validateRiskScore(75.5)).toBe(75.5);
    });

    it("rejects non-number values", () => {
      expect(() => validateRiskScore("50")).toThrow("Risk score must be a finite number");
      expect(() => validateRiskScore(null)).toThrow("Risk score must be a finite number");
      expect(() => validateRiskScore(undefined)).toThrow("Risk score must be a finite number");
    });

    it("rejects non-finite numbers", () => {
      expect(() => validateRiskScore(NaN)).toThrow("Risk score must be a finite number");
      expect(() => validateRiskScore(Infinity)).toThrow("Risk score must be a finite number");
      expect(() => validateRiskScore(-Infinity)).toThrow("Risk score must be a finite number");
    });

    it("rejects scores outside [0, 100] range", () => {
      expect(() => validateRiskScore(-1)).toThrow("Risk score out of range [0, 100]");
      expect(() => validateRiskScore(101)).toThrow("Risk score out of range [0, 100]");
      expect(() => validateRiskScore(-50)).toThrow("Risk score out of range [0, 100]");
      expect(() => validateRiskScore(150)).toThrow("Risk score out of range [0, 100]");
    });
  });

  describe("validateLOC", () => {
    it("accepts valid LOC values and floors to integer", () => {
      expect(validateLOC(100)).toBe(100);
      expect(validateLOC(1000)).toBe(1000);
      expect(validateLOC(100.7)).toBe(100);
      expect(validateLOC(999.999)).toBe(999);
    });

    it("rejects non-number values", () => {
      expect(() => validateLOC("100")).toThrow("LOC must be a finite number");
      expect(() => validateLOC(null)).toThrow("LOC must be a finite number");
    });

    it("rejects non-finite numbers", () => {
      expect(() => validateLOC(NaN)).toThrow("LOC must be a finite number");
      expect(() => validateLOC(Infinity)).toThrow("LOC must be a finite number");
    });

    it("rejects LOC <= 0", () => {
      expect(() => validateLOC(0)).toThrow("LOC out of range (0, 10000000]");
      expect(() => validateLOC(-100)).toThrow("LOC out of range (0, 10000000]");
    });

    it("rejects LOC > 10,000,000", () => {
      expect(() => validateLOC(10_000_001)).toThrow("LOC out of range (0, 10000000]");
      expect(() => validateLOC(100_000_000)).toThrow("LOC out of range (0, 10000000]");
    });
  });

  describe("validateAccountBalance", () => {
    it("accepts valid bigint balances", () => {
      expect(validateAccountBalance(0n)).toBe(0n);
      expect(validateAccountBalance(100n)).toBe(100n);
      expect(validateAccountBalance(BigInt("999999999999999999"))).toBe(BigInt("999999999999999999"));
    });

    it("accepts numeric string balances and converts to bigint", () => {
      expect(validateAccountBalance("0")).toBe(0n);
      expect(validateAccountBalance("12345")).toBe(12345n);
      expect(validateAccountBalance("999999999999999999")).toBe(BigInt("999999999999999999"));
    });

    it("accepts number balances and converts to bigint", () => {
      expect(validateAccountBalance(0)).toBe(0n);
      expect(validateAccountBalance(100)).toBe(100n);
      expect(validateAccountBalance(12345)).toBe(12345n);
    });

    it("rejects negative balances", () => {
      expect(() => validateAccountBalance(-1n)).toThrow("Balance cannot be negative");
      expect(() => validateAccountBalance("-100")).toThrow("Balance cannot be negative");
    });

    it("rejects invalid balance values", () => {
      expect(() => validateAccountBalance("not-a-number")).toThrow("Invalid account balance");
      expect(() => validateAccountBalance(null)).toThrow("Invalid account balance");
      expect(() => validateAccountBalance(undefined)).toThrow("Invalid account balance");
    });
  });

  describe("validateTxHash", () => {
    it("accepts valid transaction hashes", () => {
      const hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      expect(validateTxHash(hash)).toBe(hash);
    });

    it("accepts non-hex strings (generic hash support)", () => {
      expect(validateTxHash("some-generic-hash")).toBe("some-generic-hash");
    });

    it("rejects non-string values", () => {
      expect(() => validateTxHash(123)).toThrow("Transaction hash must be a non-empty string");
      expect(() => validateTxHash(null)).toThrow("Transaction hash must be a non-empty string");
    });

    it("rejects empty strings", () => {
      expect(() => validateTxHash("")).toThrow("Transaction hash must be a non-empty string");
    });

    it("rejects excessively long hashes", () => {
      const longHash = "x".repeat(201);
      expect(() => validateTxHash(longHash)).toThrow("Transaction hash too long");
    });
  });

  describe("validateBytecode", () => {
    it("accepts valid hex bytecode with 0x prefix", () => {
      expect(validateBytecode("0x6060604052")).toBe("0x6060604052");
      expect(validateBytecode("0xabcdef123456")).toBe("0xabcdef123456");
    });

    it("accepts valid hex bytecode without 0x prefix and adds it", () => {
      expect(validateBytecode("6060604052")).toBe("0x6060604052");
      expect(validateBytecode("ABCDEF123456")).toBe("0xabcdef123456");
    });

    it("accepts empty bytecode or 0x", () => {
      expect(validateBytecode("")).toBe("0x");
      expect(validateBytecode("0x")).toBe("0x");
    });

    it("normalizes to lowercase", () => {
      expect(validateBytecode("0xABCDEF123456")).toBe("0xabcdef123456");
    });

    it("rejects non-string values", () => {
      expect(() => validateBytecode(123)).toThrow("Bytecode must be a string");
      expect(() => validateBytecode(null)).toThrow("Bytecode must be a string");
    });

    it("rejects invalid hex characters", () => {
      expect(() => validateBytecode("0xGHIJKL")).toThrow("Bytecode contains invalid hex characters");
      expect(() => validateBytecode("0x12345g")).toThrow("Bytecode contains invalid hex characters");
    });

    it("rejects odd-length bytecode", () => {
      expect(() => validateBytecode("0x123")).toThrow("Bytecode has odd length");
      expect(() => validateBytecode("0xabcde")).toThrow("Bytecode has odd length");
    });
  });

  describe("validateTimestamp", () => {
    it("accepts valid timestamps", () => {
      expect(validateTimestamp(0)).toBe(0);
      expect(validateTimestamp(Date.now())).toBe(Date.now());
      expect(validateTimestamp(1609459200000)).toBe(1609459200000);
    });

    it("rejects non-number values", () => {
      expect(() => validateTimestamp("123")).toThrow("Timestamp must be a finite number");
      expect(() => validateTimestamp(null)).toThrow("Timestamp must be a finite number");
    });

    it("rejects non-finite numbers", () => {
      expect(() => validateTimestamp(NaN)).toThrow("Timestamp must be a finite number");
      expect(() => validateTimestamp(Infinity)).toThrow("Timestamp must be a finite number");
    });

    it("rejects negative timestamps", () => {
      expect(() => validateTimestamp(-1)).toThrow("Timestamp cannot be negative");
      expect(() => validateTimestamp(-1000)).toThrow("Timestamp cannot be negative");
    });
  });

  describe("validateNonEmptyString", () => {
    it("accepts valid non-empty strings", () => {
      expect(validateNonEmptyString("hello")).toBe("hello");
      expect(validateNonEmptyString("  world  ")).toBe("world");
    });

    it("rejects non-string values", () => {
      expect(() => validateNonEmptyString(123)).toThrow("field must be a string");
      expect(() => validateNonEmptyString(null)).toThrow("field must be a string");
    });

    it("rejects empty strings (after trimming)", () => {
      expect(() => validateNonEmptyString("")).toThrow("field cannot be empty");
      expect(() => validateNonEmptyString("   ")).toThrow("field cannot be empty");
    });

    it("rejects strings exceeding maxLength", () => {
      const longString = "x".repeat(1001);
      expect(() => validateNonEmptyString(longString)).toThrow(
        "field exceeds maximum length of 1000"
      );
    });

    it("uses custom field name in error message", () => {
      expect(() => validateNonEmptyString("", "title")).toThrow("title cannot be empty");
      expect(() => validateNonEmptyString(123, "description")).toThrow(
        "description must be a string"
      );
    });

    it("respects custom maxLength", () => {
      expect(validateNonEmptyString("hello", "field", 10)).toBe("hello");
      expect(() => validateNonEmptyString("hello world", "field", 5)).toThrow(
        "field exceeds maximum length of 5"
      );
    });
  });

  describe("validateBudget", () => {
    it("accepts valid positive budgets", () => {
      expect(validateBudget(1)).toBe(1);
      expect(validateBudget(100)).toBe(100);
      expect(validateBudget(999.99)).toBe(999.99);
    });

    it("rejects non-number values", () => {
      expect(() => validateBudget("100")).toThrow("Budget must be a finite number");
      expect(() => validateBudget(null)).toThrow("Budget must be a finite number");
    });

    it("rejects non-finite numbers", () => {
      expect(() => validateBudget(NaN)).toThrow("Budget must be a finite number");
      expect(() => validateBudget(Infinity)).toThrow("Budget must be a finite number");
    });

    it("rejects zero or negative budgets", () => {
      expect(() => validateBudget(0)).toThrow("Budget must be positive");
      expect(() => validateBudget(-100)).toThrow("Budget must be positive");
    });
  });
});
