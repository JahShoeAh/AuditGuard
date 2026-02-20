/**
 * Comprehensive offline tests for the classifier & risk assessment pipeline.
 *
 * Covers:
 *   BLOCK 1 — contract-classifier.ts  (evmdecoder + DeFi mapping)
 *   BLOCK 2 — source-retriever.ts     (Sourcify + bytecode fallback)
 *   BLOCK 3 — risk-prompt.ts          (prompt builders + response parser)
 *   BLOCK 4 — risk-blender.ts         (scoring functions + weighted blend)
 *   BLOCK 5 — risk-inference.ts       (0g → Claude failover + assessRisk)
 *   BLOCK 6 — risk-inference.ts       (health-check loop)
 *   BLOCK 7 — scanner integration     (pipeline + discovery event shape)
 *
 * All tests use vi.mock / vi.fn — zero real network calls.
 * Live tests behind LIVE_CLASSIFIER_TEST=true env flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Ethers mock (used by source-retriever + risk-inference) ──────────────────

const ethersProviderMock = {
  getCode: vi.fn().mockResolvedValue("0x6080604052348015600f57600080fd"),
};

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockReturnValue(ethersProviderMock),
    Wallet: vi.fn().mockReturnValue({ address: "0xMOCKWALLET" }),
  },
}));

// ─── evmdecoder mock ──────────────────────────────────────────────────────────

const mockContractInfoFn = vi.fn();
const mockInitializeFn = vi.fn().mockResolvedValue(undefined);

vi.mock("evmdecoder", () => ({
  EvmDecoder: vi.fn().mockImplementation(() => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn,
  })),
}));

// ─── 0g broker mock ───────────────────────────────────────────────────────────

const mockBrokerInference = {
  getServiceMetadata: vi.fn().mockResolvedValue({
    endpoint: "https://mock-0g-provider.ai",
    model: "qwen-2.5-7b-instruct",
  }),
  getRequestHeaders: vi.fn().mockResolvedValue({
    "X-0G-Auth": "mock-signed-header",
    "X-0G-Nonce": "99999",
  }),
  acknowledgeProviderSigner: vi.fn().mockResolvedValue(undefined),
  processResponse: vi.fn().mockResolvedValue(true),
};

const mockBrokerLedger = {
  getLedger: vi.fn().mockResolvedValue({
    availableBalance: BigInt("1000000000000000000"),
    totalBalance: BigInt("1000000000000000000"),
  }),
  depositFund: vi.fn().mockResolvedValue(undefined),
};

const mockBroker = {
  inference: mockBrokerInference,
  ledger: mockBrokerLedger,
};

vi.mock("@0glabs/0g-serving-broker", () => ({
  createZGComputeNetworkBroker: vi.fn().mockResolvedValue(mockBroker),
}));

// ─── @anthropic-ai/sdk mock ───────────────────────────────────────────────────

const mockClaudeCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  })),
}));

// ─── Shared infrastructure mocks ─────────────────────────────────────────────

vi.mock("../shared/index.js", () => ({
  CONFIG: {
    network: "testnet",
    strictLive: false,
    guardToken: { id: "0.0.1", evmAddress: "0x0" },
    hcsTopics: { discovery: "0.0.1", auditLog: "0.0.2", agentComms: "0.0.3" },
    contracts: {},
    inftCollections: {},
    settlementPreFunded: 500,
    demoVault: { address: "0xdead", weeklyMonitoring: 10, criticalBounty: 50 },
    testContracts: [
      {
        key: "test-vault",
        address: "0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        deployer: "0xdeadbeef00000000000000000000000000000001",
      },
    ],
    zgInference: {
      rpcUrl: "https://evmrpc-testnet.0g.ai",
      providerAddress: "",
      model: "qwen-2.5-7b-instruct",
      timeoutMs: 30000,
      depositAmount: 5,
      requiredInLive: false,
      enabled: true,
    },
  },
  getAgentEnv: vi.fn().mockReturnValue({ accountId: "0.0.1", privateKey: "0x01" }),
  createAgentLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createAgentWallet: vi.fn().mockReturnValue({
    evmAddress: "0xMOCK",
    hederaClient: {},
    evmWallet: {},
  }),
  HCSClient: vi.fn().mockImplementation(() => ({
    publishAuditLog: vi.fn().mockResolvedValue(undefined),
    publishDiscovery: vi.fn().mockResolvedValue(undefined),
    subscribeDiscovery: vi.fn(),
    subscribeAgentComms: vi.fn(),
  })),
  ContractClient: vi.fn().mockImplementation(() => ({
    submitBid: vi.fn(),
    createListing: vi.fn().mockResolvedValue({ wait: vi.fn() }),
    isActiveAgent: vi.fn().mockResolvedValue(false),
    agentRegistry: { target: "0x0000000000000000000000000000000000000001" },
    dataMarketplace: { agentRegistry: vi.fn(), owner: vi.fn(), setAgentRegistry: vi.fn() },
    wallet: {},
  })),
  ListingCategory: { HOT_LEAD: 2 },
  normalizeBidFailureReasonCode: vi.fn().mockReturnValue("unknown"),
  randomInt: (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1)),
  randomFloat: (min: number, max: number) => min + Math.random() * (max - min),
  randomBool: (prob: number) => Math.random() < prob,
  randomChoice: (arr: any[]) => arr[0],
  randomHex: (n: number) => "0".repeat(n * 2),
  hashOf: (_: any) => "0xmockhash",
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/config.js", () => ({
  CONFIG: {
    network: "testnet",
    strictLive: false,
    hcsTopics: { discovery: "0.0.1", auditLog: "0.0.2", agentComms: "0.0.3" },
    contracts: {},
    testContracts: [
      {
        key: "test-vault",
        address: "0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        deployer: "0xdeadbeef00000000000000000000000000000001",
      },
    ],
    zgInference: {
      rpcUrl: "https://evmrpc-testnet.0g.ai",
      providerAddress: "",
      model: "qwen-2.5-7b-instruct",
      timeoutMs: 30000,
      depositAmount: 5,
      requiredInLive: false,
      enabled: true,
    },
  },
  getAgentEnv: vi.fn().mockReturnValue({ accountId: "0.0.1", privateKey: "0x01" }),
  SDK_CONFIG_FILE: "/tmp/fake-config.json",
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical valid LLM risk response JSON string */
const validRiskJson = JSON.stringify({
  overallRisk: 65,
  dimensions: {
    technicalVulnerabilities: 70,
    designAndLogicFlaws: 55,
    externalDependencies: 80,
    operationalRisks: 45,
    marketGovernanceRisks: 60,
  },
  rationale: "High oracle dependency with moderate access controls.",
  topRiskFactors: [
    "Chainlink oracle single point of failure",
    "No timelock on admin functions",
    "Unbounded loop in liquidation",
  ],
});

