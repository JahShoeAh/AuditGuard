import { describe, expect, it } from "vitest";
import { inferBaselineContractType } from "../scanner/baseline-contract-type.js";

describe("inferBaselineContractType", () => {
  it("returns unknown when bytecode is missing", () => {
    expect(inferBaselineContractType({ bytecode: null })).toBe("unknown");
    expect(inferBaselineContractType({ bytecode: "" })).toBe("unknown");
  });

  it("classifies dex contracts from swap/liquidity selectors", () => {
    const bytecode = "0x6000600038ed17397ff36ab5e8e33700";
    expect(inferBaselineContractType({ bytecode })).toBe("dex");
  });

  it("classifies bridge contracts from bridge selectors", () => {
    const bytecode = "0x600060000f5287b0a44bbb153805550f";
    expect(inferBaselineContractType({ bytecode })).toBe("bridge");
  });

  it("classifies staking contracts from staking selectors", () => {
    const bytecode = "0x60006000a694fc3a2e17de785c19a95c";
    expect(inferBaselineContractType({ bytecode })).toBe("staking");
  });

  it("maps ERC20-like selector set to lending fallback", () => {
    const bytecode = "0x18160ddd70a08231a9059cbb23b872dd095ea7b3";
    expect(inferBaselineContractType({ bytecode })).toBe("lending");
  });

  it("maps NFT-like selector set to nft type", () => {
    const bytecode = "0x6352211e42842e0ec87b56dd";
    expect(inferBaselineContractType({ bytecode })).toBe("nft");
  });

  it("uses lending as deterministic fallback when no hints match", () => {
    const bytecode = "0x6080604052348015600f57600080fd5b";
    expect(inferBaselineContractType({ bytecode })).toBe("lending");
  });
});

