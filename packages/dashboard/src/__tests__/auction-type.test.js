import { describe, expect, it } from "vitest";
import {
  auctionTypeColor,
  auctionTypeLabel,
  normalizeAuctionType,
} from "../utils/auction-type";

describe("auction type normalization", () => {
  it("maps extended canonical values used across agents/orchestrator", () => {
    expect(normalizeAuctionType("nft")).toBe("nft");
    expect(normalizeAuctionType("oracle")).toBe("oracle");
    expect(normalizeAuctionType("governance")).toBe("governance");
    expect(normalizeAuctionType("derivatives")).toBe("derivatives");
  });

  it("normalizes separator/case variants before lookup", () => {
    expect(normalizeAuctionType("Cross-Chain Bridge")).toBe("bridge");
    expect(normalizeAuctionType("LENDING PROTOCOL")).toBe("lending");
    expect(normalizeAuctionType("non-fungible token")).toBe("nft");
    expect(normalizeAuctionType("price-oracle")).toBe("oracle");
  });

  it("returns UNKNOWN styling for unrecognized values", () => {
    expect(normalizeAuctionType("something_new")).toBe("unknown");
    expect(auctionTypeLabel("something_new")).toBe("UNKNOWN");
    expect(auctionTypeColor("something_new")).toBe("var(--accent-amber)");
  });
});