function makeRiskCtx(overrides: Record<string, any> = {}) {
  return {
    contractAddress: "0xaabbccddeeff00112233445566778899aabbccdd",
    defiCategory: "lending" as const,
    evmType: "Token",
    standards: ["ERC20"],
    estimatedLOC: 800,
    hasSource: false,
    sourceCode: null,
    bytecode: "0x6080604052",
    proxyTarget: null,
    ...overrides,
  };
}

const mockLog = { info: vi.fn(), warn: vi.fn() };

// =========================================================================
// BLOCK 1: contract-classifier.ts — evmdecoder + DeFi mapping (13 tests)
// =========================================================================

describe("contract-classifier.ts", () => {
  beforeEach(() => {
    mockContractInfoFn.mockReset();
    mockInitializeFn.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { _resetDecoder } = await import("../scanner/contract-classifier.js");
    _resetDecoder();
    vi.clearAllMocks();
    delete process.env.SCANNER_EVM_RPC_URL;
  });

  it("initializes EvmDecoder singleton on first call", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
      contractName: "USDC",
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    await classifyContract("0x" + "a".repeat(40));
    expect(mockInitializeFn).toHaveBeenCalledOnce();
  });

  it("does NOT reinitialize decoder on subsequent calls", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    await classifyContract("0x" + "a".repeat(40));
    await classifyContract("0x" + "b".repeat(40));
    expect(mockInitializeFn).toHaveBeenCalledOnce();
  });

  it("returns EOA result with defiCategory=lending when isContract=false", async () => {
    mockContractInfoFn.mockResolvedValue({ isContract: false });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "1".repeat(40));
    expect(result.isContract).toBe(false);
    expect(result.evmType).toBe("EOA");
    expect(result.defiCategory).toBe("lending");
    expect(result.standards).toEqual([]);
  });

  it("maps ERC3156 standard → lending", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20", "ERC3156"] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "2".repeat(40));
    expect(result.defiCategory).toBe("lending");
  });

  it("maps GnosisSafe evmType → vault", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "GnosisSafe", standards: [] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "3".repeat(40));
    expect(result.defiCategory).toBe("vault");
  });

  it("maps diamond evmType → vault", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Diamond", standards: ["ERC2535"] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "4".repeat(40));
    expect(result.defiCategory).toBe("vault");
  });

  it("maps ERC721 standard → vault", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "NFT", standards: ["ERC721"] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "5".repeat(40));
    expect(result.defiCategory).toBe("vault");
  });

  it("maps ERC1155 standard → vault", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "NFT", standards: ["ERC1155"] },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "6".repeat(40));
    expect(result.defiCategory).toBe("vault");
  });

  it("uses DEX function selector in bytecode → dex", async () => {
    // 0x38ed1739 = swapExactTokensForTokens
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
      bytecode: "0x60806040" + "38ed1739" + "deadbeef",
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "7".repeat(40));
    expect(result.defiCategory).toBe("dex");
  });

  it("uses staking function selector in bytecode → staking", async () => {
    // 0xa694fc3a = stake
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
      bytecode: "0x60806040" + "a694fc3a" + "2e17de78",
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "8".repeat(40));
    expect(result.defiCategory).toBe("staking");
  });

  it("uses bridge function selector in bytecode → bridge", async () => {
    // 0x0f5287b0 = bridgeOut
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
      bytecode: "0x60806040" + "0f5287b0" + "3805550f",
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "9".repeat(40));
    expect(result.defiCategory).toBe("bridge");
  });

  it("defaults to lending when no standards, no selectors, unknown evmType", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "unknown", standards: [] },
      bytecode: "0xdeadbeef",
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "f".repeat(40));
    expect(result.defiCategory).toBe("lending");
  });

  it("extracts proxyTarget from last proxy entry", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: {
        name: "Proxy",
        standards: ["ERC1967"],
        proxies: [
          { address: "0xproxy1", standard: "ERC1967", target: "0ximpl1" },
          { address: "0xproxy2", standard: "ERC1967", target: "0ximpl2" },
        ],
      },
    });
    const { classifyContract } = await import("../scanner/contract-classifier.js");
    const result = await classifyContract("0x" + "e".repeat(40));
    expect(result.proxyTarget).toBe("0ximpl2");
    expect(result.isContract).toBe(true);
  });

  it("_resetDecoder() allows re-initialization on next call", async () => {
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20"] },
    });
    const { classifyContract, _resetDecoder } = await import("../scanner/contract-classifier.js");
    await classifyContract("0x" + "a".repeat(40));
    expect(mockInitializeFn).toHaveBeenCalledOnce();
    _resetDecoder();
    await classifyContract("0x" + "b".repeat(40));
    expect(mockInitializeFn).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// BLOCK 2: source-retriever.ts — Sourcify + bytecode (9 tests)
