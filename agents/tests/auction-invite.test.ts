import { describe, expect, it, vi } from "vitest";

vi.mock("@0glabs/0g-serving-broker", () => ({
  createZGComputeNetworkBroker: vi.fn().mockResolvedValue({
    inference: {
      getServiceMetadata: vi.fn().mockResolvedValue({ endpoint: "http://mock", model: "mock-model" }),
      getRequestHeaders: vi.fn().mockResolvedValue({ "X-0G-Auth": "mock" }),
      acknowledgeProviderSigner: vi.fn().mockResolvedValue(undefined),
      listService: vi.fn().mockResolvedValue([]),
    },
    ledger: { depositFund: vi.fn().mockResolvedValue(undefined) },
  }),
}));

describe("Agent AUCTION_INVITE handling", () => {
  it("shared bid policy enforces collateral floor and budget cap", async () => {
    const { computeLiveBid } = await import("../shared/bid-policy.js");
    const result = computeLiveBid(
      { amount: 120, collateral: 12, estimatedTimeSec: 60 },
      80,
      { minCollateralGuard: 50, collateralBufferGuard: 0, enforceBudgetCap: true }
    );

    expect(result.skip).toBeUndefined();
    expect(result.bid).toBeDefined();
    expect(result.bid?.amount).toBe(80);
    expect(result.bid?.collateral).toBe(50);
  });

  it("shared bid policy skips when invite budget is not positive", async () => {
    const { computeLiveBid } = await import("../shared/bid-policy.js");
    const result = computeLiveBid(
      { amount: 10, collateral: 5, estimatedTimeSec: 60 },
      0,
      { minCollateralGuard: 50, collateralBufferGuard: 0, enforceBudgetCap: true }
    );

    expect(result.bid).toBeUndefined();
    expect(result.skip?.reasonCode).toBe("invalid_budget");
  });

  it("static-analysis resolves invite payload without discovery queue", async () => {
    const { resolveAuctionInviteContext, calculateBid } = await import("../static-analysis/index.js");
    const resolved = resolveAuctionInviteContext({
      invite: { contractType: "vault", riskScore: "72", estimatedLineCount: "2300" },
    });

    expect(resolved.contractType).toBe("vault");
    expect(resolved.riskScore).toBe(72);
    expect(resolved.loc).toBe(2300);
    expect(calculateBid(resolved.loc, resolved.contractType, resolved.riskScore)).not.toBeNull();
  });

  it("fuzzer prefers queued discovery data when both are present", async () => {
    const { resolveAuctionInviteContext, calculateBid } = await import("../fuzzer/index.js");
    const resolved = resolveAuctionInviteContext({
      queued: { contractType: "bridge", loc: 1800 },
      invite: { contractType: "dex", riskScore: 88, estimatedLOC: 4000 },
    });

    expect(resolved.contractType).toBe("bridge");
    expect(resolved.loc).toBe(1800);
    expect(resolved.riskScore).toBe(88);
    expect(calculateBid(resolved.loc, resolved.contractType, resolved.riskScore)).not.toBeNull();
  });

  it("llm-contextual bids from invite fallback when risk and loc meet thresholds", async () => {
    const { resolveAuctionInviteContext, shouldBid, calculateBid } = await import("../llm-contextual/index.js");
    const resolved = resolveAuctionInviteContext({
      invite: { contractType: "lending", riskScore: "80", estimatedLOC: "3000" },
    });

    expect(shouldBid(resolved.loc, resolved.contractType, resolved.riskScore)).toBe(true);
    const bid = calculateBid(resolved.loc, resolved.contractType, resolved.riskScore);
    expect(bid.amount).toBeGreaterThan(0);
    expect(bid.collateral).toBeGreaterThan(0);
  });

  it("llm-contextual skips invite when fallback risk/loc are below thresholds", async () => {
    const { resolveAuctionInviteContext, shouldBid } = await import("../llm-contextual/index.js");
    const resolved = resolveAuctionInviteContext({
      invite: { contractType: "dex", riskScore: 25, estimatedLOC: 900 },
    });

    expect(shouldBid(resolved.loc, resolved.contractType, resolved.riskScore)).toBe(false);
  });
});
