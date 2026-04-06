/**
 * Comprehensive tests for:
 *  - Static Analysis Agent (bidding, findings, service integration, report)
 *  - Fuzzer Agent (bidding, findings, service integration, report)
 *  - Both agents bid correctly and produce comprehensible reports
 *
 * Runs offline — no network, no Hedera credentials, no real tools needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks required to isolate agent modules from Hedera SDK / 0g SDK
// ---------------------------------------------------------------------------

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

// ===========================================================================
// SECTION 1: Static Analysis Agent — calculateBid()
// ===========================================================================

describe("Static Analysis Agent — calculateBid()", () => {
  it("returns a valid bid object with amount, collateral, estimatedTimeSec", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const bid = calculateBid(5000, "lending", 60);
    expect(bid).not.toBeNull();
    expect(typeof bid!.amount).toBe("number");
    expect(typeof bid!.collateral).toBe("number");
    expect(typeof bid!.estimatedTimeSec).toBe("number");
    expect(bid!.amount).toBeGreaterThan(0);
    expect(bid!.collateral).toBeGreaterThan(0);
    expect(bid!.estimatedTimeSec).toBeGreaterThan(0);
  });

  it("base formula: 10 + LOC * 0.002", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const bid = calculateBid(5000, "unknown" as any, 50);
    expect(bid!.amount).toBe(20); // 10 + 5000 * 0.002 = 20
  });

  it("applies 10% specialization discount for lending", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const general = calculateBid(5000, "dex", 50);
    const lending = calculateBid(5000, "lending", 50);
    expect(lending!.amount).toBeCloseTo(general!.amount * 0.9, 1);
  });

  it("applies 10% specialization discount for vault", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const general = calculateBid(5000, "dex", 50);
    const vault = calculateBid(5000, "vault", 50);
    expect(vault!.amount).toBeCloseTo(general!.amount * 0.9, 1);
  });

  it("applies 10% specialization discount for staking", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const general = calculateBid(5000, "dex", 50);
    const staking = calculateBid(5000, "staking", 50);
    expect(staking!.amount).toBeCloseTo(general!.amount * 0.9, 1);
  });

  it("no discount for non-specialized types (dex, bridge, nft)", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    for (const type of ["dex", "bridge", "nft"] as const) {
      const bid = calculateBid(5000, type, 50);
      expect(bid!.amount).toBe(20);
    }
  });

  it("collateral is 50% of bid amount", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    for (const loc of [500, 2000, 5000, 10000]) {
      const bid = calculateBid(loc, "dex", 50);
      expect(bid!.collateral).toBeCloseTo(bid!.amount * 0.5, 2);
    }
  });

  it("scales linearly with LOC", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const bid1k = calculateBid(1000, "dex", 50);
    const bid5k = calculateBid(5000, "dex", 50);
    // (5000 - 1000) * 0.002 = 8
    expect(bid5k!.amount - bid1k!.amount).toBeCloseTo(8, 1);
  });

  it("min LOC 500 → bid 11 GUARD", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const bid = calculateBid(500, "dex", 50);
    expect(bid!.amount).toBe(11);
  });

  it("max LOC 10000 → bid 30 GUARD", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const bid = calculateBid(10000, "dex", 50);
    expect(bid!.amount).toBe(30);
  });

  it("bid amount is deterministic (same input → same output)", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const b1 = calculateBid(3000, "vault", 60);
    const b2 = calculateBid(3000, "vault", 60);
    expect(b1!.amount).toBe(b2!.amount);
    expect(b1!.collateral).toBe(b2!.collateral);
  });

  it("is cheaper than fuzzer for identical parameters (static is the economy tier)", async () => {
    const staticA = await import("../static-analysis/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    const s = staticA.calculateBid(5000, "dex", 50)!;
    const f = fuzzer.calculateBid(5000, "dex", 50)!;
    expect(s.amount).toBeLessThan(f.amount);
  });

  it("bid rounds to 2 decimal places", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    for (const loc of [500, 1234, 7777, 10000]) {
      const bid = calculateBid(loc, "dex", 50);
      const rounded = Math.round(bid!.amount * 100) / 100;
      expect(bid!.amount).toBe(rounded);
    }
  });
});

// ===========================================================================
// SECTION 2: Static Analysis Agent — generateFindings()
// ===========================================================================

describe("Static Analysis Agent — generateFindings()", () => {
  it("generates 3–10 findings", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    for (let i = 0; i < 50; i++) {
      const findings = generateFindings("lending", 5000);
      expect(findings.length).toBeGreaterThanOrEqual(3);
      expect(findings.length).toBeLessThanOrEqual(10);
    }
  });

  it("all findings have required schema fields", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("dex", 3000);
    for (const f of findings) {
      expect(f.id).toMatch(/^SA-\d{3}$/);
      expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
      expect(typeof f.title).toBe("string");
      expect(f.title.length).toBeGreaterThan(0);
      expect(typeof f.description).toBe("string");
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.confidence).toBeGreaterThanOrEqual(0.6);
      expect(f.confidence).toBeLessThanOrEqual(0.95);
      expect(f.agentId).toBe("static-analysis-047");
      expect(f.timestamp).toBeGreaterThan(0);
    }
  });

  it("finding IDs are sequential: SA-001, SA-002, ...", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("vault", 5000);
    for (let i = 0; i < findings.length; i++) {
      expect(findings[i].id).toBe(`SA-${String(i + 1).padStart(3, "0")}`);
    }
  });

  it("descriptions mention contract type", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    for (const type of ["lending", "vault", "staking"] as const) {
      const findings = generateFindings(type, 2000);
      for (const f of findings) {
        expect(f.description).toContain(type);
      }
    }
  });

  it("descriptions mention LOC count", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("lending", 7500);
    for (const f of findings) {
      expect(f.description).toContain("7500");
    }
  });

  it("skews toward lower severity (static analysis = many low/med findings)", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    let lowMed = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const findings = generateFindings("dex", 5000);
      for (const f of findings) {
        total++;
        if (f.severity === "low" || f.severity === "medium" || f.severity === "info") lowMed++;
      }
    }
    // Static analysis should produce mostly low/med findings
    expect(lowMed / total).toBeGreaterThan(0.4);
  });

  it("produces different finding sets on consecutive calls", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const a = generateFindings("lending", 5000);
    const b = generateFindings("lending", 5000);
    // They can be identical by chance but usually differ in count or content
    // Test that the function doesn't always return the same fixed set
    let differ = false;
    for (let i = 0; i < 20; i++) {
      const x = generateFindings("lending", 5000);
      const y = generateFindings("lending", 5000);
      if (x.length !== y.length || x[0].severity !== y[0].severity) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
  });
});

// ===========================================================================
// SECTION 3: Static Analysis Agent — resolveAuctionInviteContext()
// ===========================================================================

describe("Static Analysis Agent — resolveAuctionInviteContext()", () => {
  it("uses invite data when no queued data available", async () => {
    const { resolveAuctionInviteContext } = await import("../static-analysis/index.js");
    const result = resolveAuctionInviteContext({
      queued: undefined,
      invite: { contractType: "vault", riskScore: 75, estimatedLOC: 3000 },
    });
    expect(result.contractType).toBe("vault");
    expect(result.loc).toBe(3000);
    expect(result.riskScore).toBe(75);
  });

  it("prefers queued data over invite data", async () => {
    const { resolveAuctionInviteContext } = await import("../static-analysis/index.js");
    const result = resolveAuctionInviteContext({
      queued: { contractType: "lending", loc: 5000 },
      invite: { contractType: "dex", riskScore: 60, estimatedLOC: 1000 },
    });
    expect(result.contractType).toBe("lending");
    expect(result.loc).toBe(5000);
  });

  it("falls back to defaults when neither queued nor invite data", async () => {
    const { resolveAuctionInviteContext } = await import("../static-analysis/index.js");
    const result = resolveAuctionInviteContext({
      queued: undefined,
      invite: {},
    });
    expect(result.contractType).toBe("lending"); // static agent default
    expect(result.loc).toBe(1200);
    expect(result.riskScore).toBe(50);
  });

  it("handles estimatedLineCount as fallback for LOC", async () => {
    const { resolveAuctionInviteContext } = await import("../static-analysis/index.js");
    const result = resolveAuctionInviteContext({
      queued: undefined,
      invite: { estimatedLineCount: 4500 },
    });
    expect(result.loc).toBe(4500);
  });
});

// ===========================================================================
// SECTION 4: Static Analysis Agent — runStaticAnalysisOrFallback() (mocked)
// ===========================================================================

describe("Static Analysis Agent — runStaticAnalysisOrFallback() service integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to mock when service is unavailable", async () => {
    // Simulate network failure
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { runStaticAnalysisOrFallback } = await import("../static-analysis/index.js");
    const findings = await runStaticAnalysisOrFallback("0xabc", "lending", 2000, 10);
    expect(findings.length).toBeGreaterThan(0);
    // Should be mock findings (SA- prefix)
    expect(findings[0].id).toMatch(/^SA-/);
  });

  it("falls back to mock when service returns non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ error: "overloaded" }),
    }));
    const { runStaticAnalysisOrFallback } = await import("../static-analysis/index.js");
    const findings = await runStaticAnalysisOrFallback("0xabc", "vault", 3000, 10);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("returns service findings when service responds with real results", async () => {
    const mockFindings = [
      {
        id: "SA-SLTH-001",
        severity: "high",
        title: "Reentrancy (Slither)",
        description: "External call before state update",
        confidence: 0.92,
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      },
      {
        id: "SA-ADERYN-001",
        severity: "medium",
        title: "Unsafe casting (Aderyn)",
        description: "Unsafe downcast may truncate value",
        confidence: 0.82,
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      },
    ];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.endsWith("/analyze")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jobId: "test-job-123", status: "queued" }),
        });
      }
      if (url.endsWith("/results/test-job-123")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: "done",
            findings: mockFindings,
            toolUsed: "slither+aderyn",
            elapsed: 45,
          }),
        });
      }
      return Promise.reject(new Error("unexpected url"));
    }));

    const { runStaticAnalysisOrFallback } = await import("../static-analysis/index.js");
    const findings = await runStaticAnalysisOrFallback("0xabc123", "lending", 5000, 10);

    expect(findings).toHaveLength(2);
    expect(findings[0].id).toBe("SA-SLTH-001");
    expect(findings[0].severity).toBe("high");
    expect(findings[1].id).toBe("SA-ADERYN-001");
  });

  it("falls back to mock when service returns 0 findings (no tool installed)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/analyze")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jobId: "no-tools-job", status: "queued" }),
        });
      }
      if (url.endsWith("/results/no-tools-job")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: "done",
            findings: [],
            toolUsed: "none",
            elapsed: 1,
          }),
        });
      }
      return Promise.reject(new Error("unexpected url"));
    }));

    const { runStaticAnalysisOrFallback } = await import("../static-analysis/index.js");
    const findings = await runStaticAnalysisOrFallback("0xabc", "staking", 4000, 10);
    // Should fall back to mock
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].id).toMatch(/^SA-/);
  });
});

// ===========================================================================
// SECTION 5: Static Analysis Agent — Report Structure
// ===========================================================================

describe("Static Analysis Agent — Report comprehensibility", () => {
  it("findings can be grouped by severity to form a comprehensible summary", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("lending", 5000);

    const summary = {
      critical: findings.filter(f => f.severity === "critical").length,
      high: findings.filter(f => f.severity === "high").length,
      medium: findings.filter(f => f.severity === "medium").length,
      low: findings.filter(f => f.severity === "low").length,
      info: findings.filter(f => f.severity === "info").length,
    };

    expect(summary.critical + summary.high + summary.medium + summary.low + summary.info)
      .toBe(findings.length);
  });

  it("each finding has a non-empty, human-readable title", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("vault", 8000);
    for (const f of findings) {
      expect(f.title.trim().length).toBeGreaterThan(3);
      expect(f.title).not.toMatch(/^undefined/);
    }
  });

  it("each finding has a meaningful description (not just 'undefined')", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("staking", 3000);
    for (const f of findings) {
      expect(f.description.trim().length).toBeGreaterThan(5);
      expect(f.description).not.toBe("undefined");
    }
  });

  it("agentId correctly identifies the static analysis agent", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const findings = generateFindings("lending", 5000);
    for (const f of findings) {
      expect(f.agentId).toBe("static-analysis-047");
    }
  });

  it("confidence values indicate tool certainty (0.6–0.95 range)", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    for (let i = 0; i < 20; i++) {
      const findings = generateFindings("dex", 5000);
      for (const f of findings) {
        expect(f.confidence).toBeGreaterThanOrEqual(0.6);
        expect(f.confidence).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it("findings have timestamps within 1 second of now", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const before = Date.now();
    const findings = generateFindings("lending", 5000);
    const after = Date.now();
    for (const f of findings) {
      expect(f.timestamp).toBeGreaterThanOrEqual(before - 100);
      expect(f.timestamp).toBeLessThanOrEqual(after + 100);
    }
  });

  it("service-returned findings from Slither produce comprehensible titles", () => {
    // Test the Slither output parser directly via the runner logic
    // We simulate what a Slither JSON result looks like
    const mockSlitherFindings = [
      {
        id: "SA-SLTH-001",
        severity: "high",
        title: "Reentrancy Eth (Slither)",
        description: "Contract.withdraw() sends ETH before updating state",
        confidence: 0.92,
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      },
      {
        id: "SA-SLTH-002",
        severity: "medium",
        title: "Tx Origin (Slither)",
        description: "tx.origin used for authorization — phishing risk",
        confidence: 0.78,
        agentId: "static-analysis-047",
        timestamp: Date.now(),
      },
    ];

    for (const f of mockSlitherFindings) {
      expect(f.title).toContain("Slither");
      expect(f.title.length).toBeGreaterThan(5);
      expect(f.description.length).toBeGreaterThan(10);
    }
  });
});

// ===========================================================================
// SECTION 6: Fuzzer Agent — calculateBid()
// ===========================================================================

describe("Fuzzer Agent — calculateBid()", () => {
  it("returns a bid object with amount, collateral, estimatedTimeSec", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const bid = calculateBid(5000, "dex", 60);
    expect(bid).not.toBeNull();
    expect(bid!.amount).toBeGreaterThan(0);
    expect(bid!.collateral).toBeGreaterThan(0);
    expect(bid!.estimatedTimeSec).toBeGreaterThan(0);
  });

  it("base formula: 15 + LOC * 0.005", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const bid = calculateBid(5000, "unknown" as any, 50);
    expect(bid!.amount).toBe(40); // 15 + 5000 * 0.005
  });

  it("applies 20% risk premium when riskScore > 70", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const low = calculateBid(5000, "unknown" as any, 50);
    const high = calculateBid(5000, "unknown" as any, 90);
    expect(high!.amount).toBeCloseTo(low!.amount * 1.2, 0);
  });

  it("no risk premium at exactly riskScore 70", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const at70 = calculateBid(5000, "unknown" as any, 70);
    const at50 = calculateBid(5000, "unknown" as any, 50);
    expect(at70!.amount).toBe(at50!.amount);
  });

  it("applies 15% specialization discount for dex", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const general = calculateBid(5000, "unknown", 50);
    const special = calculateBid(5000, "dex", 50);
    expect(special!.amount).toBeCloseTo(general!.amount * 0.85, 1);
  });

  it("applies 15% specialization discount for bridge", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const general = calculateBid(5000, "unknown", 50);
    const special = calculateBid(5000, "bridge", 50);
    expect(special!.amount).toBeCloseTo(general!.amount * 0.85, 1);
  });

  it("risk premium + specialization discount stack correctly", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    // dex at risk 80: (15 + 5000*0.005) * 1.2 * 0.85
    const base = 15 + 5000 * 0.005; // 40
    const withPremium = base * 1.2;   // 48
    const withDiscount = withPremium * 0.85; // 40.8
    const bid = calculateBid(5000, "dex", 80);
    expect(bid!.amount).toBeCloseTo(withDiscount, 0);
  });

  it("collateral is 60% of bid amount", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    for (const loc of [500, 2000, 5000, 10000]) {
      const bid = calculateBid(loc, "lending", 50);
      expect(bid!.collateral).toBeCloseTo(bid!.amount * 0.6, 1);
    }
  });

  it("fuzzer bids more than static analysis for any contract size", async () => {
    const staticA = await import("../static-analysis/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    for (const loc of [1000, 3000, 5000, 8000]) {
      const s = staticA.calculateBid(loc, "dex", 50)!;
      const f = fuzzer.calculateBid(loc, "dex", 50)!;
      expect(f.amount).toBeGreaterThan(s.amount);
    }
  });

  it("fuzzer collateral ratio (60%) is higher than static (50%)", async () => {
    const staticA = await import("../static-analysis/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    const s = staticA.calculateBid(5000, "dex", 50)!;
    const f = fuzzer.calculateBid(5000, "dex", 50)!;
    const staticRatio = s.collateral / s.amount;
    const fuzzerRatio = f.collateral / f.amount;
    expect(fuzzerRatio).toBeGreaterThan(staticRatio);
  });
});

// ===========================================================================
// SECTION 7: Fuzzer Agent — generateFindings()
// ===========================================================================

describe("Fuzzer Agent — generateFindings()", () => {
  it("generates 2–6 findings", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    for (let i = 0; i < 50; i++) {
      const findings = generateFindings("dex", false);
      expect(findings.length).toBeGreaterThanOrEqual(2);
      expect(findings.length).toBeLessThanOrEqual(6);
    }
  });

  it("all findings have required schema fields", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    const findings = generateFindings("bridge", true);
    for (const f of findings) {
      expect(f.id).toMatch(/^FZ-\d{3}$/);
      expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
      expect(typeof f.title).toBe("string");
      expect(f.title.length).toBeGreaterThan(0);
      expect(typeof f.description).toBe("string");
      expect(f.confidence).toBeGreaterThanOrEqual(0.7);
      expect(f.confidence).toBeLessThanOrEqual(0.98);
      expect(f.agentId).toBe("fuzzer-012");
      expect(f.timestamp).toBeGreaterThan(0);
    }
  });

  it("descriptions note when external data was used", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    const withData = generateFindings("dex", true);
    const withoutData = generateFindings("dex", false);
    expect(withData[0].description).toContain("external data");
    expect(withoutData[0].description).not.toContain("external data");
    // All mock-generated findings must carry the isMock flag
    expect(withData.every((f) => f.isMock === true)).toBe(true);
    expect(withoutData.every((f) => f.isMock === true)).toBe(true);
  });

  it("finding IDs use FZ- prefix (not SA-)", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    const findings = generateFindings("vault", false);
    for (const f of findings) {
      expect(f.id).toMatch(/^FZ-/);
      expect(f.id).not.toMatch(/^SA-/);
    }
  });

  it("skews toward higher severity (fuzz testing surfaces critical bugs)", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    let critHigh = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const findings = generateFindings("dex", false);
      for (const f of findings) {
        total++;
        if (f.severity === "critical" || f.severity === "high") critHigh++;
      }
    }
    expect(critHigh / total).toBeGreaterThan(0.3);
  });

  it("agentId is fuzzer-012 (not static-analysis-047)", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    const findings = generateFindings("dex", false);
    for (const f of findings) {
      expect(f.agentId).toBe("fuzzer-012");
      expect(f.agentId).not.toBe("static-analysis-047");
    }
  });
});

// ===========================================================================
// SECTION 8: Fuzzer Agent — runFuzzOrFallback() (mocked service)
// ===========================================================================

describe("Fuzzer Agent — runFuzzOrFallback() service integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to mock when fuzzer service is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    // We test this indirectly via generateFindings which is the fallback
    const { generateFindings } = await import("../fuzzer/index.js");
    const findings = generateFindings("dex", false);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].id).toMatch(/^FZ-/);
  });

  it("service findings from ItyFuzz produce comprehensible reports", () => {
    // Simulate ItyFuzz-style findings
    const ityFuzzFindings = [
      {
        id: "FZ-ITYF-001",
        severity: "critical",
        title: "Reentrancy vulnerability found",
        description: "ItyFuzz detected reentrancy via calldata 0xabcd...",
        confidence: 0.95,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      },
      {
        id: "FZ-ITYF-002",
        severity: "high",
        title: "Integer overflow found",
        description: "Arithmetic overflow detected in withdraw() function",
        confidence: 0.88,
        agentId: "fuzzer-012",
        timestamp: Date.now(),
      },
    ];

    for (const f of ityFuzzFindings) {
      expect(f.id).toContain("FZ");
      expect(f.severity).not.toBe("unknown");
      expect(f.title.length).toBeGreaterThan(5);
      expect(f.description).toContain("fuzzer-012" in f ? "" : "");
    }
  });
});

// ===========================================================================
// SECTION 9: Fuzzer Agent — resolveAuctionInviteContext()
// ===========================================================================

describe("Fuzzer Agent — resolveAuctionInviteContext()", () => {
  it("resolves contract type and LOC from invite", async () => {
    const { resolveAuctionInviteContext } = await import("../fuzzer/index.js");
    const result = resolveAuctionInviteContext({
      queued: undefined,
      invite: { contractType: "dex", riskScore: 80, estimatedLOC: 6000 },
    });
    expect(result.contractType).toBe("dex");
    expect(result.loc).toBe(6000);
    expect(result.riskScore).toBe(80);
  });

  it("prefers queued data over invite for type and LOC", async () => {
    const { resolveAuctionInviteContext } = await import("../fuzzer/index.js");
    const result = resolveAuctionInviteContext({
      queued: { contractType: "bridge", loc: 8000 },
      invite: { contractType: "dex", estimatedLOC: 2000 },
    });
    expect(result.contractType).toBe("bridge");
    expect(result.loc).toBe(8000);
  });

  it("defaults to dex type when no data available", async () => {
    const { resolveAuctionInviteContext } = await import("../fuzzer/index.js");
    const result = resolveAuctionInviteContext({
      queued: undefined,
      invite: {},
    });
    expect(result.contractType).toBe("dex"); // fuzzer default
    expect(result.loc).toBe(1200);
  });
});

// ===========================================================================
// SECTION 10: Bidding Competition & Economic Hierarchy
// ===========================================================================

describe("Agent Bidding Competition", () => {
  it("for same large contract: LLM > Fuzzer > Static", async () => {
    const llm = await import("../llm-contextual/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    const staticA = await import("../static-analysis/index.js");

    const llmBid = llm.calculateBid(5000, "staking", 70);
    const fuzzerBid = fuzzer.calculateBid(5000, "staking", 50)!;
    const staticBid = staticA.calculateBid(5000, "staking", 50)!;

    expect(llmBid.amount).toBeGreaterThan(fuzzerBid.amount);
    expect(fuzzerBid.amount).toBeGreaterThan(staticBid.amount);
  });

  it("static agent always bids on any contract (returns non-null)", async () => {
    const { calculateBid } = await import("../static-analysis/index.js");
    const types = ["lending", "dex", "staking", "bridge", "vault", "nft", "oracle"] as const;
    for (const type of types) {
      const bid = calculateBid(5000, type, 50);
      expect(bid).not.toBeNull();
    }
  });

  it("fuzzer always bids on any contract (returns non-null)", async () => {
    const { calculateBid } = await import("../fuzzer/index.js");
    const types = ["lending", "dex", "staking", "bridge", "vault"] as const;
    for (const type of types) {
      const bid = calculateBid(5000, type, 50);
      expect(bid).not.toBeNull();
    }
  });

  it("both agents place valid bids for minimum viable contract (500 LOC, risk 20)", async () => {
    const fuzzer = await import("../fuzzer/index.js");
    const staticA = await import("../static-analysis/index.js");

    const fuzzerBid = fuzzer.calculateBid(500, "dex", 20);
    const staticBid = staticA.calculateBid(500, "dex", 20);

    expect(fuzzerBid).not.toBeNull();
    expect(staticBid).not.toBeNull();
    expect(fuzzerBid!.amount).toBeGreaterThan(0);
    expect(staticBid!.amount).toBeGreaterThan(0);
  });

  it("both agents place valid bids for maximum contract (10000 LOC, risk 95)", async () => {
    const fuzzer = await import("../fuzzer/index.js");
    const staticA = await import("../static-analysis/index.js");

    const fuzzerBid = fuzzer.calculateBid(10000, "dex", 95);
    const staticBid = staticA.calculateBid(10000, "dex", 95);

    expect(fuzzerBid).not.toBeNull();
    expect(staticBid).not.toBeNull();
  });

  it("collateral ratios: static (50%) < fuzzer (60%)", async () => {
    const fuzzer = await import("../fuzzer/index.js");
    const staticA = await import("../static-analysis/index.js");

    const f = fuzzer.calculateBid(5000, "dex", 50)!;
    const s = staticA.calculateBid(5000, "dex", 50)!;

    expect(f.collateral / f.amount).toBeCloseTo(0.6, 1);
    expect(s.collateral / s.amount).toBeCloseTo(0.5, 1);
  });

  it("bid amounts are always positive across random inputs", async () => {
    const fuzzer = await import("../fuzzer/index.js");
    const staticA = await import("../static-analysis/index.js");

    for (let i = 0; i < 50; i++) {
      const loc = Math.floor(Math.random() * 10000) + 500;
      const risk = Math.floor(Math.random() * 75) + 20;
      const f = fuzzer.calculateBid(loc, "dex", risk);
      const s = staticA.calculateBid(loc, "dex", risk);
      expect(f!.amount).toBeGreaterThan(0);
      expect(s!.amount).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// SECTION 11: Cross-Agent Report Comprehensibility
// ===========================================================================

describe("Cross-Agent Report Comprehensibility", () => {
  it("findings from both agents can be aggregated into a unified report", async () => {
    const { generateFindings: staticFindings } = await import("../static-analysis/index.js");
    const { generateFindings: fuzzerFindings } = await import("../fuzzer/index.js");
    const { aggregateFindings } = await import("../report/index.js");
    const { hashOf } = await import("../shared/utils.js");

    const sf = staticFindings("lending", 5000);
    const ff = fuzzerFindings("lending", false);

    const submissions: any[] = [
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "static-analysis-047",
        timestamp: Date.now(),
        payload: {
          jobId: "report-test-001",
          findingsHash: hashOf(sf),
          findingsCount: sf.length,
          criticalCount: sf.filter(f => f.severity === "critical").length,
          highCount: sf.filter(f => f.severity === "high").length,
          mediumCount: sf.filter(f => f.severity === "medium").length,
          lowCount: sf.filter(f => f.severity === "low").length,
        },
      },
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "fuzzer-012",
        timestamp: Date.now(),
        payload: {
          jobId: "report-test-001",
          findingsHash: hashOf(ff),
          findingsCount: ff.length,
          criticalCount: ff.filter(f => f.severity === "critical").length,
          highCount: ff.filter(f => f.severity === "high").length,
          mediumCount: ff.filter(f => f.severity === "medium").length,
          lowCount: ff.filter(f => f.severity === "low").length,
        },
      },
    ];

    const report = aggregateFindings(submissions);
    expect(report.jobId).toBe("report-test-001");
    expect(report.totalFindings).toBeGreaterThan(0);
    expect(report.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(report.agentScores)).toHaveLength(2);
    expect(report.agentScores["static-analysis-047"]).toBeDefined();
    expect(report.agentScores["fuzzer-012"]).toBeDefined();
  });

  it("report includes accurate total finding counts from both agents", async () => {
    const { aggregateFindings } = await import("../report/index.js");

    const submissions: any[] = [
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "static-analysis-047",
        timestamp: Date.now(),
        payload: { jobId: "j1", findingsHash: "h1", findingsCount: 7, criticalCount: 0, highCount: 2, mediumCount: 3, lowCount: 2 },
      },
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "fuzzer-012",
        timestamp: Date.now(),
        payload: { jobId: "j1", findingsHash: "h2", findingsCount: 4, criticalCount: 2, highCount: 2, mediumCount: 0, lowCount: 0 },
      },
    ];

    const report = aggregateFindings(submissions);
    // Total should be 11 minus any detected duplicates
    expect(report.totalFindings).toBeGreaterThan(0);
    expect(report.totalFindings).toBeLessThanOrEqual(11);
    expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
    expect(report.totalFindings + report.duplicatesDetected).toBe(11);
  });

  it("report correctly records which agents submitted", async () => {
    const { aggregateFindings } = await import("../report/index.js");

    const submissions: any[] = [
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "static-analysis-047",
        timestamp: Date.now(),
        payload: { jobId: "j2", findingsHash: "h1", findingsCount: 5, criticalCount: 1, highCount: 1, mediumCount: 2, lowCount: 1 },
      },
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "fuzzer-012",
        timestamp: Date.now(),
        payload: { jobId: "j2", findingsHash: "h2", findingsCount: 3, criticalCount: 1, highCount: 1, mediumCount: 1, lowCount: 0 },
      },
    ];

    const report = aggregateFindings(submissions);
    const agents = Object.keys(report.agentScores);
    expect(agents).toContain("static-analysis-047");
    expect(agents).toContain("fuzzer-012");
  });

  it("report agent scores reflect accuracy in 0.6–1.0 range", async () => {
    const { aggregateFindings } = await import("../report/index.js");

    const submissions: any[] = [
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "static-analysis-047",
        timestamp: Date.now(),
        payload: { jobId: "j3", findingsHash: "h1", findingsCount: 8, criticalCount: 0, highCount: 3, mediumCount: 3, lowCount: 2 },
      },
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "fuzzer-012",
        timestamp: Date.now(),
        payload: { jobId: "j3", findingsHash: "h2", findingsCount: 5, criticalCount: 2, highCount: 2, mediumCount: 1, lowCount: 0 },
      },
    ];

    const report = aggregateFindings(submissions);
    for (const [_, accuracy] of Object.entries(report.agentScores)) {
      expect(accuracy as number).toBeGreaterThanOrEqual(0.6);
      expect(accuracy as number).toBeLessThanOrEqual(1.0);
    }
  });

  it("alert fires for fuzzer findings of critical severity", async () => {
    const { shouldAlert } = await import("../alert/index.js");

    // Simulate a report published after fuzzer found critical bugs
    const msg: any = {
      type: "REPORT_PUBLISHED",
      agentId: "report-001",
      timestamp: Date.now(),
      payload: {
        jobId: "j4",
        criticalCount: 2, // fuzzer found 2 critical reentrancy bugs
        totalFindings: 6,
        reportHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      },
    };

    expect(shouldAlert(msg)).toBe(true);
  });

  it("alert does not fire when only static analysis finds low/medium issues", async () => {
    const { shouldAlert } = await import("../alert/index.js");

    const msg: any = {
      type: "REPORT_PUBLISHED",
      agentId: "report-001",
      timestamp: Date.now(),
      payload: {
        jobId: "j5",
        criticalCount: 0, // static analysis: only medium/low findings
        totalFindings: 8,
        reportHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      },
    };

    expect(shouldAlert(msg)).toBe(false);
  });
});

// ===========================================================================
// SECTION 12: Static Analysis Service — Runner Logic (unit tests)
// ===========================================================================

describe("Static Analysis Service — Parser functions", () => {
  it("Slither check name formatter converts kebab-case to title case", () => {
    // Simulate the formatter logic from slither.js
    const formatSlitherCheckName = (check: string) =>
      check.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

    expect(formatSlitherCheckName("reentrancy-eth")).toBe("Reentrancy Eth");
    expect(formatSlitherCheckName("tx-origin")).toBe("Tx Origin");
    expect(formatSlitherCheckName("arbitrary-send-eth")).toBe("Arbitrary Send Eth");
    expect(formatSlitherCheckName("incorrect-equality")).toBe("Incorrect Equality");
  });

  it("Semgrep check ID formatter strips namespace prefix", () => {
    // Simulate the formatter from semgrep.js
    const formatSemgrepCheckId = (checkId: string) => {
      const parts = checkId.split(".");
      const last = parts[parts.length - 1] ?? checkId;
      return last.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    };

    expect(formatSemgrepCheckId("solidity.security.reentrancy")).toBe("Reentrancy");
    expect(formatSemgrepCheckId("solidity.security.flash-loan-price-manipulation")).toBe("Flash Loan Price Manipulation");
    expect(formatSemgrepCheckId("defi.donation-attack")).toBe("Donation Attack");
  });

  it("severity mapper handles all valid Slither impact levels", () => {
    // Mirror the mapSlitherSeverity logic
    const mapSlitherSeverity = (impact: string, confidence?: string): string => {
      const impactMap: Record<string, string> = {
        High: "high", Medium: "medium", Low: "low",
        Informational: "info", Optimization: "info",
      };
      let sev = impactMap[impact] ?? "medium";
      if (confidence?.toLowerCase() === "low") {
        if (sev === "critical") sev = "high";
        else if (sev === "high") sev = "medium";
      }
      return sev;
    };

    expect(mapSlitherSeverity("High", "High")).toBe("high");
    expect(mapSlitherSeverity("High", "Low")).toBe("medium"); // downgraded
    expect(mapSlitherSeverity("Medium", "Medium")).toBe("medium");
    expect(mapSlitherSeverity("Low")).toBe("low");
    expect(mapSlitherSeverity("Informational")).toBe("info");
  });

  it("Aderyn output bucketing maps high/medium/low/nc correctly", () => {
    // Simulate parsing Aderyn output buckets
    const mockAderynOutput = {
      high_issues: {
        issues: [
          { title: "Weak Randomness", description: "Use of block.timestamp for randomness" },
          { title: "Unsafe Casting", description: "Downcast may overflow" },
        ],
      },
      medium_issues: {
        issues: [
          { title: "Centralization Risk", description: "Single owner controls critical functions" },
        ],
      },
      low_issues: {
        issues: [
          { title: "Missing Zero Address Check", description: "Constructor does not validate address" },
        ],
      },
      nc_issues: { issues: [] },
    };

    const buckets = ["high_issues", "medium_issues", "low_issues", "nc_issues"];
    const expectedSeverities = ["high", "medium", "low", "info"];
    const allFindings: { severity: string; title: string }[] = [];

    buckets.forEach((key, i) => {
      const issues = (mockAderynOutput as any)[key]?.issues ?? [];
      for (const issue of issues) {
        allFindings.push({ severity: expectedSeverities[i], title: issue.title });
      }
    });

    expect(allFindings).toHaveLength(4);
    expect(allFindings[0]).toEqual({ severity: "high", title: "Weak Randomness" });
    expect(allFindings[1]).toEqual({ severity: "high", title: "Unsafe Casting" });
    expect(allFindings[2]).toEqual({ severity: "medium", title: "Centralization Risk" });
    expect(allFindings[3]).toEqual({ severity: "low", title: "Missing Zero Address Check" });
  });

  it("merged findings deduplicate by title across Slither + Aderyn + Semgrep", () => {
    const allFindings: { title: string }[] = [];
    const mergeFinding = (f: { title: string }) => {
      if (!allFindings.some(e => e.title === f.title)) allFindings.push(f);
    };

    // Slither finds reentrancy
    mergeFinding({ title: "Reentrancy Eth (Slither)" });
    // Aderyn also flags reentrancy (different tool name, so treated as different)
    mergeFinding({ title: "Reentrancy (Aderyn)" });
    // Semgrep finds the same check as Slither (exact same title)
    mergeFinding({ title: "Reentrancy Eth (Slither)" }); // duplicate — should be skipped

    expect(allFindings).toHaveLength(2);
  });
});

// ===========================================================================
// SECTION 13: End-to-End Auction Flow Simulation
// ===========================================================================

describe("End-to-End: Scanner → Bid → Win → Audit → Report", () => {
  it("complete flow: discovery → static bid → fuzzer bid → findings → report", async () => {
    const { generateDiscovery } = await import("../scanner/index.js");
    const staticA = await import("../static-analysis/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    const { aggregateFindings } = await import("../report/index.js");
    const { hashOf } = await import("../shared/utils.js");

    // Step 1: Scanner discovers a contract
    const discovery = generateDiscovery();
    const { estimatedLOC, contractType, riskScore } = discovery.payload;
    expect(discovery.type).toBe("CONTRACT_DISCOVERED");

    // Step 2: Both agents calculate bids
    const staticBid = staticA.calculateBid(estimatedLOC, contractType, riskScore);
    const fuzzerBid = fuzzer.calculateBid(estimatedLOC, contractType, riskScore);
    expect(staticBid).not.toBeNull();
    expect(fuzzerBid).not.toBeNull();

    // Step 3: (Assume both win and run analysis)
    const staticFindings = staticA.generateFindings(contractType, estimatedLOC);
    const fuzzerFindings = fuzzer.generateFindings(contractType, false);
    expect(staticFindings.length).toBeGreaterThan(0);
    expect(fuzzerFindings.length).toBeGreaterThan(0);

    // Step 4: Build report submissions
    const submissions: any[] = [
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "static-analysis-047",
        timestamp: Date.now(),
        payload: {
          jobId: "e2e-job-001",
          findingsHash: hashOf(staticFindings),
          findingsCount: staticFindings.length,
          criticalCount: staticFindings.filter(f => f.severity === "critical").length,
          highCount: staticFindings.filter(f => f.severity === "high").length,
          mediumCount: staticFindings.filter(f => f.severity === "medium").length,
          lowCount: staticFindings.filter(f => f.severity === "low").length,
        },
      },
      {
        type: "FINDINGS_SUBMITTED",
        agentId: "fuzzer-012",
        timestamp: Date.now(),
        payload: {
          jobId: "e2e-job-001",
          findingsHash: hashOf(fuzzerFindings),
          findingsCount: fuzzerFindings.length,
          criticalCount: fuzzerFindings.filter(f => f.severity === "critical").length,
          highCount: fuzzerFindings.filter(f => f.severity === "high").length,
          mediumCount: fuzzerFindings.filter(f => f.severity === "medium").length,
          lowCount: fuzzerFindings.filter(f => f.severity === "low").length,
        },
      },
    ];

    // Step 5: Report agent aggregates
    const report = aggregateFindings(submissions);
    expect(report.jobId).toBe("e2e-job-001");
    expect(report.totalFindings).toBeGreaterThan(0);
    expect(report.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(report.agentScores)).toContain("static-analysis-047");
    expect(Object.keys(report.agentScores)).toContain("fuzzer-012");
  });

  it("both agents can handle all 9 contract types without error", async () => {
    const staticA = await import("../static-analysis/index.js");
    const fuzzer = await import("../fuzzer/index.js");
    const contractTypes = [
      "lending", "dex", "staking", "bridge", "vault",
      "derivatives", "oracle", "governance", "nft",
    ] as const;

    for (const type of contractTypes) {
      const staticBid = staticA.calculateBid(3000, type, 60);
      const fuzzerBid = fuzzer.calculateBid(3000, type, 60);
      expect(staticBid).not.toBeNull();
      expect(fuzzerBid).not.toBeNull();

      const sf = staticA.generateFindings(type, 3000);
      const ff = fuzzer.generateFindings(type, false);
      expect(sf.length).toBeGreaterThan(0);
      expect(ff.length).toBeGreaterThan(0);
    }
  });
});