// =========================================================================

describe("source-retriever.ts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    ethersProviderMock.getCode.mockReset().mockResolvedValue("0x6080604052348015600f57600080fd5b5060405161");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("returns sourcify_full when full match succeeds", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { path: "contracts/MyToken.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract MyToken {}" },
        ]),
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "a".repeat(40), "https://mock-rpc.io/api");
    expect(result.hasSource).toBe(true);
    expect(result.sourceOrigin).toBe("sourcify_full");
    expect(result.sourceCode).toContain("pragma solidity");
  });

  it("falls back to sourcify_partial when full match 404s", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // full match: 404
        return Promise.resolve({ ok: false, status: 404 });
      }
      // partial match: 200 with sol file
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { path: "contracts/Vault.sol", content: "pragma solidity ^0.8.0; contract Vault {}" },
          ]),
      });
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "b".repeat(40), "https://mock-rpc.io/api");
    expect(result.hasSource).toBe(true);
    expect(result.sourceOrigin).toBe("sourcify_partial");
  });

  it("returns bytecode_only when both Sourcify endpoints 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "c".repeat(40), "https://mock-rpc.io/api");
    expect(result.hasSource).toBe(false);
    expect(result.sourceCode).toBeNull();
    expect(result.sourceOrigin).toBe("bytecode_only");
  });

  it("always returns bytecode from RPC regardless of Sourcify result", async () => {
    const fakeBytecode = "0x6080604052aabbccdd";
    ethersProviderMock.getCode.mockResolvedValue(fakeBytecode);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "d".repeat(40), "https://mock-rpc.io/api");
    expect(result.bytecode).toBe(fakeBytecode);
  });

  it("returns bytecode=0x when RPC getCode throws", async () => {
    ethersProviderMock.getCode.mockRejectedValue(new Error("RPC offline"));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "e".repeat(40), "https://mock-rpc.io/api");
    expect(result.bytecode).toBe("0x");
    expect(result.hasSource).toBe(false);
  });

  it("filters out /interfaces/ paths from Sourcify file list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { path: "contracts/interfaces/IVault.sol", content: "interface IVault {}" },
          { path: "contracts/Vault.sol", content: "contract Vault {}" },
        ]),
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "f".repeat(40), "https://mock-rpc.io/api");
    expect(result.sourceCode).toBe("contract Vault {}");
  });

  it("filters out /libraries/ paths from Sourcify file list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { path: "contracts/libraries/SafeMath.sol", content: "library SafeMath {}" },
          { path: "contracts/Token.sol", content: "contract Token {}" },
        ]),
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "0".repeat(40), "https://mock-rpc.io/api");
    expect(result.sourceCode).toBe("contract Token {}");
  });

  it("picks the largest .sol file by content length", async () => {
    const small = "contract A {}";
    const large = "contract B {" + "// comment\n".repeat(200) + "}";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { path: "A.sol", content: small },
          { path: "B.sol", content: large },
        ]),
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "1".repeat(40), "https://mock-rpc.io/api");
    expect(result.sourceCode).toBe(large);
  });

  it("returns bytecode_only when Sourcify returns empty array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource("0x" + "2".repeat(40), "https://mock-rpc.io/api");
    expect(result.hasSource).toBe(false);
    expect(result.sourceOrigin).toBe("bytecode_only");
  });
});

// =========================================================================
// BLOCK 3: risk-prompt.ts — builders + parser (13 tests)
// =========================================================================

