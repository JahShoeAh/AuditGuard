import { describe, it, expect } from "vitest";
import { normalizeBidFailureReasonCode } from "../shared/bid-policy.js";

describe("bid-policy failure normalization", () => {
  it("maps Hedera payer low-funds error to insufficient_payer_hbar", () => {
    const err = "server response 400 Bad Request ... Insufficient funds for transfer ...";
    expect(normalizeBidFailureReasonCode(err)).toBe("insufficient_payer_hbar");
  });

  it("still maps generic insufficient funds errors", () => {
    const err = "execution reverted: insufficient funds";
    expect(normalizeBidFailureReasonCode(err)).toBe("insufficient_funds");
  });

  it("keeps nonce conflicts distinct", () => {
    const err = "Nonce too low. Provided nonce: 194, current nonce: 195";
    expect(normalizeBidFailureReasonCode(err)).toBe("nonce_conflict");
  });
});
