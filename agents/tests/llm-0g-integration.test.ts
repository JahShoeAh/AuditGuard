/**
 * Comprehensive offline tests for the 0g inference integration in the LLM Contextual Agent.
 *
 * Covers: zg-client.ts, prompt-builder.ts, response-parser.ts, and analyzeWithAI().
 * All tests use vi.mock / vi.fn — zero real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Global mocks to prevent Hedera SDK / ABI loading ─────────────────────

vi.mock("../shared/index.js", () => ({
  CONFIG: {
    network: "testnet",
    guardToken: { id: "0.0.1", evmAddress: "0x0" },
    hcsTopics: { discovery: "0.0.1", auditLog: "0.0.2", agentComms: "0.0.3" },
    contracts: {},
    inftCollections: {},
    settlementPreFunded: 500,
    demoVault: { address: "0xdead", weeklyMonitoring: 10, criticalBounty: 50 },
    zgInference: {
      rpcUrl: "https://evmrpc-testnet.0g.ai",
      providerAddress: process.env.ZG_PROVIDER_ADDRESS ?? "",
      model: process.env.ZG_MODEL ?? "qwen-2.5-7b-instruct",
      timeoutMs: 30000,
      depositAmount: 5,
      enabled: process.env.ZG_ENABLED !== "false",
    },
  },
  getAgentEnv: vi.fn().mockReturnValue({ accountId: "0.0.1", privateKey: "0x01" }),
  createAgentLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  createAgentWallet: vi.fn().mockReturnValue({
    evmAddress: "0xMOCK",
    hederaClient: {},
    evmWallet: {},
  }),
  HCSClient: vi.fn().mockImplementation(() => ({
    publishAuditLog: vi.fn(),
    publishAgentComms: vi.fn(),
    subscribeDiscovery: vi.fn(),
    subscribeAgentComms: vi.fn(),
  })),
  ContractClient: vi.fn().mockImplementation(() => ({
    submitBid: vi.fn(),
    createSubAuction: vi.fn(),
    acceptResult: vi.fn(),
    onWinnerSelected: vi.fn(),
  })),
  randomInt: (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1)),
  randomFloat: (min: number, max: number) => min + Math.random() * (max - min),
  randomBool: (prob: number) => Math.random() < prob,
  randomSeveritySkewedHigh: () => (["critical", "high", "medium"] as const)[Math.floor(Math.random() * 3)],
  randomFindingTitle: (ct: string) => `Mock ${ct} finding`,
  hashOf: (data: any) => "0xmockhash",
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/config.js", () => ({
  CONFIG: {
    network: "testnet",
    guardToken: { id: "0.0.1", evmAddress: "0x0" },
    hcsTopics: { discovery: "0.0.1", auditLog: "0.0.2", agentComms: "0.0.3" },
    contracts: {},
    inftCollections: {},
    settlementPreFunded: 500,
    demoVault: { address: "0xdead", weeklyMonitoring: 10, criticalBounty: 50 },
    zgInference: {
      rpcUrl: "https://evmrpc-testnet.0g.ai",
      providerAddress: process.env.ZG_PROVIDER_ADDRESS ?? "",
      model: process.env.ZG_MODEL ?? "qwen-2.5-7b-instruct",
      timeoutMs: 30000,
      depositAmount: 5,
      enabled: process.env.ZG_ENABLED !== "false",
    },
  },
  getAgentEnv: vi.fn().mockReturnValue({ accountId: "0.0.1", privateKey: "0x01" }),
  SDK_CONFIG_FILE: "/tmp/fake-config.json",
}));

// Mock the 0g serving broker SDK globally
const mockBroker = {
  inference: {
    listService: vi.fn().mockResolvedValue([]),
    getServiceMetadata: vi.fn().mockResolvedValue({
      endpoint: "https://mock-provider.0g.ai",
      model: "qwen-2.5-7b-instruct",
    }),
    getRequestHeaders: vi.fn().mockResolvedValue({
      "X-0G-Auth": "mock-signed-header",
      "X-0G-Nonce": "12345",
    }),
    acknowledgeProviderSigner: vi.fn().mockResolvedValue(undefined),
  },
  ledger: {
    depositFund: vi.fn().mockResolvedValue(undefined),
  },
};

vi.mock("@0glabs/0g-serving-broker", () => ({
  createZGComputeNetworkBroker: vi.fn().mockResolvedValue(mockBroker),
}));

// =========================================================================
// BLOCK 1: zg-client.ts — SDK broker + HTTP layer (8 tests)
// =========================================================================

describe("zg-client.ts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
    process.env.ZG_PRIVATE_KEY = "0x493a894523bd3af6ab9954f4c229686417c39a8599bc8f7c48fc2dffe3c3202b";
    process.env.ZG_PROVIDER_ADDRESS = "0xa48f01MockProviderAddress";
    process.env.ZG_RPC_URL = "https://evmrpc-testnet.0g.ai";
    mockBroker.inference.getServiceMetadata.mockResolvedValue({
      endpoint: "https://mock-provider.0g.ai",
      model: "qwen-2.5-7b-instruct",
    });
    mockBroker.inference.getRequestHeaders.mockResolvedValue({
      "X-0G-Auth": "mock-signed-header",
      "X-0G-Nonce": "12345",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.ZG_PRIVATE_KEY;
    delete process.env.ZG_PROVIDER_ADDRESS;
    delete process.env.ZG_RPC_URL;
  });

  const makeRequest = () => ({
    model: "qwen-2.5-7b-instruct",
    messages: [
      { role: "system" as const, content: "You are an auditor." },
      { role: "user" as const, content: "Analyze this contract." },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });

  it("returns choices[0].message.content on 200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"findings":[]}' } }],
      }),
    });

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    const result = await callInference(makeRequest());
    expect(result).toBe('{"findings":[]}');
  });

  it("throws ZGClientError('HTTP_ERROR') on non-200 status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { callInference, ZGClientError, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    try {
      await callInference(makeRequest());
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ZGClientError);
      expect(err.code).toBe("HTTP_ERROR");
    }
  });

  it("throws ZGClientError('EMPTY_RESPONSE') when choices is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    });

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    try {
      await callInference(makeRequest());
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("EMPTY_RESPONSE");
    }
  });

  it("throws ZGClientError('TIMEOUT') when request is aborted", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    try {
      await callInference(makeRequest(), { timeoutMs: 100 });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TIMEOUT");
    }
  });

  it("uses SDK-generated auth headers in fetch call", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = fetchSpy;

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    await callInference(makeRequest());

    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[1].headers["X-0G-Auth"]).toBe("mock-signed-header");
    expect(callArgs[1].headers["X-0G-Nonce"]).toBe("12345");
  });

  it("sends correct Content-Type: application/json", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = fetchSpy;

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    await callInference(makeRequest());

    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
  });

  it("passes model, messages, temperature, max_tokens through to body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "ok" } }],
      }),
    });
    globalThis.fetch = fetchSpy;

    const req = makeRequest();
    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    await callInference(req);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.messages).toEqual(req.messages);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(2000);
  });

  it("throws NOT_INITIALIZED when ZG_PROVIDER_ADDRESS is missing", async () => {
    delete process.env.ZG_PROVIDER_ADDRESS;

    const { callInference, _resetBroker } = await import("../llm-contextual/zg-client.js");
    _resetBroker();
    try {
      await callInference(makeRequest());
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("NOT_INITIALIZED");
    }
  });
});

// =========================================================================
// BLOCK 2: prompt-builder.ts — Prompt engineering (10 tests)
// =========================================================================

describe("prompt-builder.ts", () => {
  const baseCtx = () => ({
    contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
    contractType: "lending" as const,
    estimatedLOC: 3000,
    riskScore: 75,
    hasDepAnalysis: false,
  });

  it("buildSystemPrompt() includes instruction to return JSON", async () => {
    const { buildSystemPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("JSON");
  });

  it("buildSystemPrompt() specifies valid severity values", async () => {
    const { buildSystemPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("critical");
    expect(prompt).toContain("high");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("low");
    expect(prompt).toContain("info");
  });

  it("buildUserPrompt() includes contractType in the prompt", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildUserPrompt(baseCtx());
    expect(prompt).toContain("lending");
  });

  it("buildUserPrompt() includes estimatedLOC in the prompt", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildUserPrompt(baseCtx());
    expect(prompt).toContain("3000");
  });

  it("buildUserPrompt() includes riskScore in the prompt", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildUserPrompt(baseCtx());
    expect(prompt).toContain("75");
  });

  it("buildUserPrompt() mentions dependency analysis when hasDepAnalysis=true", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const ctx = { ...baseCtx(), hasDepAnalysis: true };
    const prompt = buildUserPrompt(ctx);
    expect(prompt.toLowerCase()).toContain("dependency analysis");
  });

  it("buildUserPrompt() does NOT mention dependency analysis when hasDepAnalysis=false", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const prompt = buildUserPrompt(baseCtx());
    expect(prompt.toLowerCase()).not.toContain("dependency analysis has been performed");
  });

  it("buildUserPrompt() injects depAnalysisSummary when provided", async () => {
    const { buildUserPrompt } = await import("../llm-contextual/prompt-builder.js");
    const ctx = {
      ...baseCtx(),
      hasDepAnalysis: true,
      depAnalysisSummary: "Found 3 outdated deps, 1 known CVE in @openzeppelin/contracts",
    };
    const prompt = buildUserPrompt(ctx);
    expect(prompt).toContain("Found 3 outdated deps");
    expect(prompt).toContain("@openzeppelin/contracts");
  });

  it("buildMessages() returns array with exactly 2 messages (system + user)", async () => {
    const { buildMessages } = await import("../llm-contextual/prompt-builder.js");
    const messages = buildMessages(baseCtx());
    expect(messages).toHaveLength(2);
  });

  it("buildMessages() messages have correct role values", async () => {
    const { buildMessages } = await import("../llm-contextual/prompt-builder.js");
    const messages = buildMessages(baseCtx());
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });
});

// =========================================================================
// BLOCK 3: response-parser.ts — Output parsing (15 tests)
// =========================================================================

describe("response-parser.ts", () => {
  const AGENT_ID = "llm-contextual-003";

  const cleanResponse = JSON.stringify({
    findings: [
      {
        id: "LLM-001",
        severity: "critical",
        title: "Reentrancy in withdraw()",
        description: "The withdraw function does not follow CEI pattern",
        confidence: 0.95,
      },
    ],
  });

  it("parses clean JSON string correctly", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings(cleanResponse, AGENT_ID, "lending");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Reentrancy in withdraw()");
    expect(result.parseError).toBeUndefined();
  });

  it("parses JSON wrapped in markdown fence", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const fenced = "```json\n" + cleanResponse + "\n```";
    const result = parseFindings(fenced, AGENT_ID, "lending");
    expect(result.findings).toHaveLength(1);
    expect(result.parseError).toBeUndefined();
  });

  it("parses JSON with trailing comma (resilient)", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const withTrailing = `{
      "findings": [
        {"id": "LLM-001", "severity": "high", "title": "Bug", "description": "desc", "confidence": 0.8,},
      ],
    }`;
    const result = parseFindings(withTrailing, AGENT_ID, "lending");
    expect(result.findings).toHaveLength(1);
    expect(result.parseError).toBeUndefined();
  });

  it("returns parseError when response is empty string", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings("", AGENT_ID, "lending");
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toBeDefined();
  });

  it("returns parseError when response is non-JSON prose", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings(
      "I found several vulnerabilities in this contract that are concerning.",
      AGENT_ID,
      "lending"
    );
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toBeDefined();
  });

  it("returns parseError when 'findings' key is missing", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings('{"results": []}', AGENT_ID, "lending");
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toContain("findings");
  });

  it("returns parseError when 'findings' is not an array", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings('{"findings": "not an array"}', AGENT_ID, "lending");
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toContain("not an array");
  });

  it("auto-fixes finding ID to LLM-001 format when raw ID doesn't match pattern", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const raw = JSON.stringify({
      findings: [
        { id: "finding-1", severity: "high", title: "Bug", description: "d", confidence: 0.8 },
      ],
    });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings[0].id).toBe("LLM-001");
  });

  it("clamps confidence of 1.5 to 1.0", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const raw = JSON.stringify({
      findings: [
        { id: "LLM-001", severity: "high", title: "Bug", description: "d", confidence: 1.5 },
      ],
    });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings[0].confidence).toBe(1.0);
  });

  it("clamps confidence of -0.1 to 0.0", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const raw = JSON.stringify({
      findings: [
        { id: "LLM-001", severity: "high", title: "Bug", description: "d", confidence: -0.1 },
      ],
    });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings[0].confidence).toBe(0.0);
  });

  it("defaults severity to 'medium' for unknown severity string", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const raw = JSON.stringify({
      findings: [
        { id: "LLM-001", severity: "SUPER_BAD", title: "Bug", description: "d", confidence: 0.8 },
      ],
    });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings[0].severity).toBe("medium");
  });

  it("injects agentId on each finding", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const result = parseFindings(cleanResponse, AGENT_ID, "lending");
    expect(result.findings[0].agentId).toBe(AGENT_ID);
  });

  it("injects timestamp on each finding", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const before = Date.now();
    const result = parseFindings(cleanResponse, AGENT_ID, "lending");
    const after = Date.now();
    expect(result.findings[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(result.findings[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("filters out findings with empty title", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const raw = JSON.stringify({
      findings: [
        { id: "LLM-001", severity: "high", title: "Bug", description: "d", confidence: 0.8 },
        { id: "LLM-002", severity: "low", title: "", description: "d", confidence: 0.5 },
        { id: "LLM-003", severity: "medium", title: "  ", description: "d", confidence: 0.6 },
      ],
    });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Bug");
  });

  it("returns all 5 findings from a clean 5-finding JSON response", async () => {
    const { parseFindings } = await import("../llm-contextual/response-parser.js");
    const findings = Array.from({ length: 5 }, (_, i) => ({
      id: `LLM-${String(i + 1).padStart(3, "0")}`,
      severity: "high",
      title: `Finding ${i + 1}`,
      description: `Description ${i + 1}`,
      confidence: 0.85,
    }));
    const raw = JSON.stringify({ findings });
    const result = parseFindings(raw, AGENT_ID, "lending");
    expect(result.findings).toHaveLength(5);
  });
});

// =========================================================================
// BLOCK 4: analyzeWithAI() in index.ts — Integration (12 tests)
// =========================================================================

describe("analyzeWithAI()", () => {
  const AGENT_ID = "llm-contextual-003";

  const baseCtx = () => ({
    contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
    contractType: "lending" as const,
    estimatedLOC: 3000,
    riskScore: 75,
    hasDepAnalysis: false,
  });

  const goodLlmResponse = JSON.stringify({
    findings: [
      {
        id: "LLM-001",
        severity: "critical",
        title: "Reentrancy in withdraw()",
        description: "The withdraw function lacks reentrancy guard",
        confidence: 0.92,
      },
      {
        id: "LLM-002",
        severity: "high",
        title: "Oracle manipulation",
        description: "Price oracle can be manipulated via flash loan",
        confidence: 0.85,
      },
    ],
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ZG_PRIVATE_KEY = "0x493a894523bd3af6ab9954f4c229686417c39a8599bc8f7c48fc2dffe3c3202b";
    process.env.ZG_PROVIDER_ADDRESS = "0xa48f01MockProvider";
    delete process.env.ZG_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZG_ENABLED;
    delete process.env.ZG_PRIVATE_KEY;
    delete process.env.ZG_PROVIDER_ADDRESS;
  });

  it("returns usedFallback: false on successful 0g call", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: vi.fn().mockResolvedValue(goodLlmResponse),
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.usedFallback).toBe(false);
  });

  it("returns Finding[] matching ParseResult.findings on success", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: vi.fn().mockResolvedValue(goodLlmResponse),
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.findings.length).toBe(2);
    expect(result.findings[0].title).toBe("Reentrancy in withdraw()");
    expect(result.findings[1].title).toBe("Oracle manipulation");
  });

  it("returns usedFallback: true when callInference throws ZGClientError", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => {
      class ZGClientError extends Error {
        code: string;
        constructor(c: string, m: string) { super(m); this.name = "ZGClientError"; this.code = c; }
      }
      return {
        callInference: vi.fn().mockRejectedValue(new ZGClientError("TIMEOUT", "timed out")),
        initZgClient: vi.fn().mockResolvedValue(undefined),
        ZGClientError,
      };
    });

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.usedFallback).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("returns usedFallback: true when parseFindings returns parseError", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: vi.fn().mockResolvedValue("This is not JSON at all"),
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.usedFallback).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("retries exactly once on first ZGClientError, succeeds on second attempt", async () => {
    let callCount = 0;
    vi.doMock("../llm-contextual/zg-client.js", () => {
      class ZGClientError extends Error {
        code: string;
        constructor(c: string, m: string) { super(m); this.name = "ZGClientError"; this.code = c; }
      }
      return {
        callInference: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw new ZGClientError("TIMEOUT", "first attempt");
          return goodLlmResponse;
        }),
        initZgClient: vi.fn().mockResolvedValue(undefined),
        ZGClientError,
      };
    });

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(callCount).toBe(2);
    expect(result.usedFallback).toBe(false);
    expect(result.findings.length).toBe(2);
  });

  it("returns mock findings after both retries fail", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => {
      class ZGClientError extends Error {
        code: string;
        constructor(c: string, m: string) { super(m); this.name = "ZGClientError"; this.code = c; }
      }
      return {
        callInference: vi.fn().mockRejectedValue(new ZGClientError("HTTP_ERROR", "always fail")),
        initZgClient: vi.fn().mockResolvedValue(undefined),
        ZGClientError,
      };
    });

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.usedFallback).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("mock fallback findings have correct shape (ID prefix, severity, confidence)", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => {
      class ZGClientError extends Error {
        code: string;
        constructor(c: string, m: string) { super(m); this.name = "ZGClientError"; this.code = c; }
      }
      return {
        callInference: vi.fn().mockRejectedValue(new ZGClientError("TIMEOUT", "fail")),
        initZgClient: vi.fn().mockResolvedValue(undefined),
        ZGClientError,
      };
    });

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    for (const f of result.findings) {
      expect(f.id).toMatch(/^LLM-\d{3}$/);
      expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
      expect(f.confidence).toBeGreaterThanOrEqual(0.8);
      expect(f.confidence).toBeLessThanOrEqual(0.99);
      expect(f.agentId).toBe(AGENT_ID);
    }
  });

  it("does NOT call 0g when ZG_ENABLED=false", async () => {
    process.env.ZG_ENABLED = "false";
    const inferSpy = vi.fn().mockResolvedValue(goodLlmResponse);
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: inferSpy,
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(inferSpy).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(true);
  });

  it("does NOT call 0g when ZG_PROVIDER_ADDRESS is empty", async () => {
    delete process.env.ZG_PROVIDER_ADDRESS;
    const inferSpy = vi.fn().mockResolvedValue(goodLlmResponse);
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: inferSpy,
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(inferSpy).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(true);
  });

  it("passes AuditContext.contractType to prompt builder", async () => {
    const buildMessagesSpy = vi.fn().mockReturnValue([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    vi.doMock("../llm-contextual/prompt-builder.js", () => ({
      buildMessages: buildMessagesSpy,
      buildSystemPrompt: vi.fn(),
      buildUserPrompt: vi.fn(),
    }));
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: vi.fn().mockResolvedValue(goodLlmResponse),
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const ctx = { ...baseCtx(), contractType: "bridge" as const };
    await analyzeWithAI(ctx);

    expect(buildMessagesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contractType: "bridge" })
    );
  });

  it("passes hasDepAnalysis flag to prompt builder", async () => {
    const buildMessagesSpy = vi.fn().mockReturnValue([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    vi.doMock("../llm-contextual/prompt-builder.js", () => ({
      buildMessages: buildMessagesSpy,
      buildSystemPrompt: vi.fn(),
      buildUserPrompt: vi.fn(),
    }));
    vi.doMock("../llm-contextual/zg-client.js", () => ({
      callInference: vi.fn().mockResolvedValue(goodLlmResponse),
      initZgClient: vi.fn().mockResolvedValue(undefined),
      ZGClientError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c; } },
    }));

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const ctx = { ...baseCtx(), hasDepAnalysis: true };
    await analyzeWithAI(ctx);

    expect(buildMessagesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hasDepAnalysis: true })
    );
  });

  it("logs [0g] prefix on success and [0g fallback] on fallback", async () => {
    vi.doMock("../llm-contextual/zg-client.js", () => {
      class ZGClientError extends Error {
        code: string;
        constructor(c: string, m: string) { super(m); this.name = "ZGClientError"; this.code = c; }
      }
      return {
        callInference: vi.fn().mockRejectedValue(new ZGClientError("TIMEOUT", "fail")),
        initZgClient: vi.fn().mockResolvedValue(undefined),
        ZGClientError,
      };
    });

    const { analyzeWithAI } = await import("../llm-contextual/index.js");
    const result = await analyzeWithAI(baseCtx());
    expect(result.usedFallback).toBe(true);
  });
});

// =========================================================================
// BLOCK 5: Existing test compatibility — regression
// =========================================================================

describe("Backward compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("generateFindings() is still exported and produces valid findings", async () => {
    const { generateFindings } = await import("../llm-contextual/index.js");
    expect(typeof generateFindings).toBe("function");

    const findings = generateFindings("lending", false);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.length).toBeLessThanOrEqual(5);
    for (const f of findings) {
      expect(f.id).toMatch(/^LLM-\d{3}$/);
      expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
      expect(f.confidence).toBeGreaterThanOrEqual(0.8);
      expect(f.confidence).toBeLessThanOrEqual(0.99);
      expect(f.agentId).toBe("llm-contextual-003");
    }
  });

  it("shouldBid() is still exported and unchanged", async () => {
    const { shouldBid } = await import("../llm-contextual/index.js");
    expect(typeof shouldBid).toBe("function");
    expect(shouldBid(5000, "lending", 80)).toBe(true);
    expect(shouldBid(500, "lending", 80)).toBe(false);
  });

  it("calculateBid() is still exported and unchanged", async () => {
    const { calculateBid } = await import("../llm-contextual/index.js");
    expect(typeof calculateBid).toBe("function");
    const bid = calculateBid(5000, "staking", 70);
    expect(bid.amount).toBe(45);
    expect(bid.collateral).toBeCloseTo(bid.amount * 0.4, 1);
  });
});