describe("risk-prompt.ts", () => {
  it("buildRiskSystemPrompt() includes all 5 dimension names", async () => {
    const { buildRiskSystemPrompt } = await import("../scanner/risk-prompt.js");
    const prompt = buildRiskSystemPrompt();
    expect(prompt).toContain("technicalVulnerabilities");
    expect(prompt).toContain("designAndLogicFlaws");
    expect(prompt).toContain("externalDependencies");
    expect(prompt).toContain("operationalRisks");
    expect(prompt).toContain("marketGovernanceRisks");
  });

  it("buildRiskSystemPrompt() instructs JSON-only response", async () => {
    const { buildRiskSystemPrompt } = await import("../scanner/risk-prompt.js");
    const prompt = buildRiskSystemPrompt();
    expect(prompt).toContain("valid JSON only");
  });

  it("buildRiskSystemPrompt() includes overallRisk in response format", async () => {
    const { buildRiskSystemPrompt } = await import("../scanner/risk-prompt.js");
    const prompt = buildRiskSystemPrompt();
    expect(prompt).toContain("overallRisk");
  });

  it("buildRiskSystemPrompt() references topRiskFactors field", async () => {
    const { buildRiskSystemPrompt } = await import("../scanner/risk-prompt.js");
    const prompt = buildRiskSystemPrompt();
    expect(prompt).toContain("topRiskFactors");
  });

  it("buildRiskUserPrompt() includes contractAddress", async () => {
    const { buildRiskUserPrompt } = await import("../scanner/risk-prompt.js");
    const ctx = makeRiskCtx({ contractAddress: "0xdeadbeef12345678901234567890123456789012" });
    const prompt = buildRiskUserPrompt(ctx);
    expect(prompt).toContain("0xdeadbeef12345678901234567890123456789012");
  });

  it("buildRiskUserPrompt() includes defiCategory in prompt", async () => {
    const { buildRiskUserPrompt } = await import("../scanner/risk-prompt.js");
    const ctx = makeRiskCtx({ defiCategory: "bridge" });
    const prompt = buildRiskUserPrompt(ctx);
    expect(prompt).toContain("bridge");
  });

  it("buildRiskUserPrompt() includes estimatedLOC", async () => {
    const { buildRiskUserPrompt } = await import("../scanner/risk-prompt.js");
    const ctx = makeRiskCtx({ estimatedLOC: 3456 });
    const prompt = buildRiskUserPrompt(ctx);
    expect(prompt).toContain("3456");
  });

  it("buildRiskUserPrompt() includes Solidity source when hasSource=true", async () => {
    const { buildRiskUserPrompt } = await import("../scanner/risk-prompt.js");
    const ctx = makeRiskCtx({
      hasSource: true,
      sourceCode: "pragma solidity ^0.8.0; contract Test {}",
    });
    const prompt = buildRiskUserPrompt(ctx);
    expect(prompt).toContain("pragma solidity");
    expect(prompt).toContain("```solidity");
  });

  it("buildRiskUserPrompt() includes bytecode snippet when hasSource=false", async () => {
    const { buildRiskUserPrompt } = await import("../scanner/risk-prompt.js");
    const ctx = makeRiskCtx({
      hasSource: false,
      sourceCode: null,
      bytecode: "0x6080604052aabbccdd",
    });
    const prompt = buildRiskUserPrompt(ctx);
    expect(prompt).toContain("Bytecode");
  });

  it("buildRiskMessages() returns exactly 2 messages", async () => {
    const { buildRiskMessages } = await import("../scanner/risk-prompt.js");
    const messages = buildRiskMessages(makeRiskCtx());
    expect(messages).toHaveLength(2);
  });

  it("buildRiskMessages() has correct role values", async () => {
    const { buildRiskMessages } = await import("../scanner/risk-prompt.js");
    const messages = buildRiskMessages(makeRiskCtx());
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("parseRiskResponse() returns null for empty string", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    expect(parseRiskResponse("")).toBeNull();
    expect(parseRiskResponse("   ")).toBeNull();
  });

  it("parseRiskResponse() returns null for invalid JSON", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    expect(parseRiskResponse("not json at all")).toBeNull();
  });

  it("parseRiskResponse() parses valid JSON correctly", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const result = parseRiskResponse(validRiskJson);
    expect(result).not.toBeNull();
    expect(result!.overallRisk).toBe(65);
    expect(result!.dimensions.technicalVulnerabilities).toBe(70);
    expect(result!.dimensions.externalDependencies).toBe(80);
    expect(result!.topRiskFactors).toHaveLength(3);
    expect(result!.rationale).toContain("oracle");
  });

  it("parseRiskResponse() strips markdown fences before parsing", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const fenced = "```json\n" + validRiskJson + "\n```";
    const result = parseRiskResponse(fenced);
    expect(result).not.toBeNull();
    expect(result!.overallRisk).toBe(65);
  });

  it("parseRiskResponse() clamps overallRisk > 100 to 100", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const raw = JSON.stringify({
      overallRisk: 150,
      dimensions: {
        technicalVulnerabilities: 200,
        designAndLogicFlaws: 50,
        externalDependencies: 50,
        operationalRisks: 50,
        marketGovernanceRisks: 50,
      },
      rationale: "Test",
      topRiskFactors: [],
    });
    const result = parseRiskResponse(raw);
    expect(result!.overallRisk).toBe(100);
    expect(result!.dimensions.technicalVulnerabilities).toBe(100);
  });

  it("parseRiskResponse() clamps negative scores to 0", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const raw = JSON.stringify({
      overallRisk: -10,
      dimensions: {
        technicalVulnerabilities: -50,
        designAndLogicFlaws: 50,
        externalDependencies: 50,
        operationalRisks: 50,
        marketGovernanceRisks: 50,
      },
      rationale: "Test",
      topRiskFactors: [],
    });
    const result = parseRiskResponse(raw);
    expect(result!.overallRisk).toBe(0);
    expect(result!.dimensions.technicalVulnerabilities).toBe(0);
  });

  it("parseRiskResponse() returns null when dimensions object is missing", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const raw = JSON.stringify({ overallRisk: 60, rationale: "Test", topRiskFactors: [] });
    expect(parseRiskResponse(raw)).toBeNull();
  });

  it("parseRiskResponse() defaults non-finite dimension to 50", async () => {
    const { parseRiskResponse } = await import("../scanner/risk-prompt.js");
    const raw = JSON.stringify({
      overallRisk: 60,
      dimensions: {
        technicalVulnerabilities: "NaN",
        designAndLogicFlaws: 50,
        externalDependencies: 50,
        operationalRisks: 50,
        marketGovernanceRisks: 50,
      },
      rationale: "Test",
      topRiskFactors: [],
    });
    const result = parseRiskResponse(raw);
    expect(result!.dimensions.technicalVulnerabilities).toBe(50);
  });
});

