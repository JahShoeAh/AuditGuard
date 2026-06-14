import { describe, it, expect } from "vitest";
import {
  BidDeadlineExpiredError,
  InsufficientCollateralError,
  ContractCallError,
  ValidationError,
} from "../shared/errors.js";

describe("Error classes", () => {
  it("BidDeadlineExpiredError has correct name and message", () => {
    const error = new BidDeadlineExpiredError();
    expect(error.name).toBe("BidDeadlineExpiredError");
    expect(error.message).toBe("Bid deadline has passed");
    expect(error instanceof Error).toBe(true);
  });

  it("BidDeadlineExpiredError accepts custom message", () => {
    const error = new BidDeadlineExpiredError("Custom deadline message");
    expect(error.message).toBe("Custom deadline message");
  });

  it("InsufficientCollateralError has correct name and message", () => {
    const error = new InsufficientCollateralError();
    expect(error.name).toBe("InsufficientCollateralError");
    expect(error.message).toBe("Insufficient collateral");
    expect(error instanceof Error).toBe(true);
  });

  it("ContractCallError stores original error", () => {
    const originalError = new Error("Original");
    const error = new ContractCallError("Wrapped error", originalError);
    expect(error.name).toBe("ContractCallError");
    expect(error.message).toBe("Wrapped error");
    expect(error.originalError).toBe(originalError);
  });

  it("ValidationError has correct name", () => {
    const error = new ValidationError("Invalid input");
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("Invalid input");
  });

  it("errors can be caught with instanceof", () => {
    const error = new BidDeadlineExpiredError();

    try {
      throw error;
    } catch (err) {
      expect(err instanceof BidDeadlineExpiredError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});