// =========================================================================
// BLOCK 4: risk-blender.ts — scoring functions + blend (12 tests)
// =========================================================================

describe("risk-blender.ts", () => {
  afterEach(() => {
    delete process.env.RISK_WEIGHT_LLM;
    delete process.env.RISK_WEIGHT_BYTECODE;
    delete process.env.RISK_WEIGHT_TYPE;
    delete process.env.RISK_WEIGHT_PROXY;
    delete process.env.RISK_WEIGHT_SIZE;
  });

  it("scoreBytecodeComplexity() returns 35 for empty bytecode (< 200 bytes)", async () => {
    const { scoreBytecodeComplexity } = await import("../scanner/risk-blender.js");
    expect(scoreBytecodeComplexity("0x" + "ff".repeat(50))).toBe(35);
  });

  it("scoreBytecodeComplexity() returns 30 for small contract (< 1000 bytes)", async () => {
    const { scoreBytecodeComplexity } = await import("../scanner/risk-blender.js");
    expect(scoreBytecodeComplexity("0x" + "ff".repeat(500))).toBe(30);
  });

  it("scoreBytecodeComplexity() returns 60 for large contract (< 15000 bytes)", async () => {
    const { scoreBytecodeComplexity } = await import("../scanner/risk-blender.js");
    expect(scoreBytecodeComplexity("0x" + "ff".repeat(10_000))).toBe(60);
  });

  it("scoreBytecodeComplexity() returns 85 for massive contract (> 30000 bytes)", async () => {
    const { scoreBytecodeComplexity } = await import("../scanner/risk-blender.js");
    expect(scoreBytecodeComplexity("0x" + "ff".repeat(40_000))).toBe(85);
  });

  it("scoreCodeSize() returns 25 for tiny contract (< 200 LOC)", async () => {
    const { scoreCodeSize } = await import("../scanner/risk-blender.js");
    expect(scoreCodeSize(100)).toBe(25);
  });

  it("scoreCodeSize() returns 88 for huge contract (>= 10000 LOC)", async () => {
    const { scoreCodeSize } = await import("../scanner/risk-blender.js");
    expect(scoreCodeSize(12000)).toBe(88);
  });

  it("scoreProxyRisk() returns 10 for non-proxy", async () => {
    const { scoreProxyRisk } = await import("../scanner/risk-blender.js");
    expect(scoreProxyRisk(false, [])).toBe(10);
  });

  it("scoreProxyRisk() returns 55 for ERC1967 proxy", async () => {
    const { scoreProxyRisk } = await import("../scanner/risk-blender.js");
    expect(scoreProxyRisk(true, ["ERC1967"])).toBe(55);
  });

  it("scoreProxyRisk() returns 70 for ERC2535 (diamond) proxy", async () => {
    const { scoreProxyRisk } = await import("../scanner/risk-blender.js");
    expect(scoreProxyRisk(true, ["ERC2535"])).toBe(70);
  });

  it("CATEGORY_RISK_BASE has bridge as highest-risk category", async () => {
    const { CATEGORY_RISK_BASE } = await import("../scanner/risk-blender.js");
    const values = Object.values(CATEGORY_RISK_BASE) as number[];
    expect(CATEGORY_RISK_BASE.bridge).toBe(Math.max(...values));
  });

  it("blendRiskScore() uses LLM weight (55%) when llmRisk provided", async () => {
    const { blendRiskScore } = await import("../scanner/risk-blender.js");
    const result = blendRiskScore({
      llmRisk: {
        overallRisk: 80,
        dimensions: {
          technicalVulnerabilities: 80,
          designAndLogicFlaws: 70,
          externalDependencies: 85,
          operationalRisks: 60,
          marketGovernanceRisks: 75,
        },
        rationale: "High risk bridge contract",
        topRiskFactors: ["Cross-chain replay", "Centralized relayer", "Unaudited deps"],
      },
      defiCategory: "bridge",
      bytecodeHex: "0x" + "ff".repeat(10_000),
      estimatedLOC: 3000,
      isProxy: false,
      standards: [],
    });
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    expect(result.components.llmScore).toBe(80);
    expect(result.dimensions).not.toBeNull();
    expect(result.topRiskFactors).toHaveLength(3);
  });

  it("blendRiskScore() uses heuristic-only when llmRisk=null", async () => {
    const { blendRiskScore } = await import("../scanner/risk-blender.js");
    const result = blendRiskScore({
      llmRisk: null,
      defiCategory: "staking",
      bytecodeHex: "0x" + "ff".repeat(2_000),
      estimatedLOC: 600,
      isProxy: false,
      standards: [],
    });
    expect(result.components.llmScore).toBeNull();
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    expect(result.rationale).toContain("Heuristic-only");
    expect(result.topRiskFactors).toEqual([]);
  });

  it("blendRiskScore() final score is always clamped to [0, 100]", async () => {
    const { blendRiskScore } = await import("../scanner/risk-blender.js");
    // Extreme high LLM + extreme heuristics
    const result = blendRiskScore({
      llmRisk: {
        overallRisk: 100,
        dimensions: {
          technicalVulnerabilities: 100,
          designAndLogicFlaws: 100,
          externalDependencies: 100,
          operationalRisks: 100,
          marketGovernanceRisks: 100,
        },
        rationale: "All max",
        topRiskFactors: ["a", "b", "c"],
      },
      defiCategory: "bridge",
      bytecodeHex: "0x" + "ff".repeat(50_000),
      estimatedLOC: 20_000,
      isProxy: true,
      standards: ["ERC2535"],
    });
    expect(result.finalScore).toBeLessThanOrEqual(100);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
  });

  it("getWeights() reads from env vars", async () => {
    process.env.RISK_WEIGHT_LLM = "0.7";
    process.env.RISK_WEIGHT_BYTECODE = "0.1";
    const { getWeights } = await import("../scanner/risk-blender.js");
    const w = getWeights();
    expect(w.llm).toBe(0.7);
    expect(w.bytecodeComplexity).toBe(0.1);
  });
});

// =========================================================================
// BLOCK 5: risk-inference.ts — assessRisk() with 0g→Claude failover (12 tests)
// =========================================================================

describe("risk-inference.ts — assessRisk()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
    process.env.ZG_PRIVATE_KEY = "0x493a894523bd3af6ab9954f4c229686417c39a8599bc8f7c48fc2dffe3c3202b";
    process.env.ZG_PROVIDER_ADDRESS = "0xa48f01MockProviderAddress";
    process.env.ZG_RPC_URL = "https://evmrpc-testnet.0g.ai";
    process.env.ANTHROPIC_API_KEY = "sk-ant-mock-key";

    // Reset broker mock state
    mockBrokerInference.getServiceMetadata.mockResolvedValue({
      endpoint: "https://mock-0g-provider.ai",
      model: "qwen-2.5-7b-instruct",
    });
    mockBrokerInference.getRequestHeaders.mockResolvedValue({
      "X-0G-Auth": "mock-auth",
      "X-0G-Nonce": "99999",
    });
    mockBrokerInference.acknowledgeProviderSigner.mockResolvedValue(undefined);
    mockBrokerInference.processResponse.mockResolvedValue(true);
    mockBrokerLedger.getLedger.mockResolvedValue({
      availableBalance: BigInt("1000000000000000000"),
    });
    mockBrokerLedger.depositFund.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const mod = await import("../scanner/risk-inference.js").catch(() => null);
    mod?._resetRiskInference?.();
    delete process.env.ZG_PRIVATE_KEY;
    delete process.env.ZG_PROVIDER_ADDRESS;
    delete process.env.ZG_RPC_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ZG_MODEL;
    vi.clearAllMocks();
  });

  it("returns source='0g' when 0g broker succeeds and returns valid risk JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: validRiskJson } }],
        usage: { prompt_tokens: 100, completion_tokens: 200 },
      }),
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.source).toBe("0g");
    expect(result.risk.overallRisk).toBe(65);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns source='0g' and risk has all 5 dimensions", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: validRiskJson } }],
      }),
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.risk.dimensions).toHaveProperty("technicalVulnerabilities");
    expect(result.risk.dimensions).toHaveProperty("designAndLogicFlaws");
    expect(result.risk.dimensions).toHaveProperty("externalDependencies");
    expect(result.risk.dimensions).toHaveProperty("operationalRisks");
    expect(result.risk.dimensions).toHaveProperty("marketGovernanceRisks");
  });

  it("falls back to Claude when 0g HTTP request fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.source).toBe("claude");
    expect(result.risk.overallRisk).toBe(65);
  });

  it("falls back to Claude when 0g returns non-200 status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service Unavailable"),
    });
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.source).toBe("claude");
  });

  it("falls back to Claude when 0g returns unparseable risk response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: "sorry, I cannot assess this" } }],
      }),
    });
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.source).toBe("claude");
  });

  it("throws when both 0g and Claude inference fail", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("0g down"));
    mockClaudeCreate.mockRejectedValue(new Error("Claude API error"));

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    await expect(assessRisk(makeRiskCtx(), mockLog)).rejects.toThrow(
      /Both 0g and Claude inference failed/
    );
  });

  it("throws when Claude returns unparseable response and 0g also failed", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("0g down"));
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: "not valid json at all" }],
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    await expect(assessRisk(makeRiskCtx(), mockLog)).rejects.toThrow();
  });

  it("skips 0g entirely and uses Claude when missing ZG_PRIVATE_KEY", async () => {
    delete process.env.ZG_PRIVATE_KEY;
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });
    // fetch should never be called for 0g
    globalThis.fetch = vi.fn();

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    // Without key, zgHealthy becomes false, falls to Claude
    expect(result.source).toBe("claude");
  });

  it("getCurrentInferenceSource() returns '0g' initially", async () => {
    const { getCurrentInferenceSource, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    expect(getCurrentInferenceSource()).toBe("0g");
  });

  it("getCurrentInferenceSource() returns 'claude' after 0g failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("0g down"));
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });

    const { assessRisk, getCurrentInferenceSource, _resetRiskInference } = await import(
      "../scanner/risk-inference.js"
    );
    _resetRiskInference();
    await assessRisk(makeRiskCtx(), mockLog).catch(() => {});
    expect(getCurrentInferenceSource()).toBe("claude");
  });

  it("model field in result reflects ZG_MODEL env var", async () => {
    process.env.ZG_MODEL = "custom-model-v1";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({
        choices: [{ message: { content: validRiskJson } }],
      }),
    });

    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const result = await assessRisk(makeRiskCtx(), mockLog);
    expect(result.model).toBe("custom-model-v1");
  });

  it("_resetRiskInference() restores zgHealthy to true", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down"));
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: "text", text: validRiskJson }],
    });

    const { assessRisk, getCurrentInferenceSource, _resetRiskInference } = await import(
      "../scanner/risk-inference.js"
    );
    _resetRiskInference();
    // Trip 0g to unhealthy
    await assessRisk(makeRiskCtx(), mockLog).catch(() => {});
    expect(getCurrentInferenceSource()).toBe("claude");
    // Reset
    _resetRiskInference();
    expect(getCurrentInferenceSource()).toBe("0g");
  });
});

// =========================================================================
// BLOCK 6: risk-inference.ts — health-check loop (5 tests)
// =========================================================================

describe("risk-inference.ts — health-check loop", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.resetModules();
    process.env.ZG_PRIVATE_KEY = "0x493a894523bd3af6ab9954f4c229686417c39a8599bc8f7c48fc2dffe3c3202b";
    process.env.ZG_PROVIDER_ADDRESS = "0xa48f01MockProviderAddress";
    process.env.ZG_HEALTH_CHECK_INTERVAL_MS = "30000";

    mockBrokerInference.getServiceMetadata.mockResolvedValue({
      endpoint: "https://mock-0g-provider.ai",
      model: "qwen-2.5-7b-instruct",
    });
    mockBrokerInference.getRequestHeaders.mockResolvedValue({ "X-0G-Auth": "mock" });
    mockBrokerInference.acknowledgeProviderSigner.mockResolvedValue(undefined);
    mockBrokerLedger.getLedger.mockResolvedValue({ availableBalance: BigInt("1000000000000000000") });
  });

  afterEach(async () => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    const mod = await import("../scanner/risk-inference.js").catch(() => null);
    mod?._resetRiskInference?.();
    mod?.stopZgHealthCheckLoop?.();
    delete process.env.ZG_HEALTH_CHECK_INTERVAL_MS;
    delete process.env.ZG_PRIVATE_KEY;
    delete process.env.ZG_PROVIDER_ADDRESS;
    vi.clearAllMocks();
  });

  it("startZgHealthCheckLoop() does not start duplicate timers", async () => {
    const { startZgHealthCheckLoop, stopZgHealthCheckLoop, _resetRiskInference } = await import(
      "../scanner/risk-inference.js"
    );
    _resetRiskInference();
    startZgHealthCheckLoop(mockLog);
    startZgHealthCheckLoop(mockLog); // second call should be a no-op
    // No assertion needed beyond not throwing — idempotent
    stopZgHealthCheckLoop();
  });

  it("stopZgHealthCheckLoop() clears the timer without error", async () => {
    const { startZgHealthCheckLoop, stopZgHealthCheckLoop, _resetRiskInference } = await import(
      "../scanner/risk-inference.js"
    );
    _resetRiskInference();
    startZgHealthCheckLoop(mockLog);
    stopZgHealthCheckLoop();
    // Second stop should be safe (no double-clear error)
    stopZgHealthCheckLoop();
  });

  it("health check does not fire when zgHealthy is true", async () => {
    const { startZgHealthCheckLoop, stopZgHealthCheckLoop, _resetRiskInference } = await import(
      "../scanner/risk-inference.js"
    );
    _resetRiskInference();
    globalThis.fetch = vi.fn();
    startZgHealthCheckLoop(mockLog);
    // Advance time past the check interval
    await vi.advanceTimersByTimeAsync(35_000);
    // fetch should NOT have been called (zgHealthy is true, loop skips)
    expect(globalThis.fetch).not.toHaveBeenCalled();
    stopZgHealthCheckLoop();
  });

  it("health check restores zgHealthy after successful probe", async () => {
    const {
      startZgHealthCheckLoop,
      stopZgHealthCheckLoop,
      getCurrentInferenceSource,
      _resetRiskInference,
    } = await import("../scanner/risk-inference.js");
    _resetRiskInference();

    // Manually mark unhealthy by having 0g fail first
    // Then start the health check which should restore it
    // We use direct state manipulation via the re-imported module after reset
    // Simulate: zgHealthy = false by providing no key initially
    delete process.env.ZG_PRIVATE_KEY;

    // Start loop; loop fires; mock fetch succeeds → restores zgHealthy
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    startZgHealthCheckLoop(mockLog);
    // Before tick: still using Claude (no key = zgHealthy false)
    expect(getCurrentInferenceSource()).toBe("claude");

    // Restore key so broker can init during the health check
    process.env.ZG_PRIVATE_KEY = "0x493a894523bd3af6ab9954f4c229686417c39a8599bc8f7c48fc2dffe3c3202b";
    await vi.advanceTimersByTimeAsync(32_000);
    // After probe succeeds, should be back to 0g
    expect(getCurrentInferenceSource()).toBe("0g");
    stopZgHealthCheckLoop();
  });

  it("health check stays on Claude when probe returns non-ok status", async () => {
    const {
      startZgHealthCheckLoop,
      stopZgHealthCheckLoop,
      getCurrentInferenceSource,
      _resetRiskInference,
    } = await import("../scanner/risk-inference.js");
    _resetRiskInference();

    // Force unhealthy
    delete process.env.ZG_PRIVATE_KEY;
    process.env.ZG_PRIVATE_KEY = ""; // trigger no-key path

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    startZgHealthCheckLoop(mockLog);
    await vi.advanceTimersByTimeAsync(32_000);
    // Probe failed → stays on Claude
    expect(getCurrentInferenceSource()).toBe("claude");
    stopZgHealthCheckLoop();
  });
});

// =========================================================================
// BLOCK 7: Scanner integration — pipeline shape + backward compat (9 tests)
// =========================================================================

describe("Scanner integration", () => {
  afterEach(() => {
    delete process.env.TEST_MODE;
    vi.clearAllMocks();
  });

  it("generateDiscovery() is still exported from scanner", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    expect(typeof generateDiscovery).toBe("function");
  });

  it("generateDiscovery() in TEST_MODE produces type='CONTRACT_DISCOVERED'", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    expect(discovery.type).toBe("CONTRACT_DISCOVERED");
  });

  it("generateDiscovery() payload has contractType that is a valid DefiCategory", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    const validTypes = ["lending", "dex", "staking", "bridge", "vault"];
    expect(validTypes).toContain(discovery.payload.contractType);
  });

  it("generateDiscovery() payload does NOT contain 'unknown' contractType", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    // Run 10 times to cover all rotation paths
    for (let i = 0; i < 10; i++) {
      const d = generateDiscovery();
      expect(d.payload.contractType).not.toBe("unknown");
    }
  });

  it("generateDiscovery() payload has riskScore in [0, 100]", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    expect(discovery.payload.riskScore).toBeGreaterThanOrEqual(0);
    expect(discovery.payload.riskScore).toBeLessThanOrEqual(100);
  });

  it("generateDiscovery() payload has required HCS envelope fields", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    expect(typeof discovery.type).toBe("string");
    expect(typeof discovery.agentId).toBe("string");
    expect(typeof discovery.timestamp).toBe("number");
    expect(typeof discovery.payload).toBe("object");
  });

  it("ContractType no longer includes 'unknown'", async () => {
    // Verify the type definition at runtime via the shared types
    // (no 'unknown' should appear in any discovery from test path)
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    // The payload must have contractType that matches ContractType (no unknown)
    const contractType = discovery.payload.contractType;
    const allowed = ["lending", "dex", "staking", "bridge", "vault"] as const;
    expect(allowed).toContain(contractType);
  });

  it("full pipeline: classifyContract → blendRiskScore produces bounded output", async () => {
    // Test the pipeline components in sequence with realistic data
    const { classifyContract, _resetDecoder } = await import("../scanner/contract-classifier.js");
    const { blendRiskScore } = await import("../scanner/risk-blender.js");

    _resetDecoder();
    mockContractInfoFn.mockResolvedValue({
      isContract: true,
      contractType: { name: "Token", standards: ["ERC20", "ERC3156"] },
      contractName: "FlashLender",
    });

    const classification = await classifyContract("0x" + "abc123".repeat(6) + "ab");
    expect(classification.defiCategory).toBe("lending");

    const blended = blendRiskScore({
      llmRisk: {
        overallRisk: 72,
        dimensions: {
          technicalVulnerabilities: 75,
          designAndLogicFlaws: 65,
          externalDependencies: 80,
          operationalRisks: 55,
          marketGovernanceRisks: 70,
        },
        rationale: "Flash loan contract with oracle dependency",
        topRiskFactors: ["Flash loan re-entry", "Oracle price manipulation", "Admin key"],
      },
      defiCategory: classification.defiCategory,
      bytecodeHex: "0x" + "60".repeat(5_000),
      estimatedLOC: 1500,
      isProxy: false,
      standards: classification.standards,
    });

    expect(blended.finalScore).toBeGreaterThanOrEqual(0);
    expect(blended.finalScore).toBeLessThanOrEqual(100);
    expect(blended.components.llmScore).toBe(72);
    expect(blended.rationale).toContain("Flash loan");

    _resetDecoder();
  });

  it("discovery event shape matches ContractDiscoveryEvent — all required fields present", async () => {
    process.env.TEST_MODE = "true";
    const { generateDiscovery } = await import("../scanner/index.js");
    const discovery = generateDiscovery();
    const payload = discovery.payload;

    // Required by ContractDiscoveryEvent
    expect(typeof payload.contractAddress).toBe("string");
    expect(typeof payload.chain).toBe("string");
    expect(typeof payload.deployerAddress).toBe("string");
    expect(typeof payload.estimatedLOC).toBe("number");
    expect(typeof payload.contractType).toBe("string");
    expect(typeof payload.riskScore).toBe("number");
    expect(typeof payload.budget).toBe("number");
    expect(typeof payload.txHash).toBe("string");
  });
});

// =========================================================================
// LIVE TESTS (skipped unless LIVE_CLASSIFIER_TEST=true)
// =========================================================================

const LIVE = process.env.LIVE_CLASSIFIER_TEST === "true";

describe.skipIf(!LIVE)("LIVE: 0g inference risk assessment (requires env vars)", () => {
  it("assessRisk() calls real 0g provider and returns parseable risk", async () => {
    const { assessRisk, _resetRiskInference } = await import("../scanner/risk-inference.js");
    _resetRiskInference();
    const ctx = makeRiskCtx({
      contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      defiCategory: "lending" as const,
      estimatedLOC: 1200,
    });
    const result = await assessRisk(ctx, { info: console.log, warn: console.warn });
    expect(result.risk.overallRisk).toBeGreaterThanOrEqual(0);
    expect(result.risk.overallRisk).toBeLessThanOrEqual(100);
    expect(result.source).toMatch(/^(0g|claude)$/);
    _resetRiskInference();
  }, 60_000);

  it("retrieveContractSource() fetches real bytecode from Hashio RPC", async () => {
    const { retrieveContractSource } = await import("../scanner/source-retriever.js");
    const result = await retrieveContractSource(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "https://testnet.hashio.io/api"
    );
    // Bytecode or 0x (contract may not exist on testnet)
    expect(typeof result.bytecode).toBe("string");
    expect(typeof result.hasSource).toBe("boolean");
  }, 30_000);
});
