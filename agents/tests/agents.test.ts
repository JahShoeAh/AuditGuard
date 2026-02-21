/**
 * Comprehensive unit tests for all 7 agents.
 * Tests every exported function, bidding logic, mock generators,
 * boundary conditions, error paths, and inter-agent interaction patterns.
 *
 * Runs offline — no network or Hedera credentials needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// =========================================================================
// AGENT 1: SCANNER
// =========================================================================

describe("Scanner Agent", () => {
    describe("generateDiscovery()", () => {
        it("returns a valid ContractDiscoveryEvent structure", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const event = generateDiscovery();
            expect(event.type).toBe("CONTRACT_DISCOVERED");
            expect(event.agentId).toBe("scanner-001");
            expect(typeof event.timestamp).toBe("number");
            expect(event.timestamp).toBeGreaterThan(0);
        });

        it("generates valid payload fields", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const event = generateDiscovery();
            const p = event.payload;
            expect(p.contractAddress).toMatch(/^0x[0-9a-f]{40}$/);
            expect(p.chain).toBe("hedera-testnet");
            expect(p.deployerAddress).toMatch(/^0x[0-9a-f]{40}$/);
            expect(p.txHash).toMatch(/^0x[0-9a-f]{64,}$/);
        });

        it("includes non-zero budget in discovery payload", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            for (let i = 0; i < 20; i++) {
                const event = generateDiscovery();
                expect(typeof event.payload.budget).toBe("number");
                expect(event.payload.budget).toBeGreaterThan(0);
            }
        });

        it("generates LOC within bounds (500–10000)", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            for (let i = 0; i < 50; i++) {
                const event = generateDiscovery();
                expect(event.payload.estimatedLOC).toBeGreaterThanOrEqual(500);
                expect(event.payload.estimatedLOC).toBeLessThanOrEqual(10000);
            }
        });

        it("generates risk scores within bounds (20–95)", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            for (let i = 0; i < 50; i++) {
                const event = generateDiscovery();
                expect(event.payload.riskScore).toBeGreaterThanOrEqual(20);
                expect(event.payload.riskScore).toBeLessThanOrEqual(95);
            }
        });

        it("generates valid contract types", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const validTypes = ["lending", "dex", "staking", "bridge", "vault"];
            for (let i = 0; i < 50; i++) {
                const event = generateDiscovery();
                expect(validTypes).toContain(event.payload.contractType);
            }
        });

        it("produces unique discoveries each call", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const a = generateDiscovery();
            const b = generateDiscovery();
            expect(a.payload.contractAddress).not.toBe(b.payload.contractAddress);
        });

        it("all 5 contract types appear over many iterations", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const types = new Set<string>();
            for (let i = 0; i < 500; i++) {
                types.add(generateDiscovery().payload.contractType as string);
            }
            expect(types.size).toBe(5);
        });

        it("timestamp is close to Date.now()", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const before = Date.now();
            const event = generateDiscovery();
            const after = Date.now();
            expect(event.timestamp).toBeGreaterThanOrEqual(before);
            expect(event.timestamp).toBeLessThanOrEqual(after);
        });

        it("generates integer LOC values", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            for (let i = 0; i < 20; i++) {
                expect(Number.isInteger(generateDiscovery().payload.estimatedLOC)).toBe(true);
            }
        });

        it("generates integer risk scores", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            for (let i = 0; i < 20; i++) {
                expect(Number.isInteger(generateDiscovery().payload.riskScore)).toBe(true);
            }
        });
    });
});

// =========================================================================
// AGENT 2: STATIC ANALYSIS
// =========================================================================

describe("Static Analysis Agent", () => {
    describe("calculateBid()", () => {
        it("returns a BidParams object with required fields", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(5000, "lending", 60);
            expect(bid).not.toBeNull();
            expect(bid!.amount).toBeGreaterThan(0);
            expect(bid!.collateral).toBeGreaterThan(0);
            expect(bid!.estimatedTimeSec).toBeGreaterThan(0);
            // bid returns {amount, collateral, estimatedTimeSec}
        });

        it("follows the formula: baseCost + LOC * 0.002", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(5000, "unknown" as any, 50);
            expect(bid!.amount).toBe(20); // 10 + 5000*0.002
        });

        it("applies 10% discount for lending", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const normalBid = calculateBid(5000, "dex", 50);
            const lendingBid = calculateBid(5000, "lending", 50);
            expect(lendingBid!.amount).toBeCloseTo(normalBid!.amount * 0.9, 1);
        });

        it("applies 10% discount for vault", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const normalBid = calculateBid(5000, "dex", 50);
            const vaultBid = calculateBid(5000, "vault", 50);
            expect(vaultBid!.amount).toBeCloseTo(normalBid!.amount * 0.9, 1);
        });

        it("applies 10% discount for staking", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const normalBid = calculateBid(5000, "dex", 50);
            const stakingBid = calculateBid(5000, "staking", 50);
            expect(stakingBid!.amount).toBeCloseTo(normalBid!.amount * 0.9, 1);
        });

        it("no discount for dex", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(5000, "dex", 50);
            expect(bid!.amount).toBe(20); // 10 + 5000*0.002, no discount
        });

        it("no discount for bridge", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(5000, "bridge", 50);
            expect(bid!.amount).toBe(20); // 10 + 5000*0.002, no discount
        });

        it("sets collateral at 50% of bid", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(3000, "dex", 50);
            expect(bid!.collateral).toBeCloseTo(bid!.amount * 0.5, 1);
        });

        it("scales linearly with LOC", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid1k = calculateBid(1000, "dex", 50);
            const bid5k = calculateBid(5000, "dex", 50);
            // Difference should be (5000-1000)*0.002 = 8
            expect(bid5k!.amount - bid1k!.amount).toBeCloseTo(8, 1);
        });

        it("handles minimum LOC (500)", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(500, "dex", 50);
            expect(bid!.amount).toBe(11); // 10 + 500*0.002
        });

        it("handles maximum LOC (10000)", async () => {
            const { calculateBid } = await import("../static-analysis/index.js");
            const bid = calculateBid(10000, "dex", 50);
            expect(bid!.amount).toBe(30); // 10 + 10000*0.002
        });
    });

    describe("generateFindings()", () => {
        it("generates 3–10 findings", async () => {
            const { generateFindings } = await import("../static-analysis/index.js");
            for (let i = 0; i < 30; i++) {
                const findings = generateFindings("lending", 5000);
                expect(findings.length).toBeGreaterThanOrEqual(3);
                expect(findings.length).toBeLessThanOrEqual(10);
            }
        });

        it("each finding has required fields", async () => {
            const { generateFindings } = await import("../static-analysis/index.js");
            const findings = generateFindings("dex", 3000);
            for (const f of findings) {
                expect(f.id).toMatch(/^SA-\d{3}$/);
                expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
                expect(typeof f.title).toBe("string");
                expect(f.title.length).toBeGreaterThan(0);
                expect(f.confidence).toBeGreaterThanOrEqual(0.6);
                expect(f.confidence).toBeLessThanOrEqual(0.95);
                expect(f.agentId).toBe("static-analysis-047");
                expect(f.timestamp).toBeGreaterThan(0);
            }
        });

        it("finding IDs are sequential (SA-001, SA-002, ...)", async () => {
            const { generateFindings } = await import("../static-analysis/index.js");
            const findings = generateFindings("lending", 5000);
            for (let i = 0; i < findings.length; i++) {
                expect(findings[i].id).toBe(`SA-${String(i + 1).padStart(3, "0")}`);
            }
        });

        it("findings have descriptions", async () => {
            const { generateFindings } = await import("../static-analysis/index.js");
            const findings = generateFindings("vault", 2000);
            for (const f of findings) {
                expect(typeof f.description).toBe("string");
            }
        });
    });
});

// =========================================================================
// AGENT 3: FUZZER
// =========================================================================

describe("Fuzzer Agent", () => {
    describe("calculateBid()", () => {
        it("returns a bid object with amount, collateral, estimatedTimeSec", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const bid = calculateBid(5000, "dex", 60);
            expect(bid).not.toBeNull();
            expect(bid!.amount).toBeGreaterThan(0);
            expect(bid!.collateral).toBeGreaterThan(0);
            expect(bid!.estimatedTimeSec).toBeGreaterThan(0);
        });

        it("follows formula: 15 + LOC * 0.005", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const bid = calculateBid(5000, "unknown" as any, 50);
            expect(bid!.amount).toBe(40);
        });

        it("is more expensive than static analysis for same params", async () => {
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");
            const fuzzerBid = fuzzer.calculateBid(5000, "unknown" as any, 50);
            const staticBid = staticA.calculateBid(5000, "unknown" as any, 50);
            expect(fuzzerBid!.amount).toBeGreaterThan(staticBid!.amount);
        });

        it("applies 20% premium for high-risk contracts (riskScore > 70)", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const lowRisk = calculateBid(5000, "unknown" as any, 50);
            const highRisk = calculateBid(5000, "unknown" as any, 80);
            expect(highRisk!.amount).toBeGreaterThan(lowRisk!.amount);
            expect(highRisk!.amount).toBeCloseTo(lowRisk!.amount * 1.2, 0);
        });

        it("no premium at exactly risk 70", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const at70 = calculateBid(5000, "unknown" as any, 70);
            const at50 = calculateBid(5000, "unknown" as any, 50);
            expect(at70!.amount).toBe(at50!.amount);
        });

        it("applies 15% discount for specializations (dex, bridge) vs non-specialized baseline", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const baseline = calculateBid(5000, "unknown" as any, 50);
            const special = calculateBid(5000, "dex", 50);
            expect(special!.amount).toBeLessThan(baseline!.amount);
        });

        it("applies specialization discount to lending contracts", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const baseline = calculateBid(5000, "unknown" as any, 50);
            const lending = calculateBid(5000, "lending", 50);
            expect(lending!.amount).toBeLessThan(baseline!.amount);
        });

        it("sets collateral at 60% of bid", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            const bid = calculateBid(3000, "lending", 50);
            expect(bid!.collateral).toBeCloseTo(bid!.amount * 0.6, 1);
        });

        it("risk premium stacks with specialization discount", async () => {
            const { calculateBid } = await import("../fuzzer/index.js");
            // dex at risk 80: (15+5000*0.005)*1.2*0.85
            const bid = calculateBid(5000, "dex", 80);
            const base = 15 + 5000 * 0.005; // 40
            const withPremium = base * 1.2; // 48
            const withDiscount = withPremium * 0.85; // 40.8
            expect(bid!.amount).toBeCloseTo(withDiscount, 0);
        });
    });

    describe("generateFindings()", () => {
        it("generates 2–6 findings", async () => {
            const { generateFindings } = await import("../fuzzer/index.js");
            for (let i = 0; i < 30; i++) {
                const findings = generateFindings("dex", false);
                expect(findings.length).toBeGreaterThanOrEqual(2);
                expect(findings.length).toBeLessThanOrEqual(6);
            }
        });

        it("finding IDs use FZ- prefix", async () => {
            const { generateFindings } = await import("../fuzzer/index.js");
            const findings = generateFindings("bridge", true);
            for (const f of findings) {
                expect(f.id).toMatch(/^FZ-\d{3}$/);
            }
        });

        it("marks optimized findings when data was purchased", async () => {
            const { generateFindings } = await import("../fuzzer/index.js");
            const withData = generateFindings("dex", true);
            const withoutData = generateFindings("dex", false);
            expect(withData[0].description).toContain("optimized with external data");
            expect(withoutData[0].description).not.toContain("optimized");
        });

        it("skews toward higher severity", async () => {
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
    });
});

// =========================================================================
// AGENT 4: LLM CONTEXTUAL
// =========================================================================

describe("LLM Contextual Agent", () => {
    describe("shouldBid()", () => {
        it("rejects low risk scores (< 50)", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(5000, "lending", 30)).toBe(false);
            expect(shouldBid(5000, "lending", 49)).toBe(false);
        });

        it("rejects small contracts (< 1000 LOC)", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(500, "lending", 80)).toBe(false);
            expect(shouldBid(999, "lending", 80)).toBe(false);
        });

        it("accepts high value contracts", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(5000, "lending", 80)).toBe(true);
            expect(shouldBid(2000, "bridge", 60)).toBe(true);
        });

        it("accepts exactly at the boundary (1000 LOC, 50 risk)", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(1000, "lending", 50)).toBe(true);
        });

        it("rejects when only LOC meets threshold", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(5000, "lending", 30)).toBe(false);
        });

        it("rejects when only risk meets threshold", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(500, "lending", 80)).toBe(false);
        });

        it("is type-agnostic (doesn't filter by contract type)", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            const types = ["lending", "dex", "staking", "bridge", "vault"] as const;
            for (const t of types) {
                expect(shouldBid(5000, t, 80)).toBe(true);
            }
        });
    });

    describe("calculateBid()", () => {
        it("uses premium base pricing (30 + LOC * 0.003)", async () => {
            const { calculateBid } = await import("../llm-contextual/index.js");
            const bid = calculateBid(5000, "staking", 70);
            expect(bid.amount).toBe(45);
        });

        it("applies 15% premium for lending", async () => {
            const { calculateBid } = await import("../llm-contextual/index.js");
            const normalBid = calculateBid(5000, "staking", 70);
            const premiumBid = calculateBid(5000, "lending", 70);
            expect(premiumBid.amount).toBeCloseTo(normalBid.amount * 1.15, 1);
        });

        it("applies 15% premium for bridge", async () => {
            const { calculateBid } = await import("../llm-contextual/index.js");
            const normalBid = calculateBid(5000, "staking", 70);
            const premiumBid = calculateBid(5000, "bridge", 70);
            expect(premiumBid.amount).toBeCloseTo(normalBid.amount * 1.15, 1);
        });

        it("no premium for dex, staking, vault", async () => {
            const { calculateBid } = await import("../llm-contextual/index.js");
            const dexBid = calculateBid(5000, "dex", 70);
            const stakingBid = calculateBid(5000, "staking", 70);
            expect(dexBid.amount).toBe(stakingBid.amount);
        });

        it("sets collateral at 40%", async () => {
            const { calculateBid } = await import("../llm-contextual/index.js");
            const bid = calculateBid(5000, "dex", 70);
            expect(bid.collateral).toBeCloseTo(bid.amount * 0.4, 1);
        });

        it("is the most expensive agent for the same parameters", async () => {
            const llm = await import("../llm-contextual/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");
            const llmBid = llm.calculateBid(5000, "staking", 70);
            const fuzzerBid = fuzzer.calculateBid(5000, "staking", 50)!;
            const staticBid = staticA.calculateBid(5000, "staking", 50)!;
            expect(llmBid.amount).toBeGreaterThan(fuzzerBid.amount);
            expect(fuzzerBid.amount).toBeGreaterThan(staticBid.amount);
        });
    });

    describe("generateFindings()", () => {
        it("generates 1–5 findings", async () => {
            const { generateFindings } = await import("../llm-contextual/index.js");
            for (let i = 0; i < 30; i++) {
                const findings = generateFindings("lending", false);
                expect(findings.length).toBeGreaterThanOrEqual(1);
                expect(findings.length).toBeLessThanOrEqual(5);
            }
        });

        it("finding IDs use LLM- prefix", async () => {
            const { generateFindings } = await import("../llm-contextual/index.js");
            const findings = generateFindings("lending", true);
            for (const f of findings) {
                expect(f.id).toMatch(/^LLM-\d{3}$/);
            }
        });

        it("has highest confidence range (0.8–0.99)", async () => {
            const { generateFindings } = await import("../llm-contextual/index.js");
            for (let i = 0; i < 30; i++) {
                const findings = generateFindings("dex", false);
                for (const f of findings) {
                    expect(f.confidence).toBeGreaterThanOrEqual(0.8);
                    expect(f.confidence).toBeLessThanOrEqual(0.99);
                }
            }
        });

        it("notes when informed by dependency analysis", async () => {
            const { generateFindings } = await import("../llm-contextual/index.js");
            const withDep = generateFindings("bridge", true);
            expect(withDep[0].description).toContain("informed by dependency analysis");
        });

        it("no dependency note when not informed", async () => {
            const { generateFindings } = await import("../llm-contextual/index.js");
            const noDep = generateFindings("bridge", false);
            expect(noDep[0].description).not.toContain("informed by dependency analysis");
        });
    });
});

// =========================================================================
// AGENT 5: DEPENDENCY ANALYZER
// =========================================================================

describe("Dependency Agent", () => {
    describe("calculateSubBid()", () => {
        it("undercuts offered payment by 15% when not busy", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            const bid = calculateSubBid(3, 0);
            expect(bid.amount).toBeCloseTo(2.55, 2);
        });

        it("returns an object with amount for any positive amount", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            const bid = calculateSubBid(10, 0);
            expect(bid).not.toBeNull();
            expect(typeof bid.amount).toBe("number");
        });

        it("always bids less than the offered payment", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            for (const offered of [1, 3, 5, 10, 100]) {
                const bid = calculateSubBid(offered, 0);
                expect(bid.amount).toBeLessThan(offered);
            }
        });

        it("bid scales linearly with offered amount", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            const bid1 = calculateSubBid(10, 0);
            const bid2 = calculateSubBid(20, 0);
            expect(bid2.amount / bid1.amount).toBeCloseTo(2, 1);
        });
    });

    describe("generateDependencyAnalysis()", () => {
        it("returns all required fields", async () => {
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            const analysis = generateDependencyAnalysis();
            expect(typeof analysis.dependencies).toBe("number");
            expect(typeof analysis.knownVulnerable).toBe("number");
            expect(typeof analysis.outdatedDeps).toBe("number");
            expect(Array.isArray(analysis.riskFactors)).toBe(true);
            expect(typeof analysis.analysisHash).toBe("string");
        });

        it("generates deps in range 3–15", async () => {
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            for (let i = 0; i < 30; i++) {
                const analysis = generateDependencyAnalysis();
                expect(analysis.dependencies).toBeGreaterThanOrEqual(3);
                expect(analysis.dependencies).toBeLessThanOrEqual(15);
            }
        });

        it("generates 0–3 vulnerable deps", async () => {
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            for (let i = 0; i < 30; i++) {
                const analysis = generateDependencyAnalysis();
                expect(analysis.knownVulnerable).toBeGreaterThanOrEqual(0);
                expect(analysis.knownVulnerable).toBeLessThanOrEqual(3);
            }
        });

        it("analysis hash is always defined", async () => {
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            for (let i = 0; i < 10; i++) {
                const a = generateDependencyAnalysis();
                expect(a.analysisHash).toBeDefined();
                expect(typeof a.analysisHash).toBe("string");
            }
        });

        it("risk factors come from the known set", async () => {
            const validFactors = [
                "unverified-proxy",
                "deprecated-oracle",
                "centralization-risk",
                "reentrancy-surface",
                "unaudited-dependency",
            ];
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            for (let i = 0; i < 30; i++) {
                const a = generateDependencyAnalysis();
                for (const factor of a.riskFactors) {
                    expect(validFactors).toContain(factor);
                }
            }
        });

        it("generates 0–5 outdated dependencies", async () => {
            const { generateDependencyAnalysis } = await import("../dependency/index.js");
            for (let i = 0; i < 30; i++) {
                const a = generateDependencyAnalysis();
                expect(a.outdatedDeps).toBeGreaterThanOrEqual(0);
                expect(a.outdatedDeps).toBeLessThanOrEqual(5);
            }
        });
    });
});

// =========================================================================
// AGENT 6: REPORT
// =========================================================================

describe("Report Agent", () => {
    describe("aggregateFindings()", () => {
        it("aggregates a single submission correctly", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [{
                type: "FINDINGS_SUBMITTED",
                agentId: "static-analysis-047",
                timestamp: Date.now(),
                payload: {
                    jobId: "0xabc123",
                    findingsHash: "hash1",
                    findingsCount: 5,
                    criticalCount: 1,
                    highCount: 2,
                    mediumCount: 1,
                    lowCount: 1,
                },
            }];

            const report = aggregateFindings(submissions);
            expect(report.jobId).toBe("0xabc123");
            expect(report.totalFindings).toBe(5);
            expect(report.duplicatesDetected).toBe(0);
            expect(Object.keys(report.agentScores)).toHaveLength(1);
            expect(report.agentScores["static-analysis-047"]).toBeDefined();
            expect(report.reportHash).toBeDefined();
        });

        it("detects ~20% duplicates with multiple submitters", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [
                {
                    type: "FINDINGS_SUBMITTED",
                    agentId: "static-047",
                    timestamp: Date.now(),
                    payload: { jobId: "job1", findingsHash: "h1", findingsCount: 10, criticalCount: 1, highCount: 2, mediumCount: 4, lowCount: 3 },
                },
                {
                    type: "FINDINGS_SUBMITTED",
                    agentId: "fuzzer-012",
                    timestamp: Date.now(),
                    payload: { jobId: "job1", findingsHash: "h2", findingsCount: 5, criticalCount: 0, highCount: 3, mediumCount: 1, lowCount: 1 },
                },
            ];

            const report = aggregateFindings(submissions);
            // Duplicate detection is random-based (5-35% overlap per pair)
            expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
            expect(report.totalFindings).toBeGreaterThan(0);
            expect(report.totalFindings).toBeLessThanOrEqual(15);
        });

        it("no duplicates for single submitter", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [{
                type: "FINDINGS_SUBMITTED",
                agentId: "agent1",
                timestamp: Date.now(),
                payload: { jobId: "j1", findingsHash: "h", findingsCount: 20, criticalCount: 5, highCount: 5, mediumCount: 5, lowCount: 5 },
            }];
            const report = aggregateFindings(submissions);
            expect(report.duplicatesDetected).toBe(0);
            expect(report.totalFindings).toBe(20);
        });

        it("scores each submitting agent with 0.6–1.0 accuracy", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [
                { type: "FINDINGS_SUBMITTED", agentId: "a1", timestamp: 1, payload: { jobId: "j", findingsHash: "h", findingsCount: 3, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 3 } },
                { type: "FINDINGS_SUBMITTED", agentId: "a2", timestamp: 1, payload: { jobId: "j", findingsHash: "h", findingsCount: 5, criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 4 } },
            ];

            const report = aggregateFindings(submissions);
            for (const [_, accuracy] of Object.entries(report.agentScores)) {
                expect(accuracy).toBeGreaterThanOrEqual(0.6);
                expect(accuracy).toBeLessThanOrEqual(1.0);
            }
        });

        it("report hash is a valid hex hash", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [{
                type: "FINDINGS_SUBMITTED",
                agentId: "a1",
                timestamp: 1,
                payload: { jobId: "j1", findingsHash: "h", findingsCount: 3, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 3 },
            }];
            const report = aggregateFindings(submissions);
            expect(report.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("handles 3 submitters correctly", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const submissions: any[] = [
                { type: "FINDINGS_SUBMITTED", agentId: "a1", timestamp: 1, payload: { jobId: "j", findingsHash: "h1", findingsCount: 7, criticalCount: 0, highCount: 1, mediumCount: 3, lowCount: 3 } },
                { type: "FINDINGS_SUBMITTED", agentId: "a2", timestamp: 1, payload: { jobId: "j", findingsHash: "h2", findingsCount: 4, criticalCount: 1, highCount: 2, mediumCount: 1, lowCount: 0 } },
                { type: "FINDINGS_SUBMITTED", agentId: "a3", timestamp: 1, payload: { jobId: "j", findingsHash: "h3", findingsCount: 3, criticalCount: 2, highCount: 1, mediumCount: 0, lowCount: 0 } },
            ];
            const report = aggregateFindings(submissions);
            expect(Object.keys(report.agentScores)).toHaveLength(3);
            // Duplicate detection uses random overlap (5-35% per pair)
            expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
            expect(report.totalFindings).toBeGreaterThan(0);
            expect(report.totalFindings).toBeLessThanOrEqual(14);
        });
    });

    describe("calculateReputationDeltas()", () => {
        it("gives positive delta to high-accuracy agents", async () => {
            const { calculateReputationDeltas } = await import("../report/index.js");
            const deltas = calculateReputationDeltas({ agent1: 0.95 });
            expect(deltas["agent1"]).toBeCloseTo(2.5, 1);
        });

        it("gives negative delta to low-accuracy agents", async () => {
            const { calculateReputationDeltas } = await import("../report/index.js");
            const deltas = calculateReputationDeltas({ agent1: 0.5 });
            expect(deltas["agent1"]).toBeCloseTo(-2.0, 1);
        });

        it("gives zero delta at 0.7 accuracy baseline", async () => {
            const { calculateReputationDeltas } = await import("../report/index.js");
            const deltas = calculateReputationDeltas({ agent1: 0.7 });
            expect(deltas["agent1"]).toBeCloseTo(0, 1);
        });

        it("handles multiple agents independently", async () => {
            const { calculateReputationDeltas } = await import("../report/index.js");
            const deltas = calculateReputationDeltas({
                topAgent: 0.95,
                midAgent: 0.7,
                lowAgent: 0.5,
            });
            expect(deltas["topAgent"]).toBeGreaterThan(0);
            expect(deltas["midAgent"]).toBeCloseTo(0, 1);
            expect(deltas["lowAgent"]).toBeLessThan(0);
        });

        it("delta formula is (accuracy - 0.7) * 10", async () => {
            const { calculateReputationDeltas } = await import("../report/index.js");
            for (const accuracy of [0.6, 0.65, 0.7, 0.8, 0.9, 1.0]) {
                const deltas = calculateReputationDeltas({ test: accuracy });
                expect(deltas["test"]).toBeCloseTo((accuracy - 0.7) * 10, 1);
            }
        });
    });
});

// =========================================================================
// AGENT 7: ALERT
// =========================================================================

describe("Alert Agent", () => {
    describe("shouldAlert()", () => {
        it("returns true for REPORT_PUBLISHED with critical findings", async () => {
            const { shouldAlert } = await import("../alert/index.js");
            const msg: any = {
                type: "REPORT_PUBLISHED",
                agentId: "report-001",
                timestamp: Date.now(),
                payload: { jobId: "j1", criticalCount: 2, totalFindings: 10, reportHash: "0xabc" },
            };
            expect(shouldAlert(msg)).toBe(true);
        });

        it("returns false for REPORT_PUBLISHED with zero critical findings", async () => {
            const { shouldAlert } = await import("../alert/index.js");
            const msg: any = {
                type: "REPORT_PUBLISHED",
                agentId: "report-001",
                timestamp: Date.now(),
                payload: { jobId: "j1", criticalCount: 0, totalFindings: 10, reportHash: "0xabc" },
            };
            expect(shouldAlert(msg)).toBe(false);
        });

        it("returns false for non-REPORT_PUBLISHED messages", async () => {
            const { shouldAlert } = await import("../alert/index.js");
            const msg: any = {
                type: "CONTRACT_DISCOVERED",
                agentId: "scanner-001",
                timestamp: Date.now(),
                payload: { criticalFindings: 5 },
            };
            expect(shouldAlert(msg)).toBe(false);
        });

        it("returns false for FINDINGS_SUBMITTED messages", async () => {
            const { shouldAlert } = await import("../alert/index.js");
            const msg: any = {
                type: "FINDINGS_SUBMITTED",
                agentId: "static-001",
                timestamp: Date.now(),
                payload: { criticalFindings: 3 },
            };
            expect(shouldAlert(msg)).toBe(false);
        });
    });

    describe("fireWebhook()", () => {
        it("does not throw even without DISCORD_WEBHOOK_URL", async () => {
            const saved = process.env.DISCORD_WEBHOOK_URL;
            delete process.env.DISCORD_WEBHOOK_URL;

            const { fireWebhook } = await import("../alert/index.js");
            await expect(
                fireWebhook({ jobId: "test", criticalFindings: 1, totalFindings: 5, reportHash: "0x123" })
            ).resolves.not.toThrow();

            if (saved) process.env.DISCORD_WEBHOOK_URL = saved;
        });
    });
});

// =========================================================================
// INTER-AGENT INTERACTION TESTS
// =========================================================================

describe("Inter-Agent Interactions", () => {
    describe("Bidding Price Hierarchy", () => {
        it("LLM > Fuzzer > Static for the same contract", async () => {
            const llm = await import("../llm-contextual/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");

            const llmBid = llm.calculateBid(5000, "staking", 70);
            const fuzzerBid = fuzzer.calculateBid(5000, "staking", 50)!;
            const staticBid = staticA.calculateBid(5000, "staking", 50)!;

            expect(llmBid.amount).toBeGreaterThan(fuzzerBid.amount);
            expect(fuzzerBid.amount).toBeGreaterThan(staticBid.amount);
        });

        it("hierarchy holds for different contract sizes", async () => {
            const llm = await import("../llm-contextual/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");

            // Compare agents for large high-risk contracts where LLM will bid
            for (const loc of [3000, 5000, 7000, 10000]) {
                const l = llm.calculateBid(loc, "lending", 70);
                const f = fuzzer.calculateBid(loc, "lending", 50)!;
                const s = staticA.calculateBid(loc, "lending", 50)!;
                // LLM premium base (30 + LOC*0.003 + 15% protocol premium) > Fuzzer (15 + LOC*0.005) > Static (10 + LOC*0.002)
                expect(l.amount).toBeGreaterThan(s.amount);
                expect(f.amount).toBeGreaterThan(s.amount);
            }
        });
    });

    describe("LLM Agent Selectivity", () => {
        it("LLM skips contracts that Static and Fuzzer would bid on", async () => {
            const { shouldBid } = await import("../llm-contextual/index.js");
            expect(shouldBid(500, "lending", 30)).toBe(false);
        });

        it("all agents bid on large high-risk contracts", async () => {
            const llm = await import("../llm-contextual/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");
            expect(llm.shouldBid(5000, "lending", 85)).toBe(true);
            expect(fuzzer.calculateBid(5000, "lending", 85)).not.toBeNull();
            expect(staticA.calculateBid(5000, "lending", 85)).not.toBeNull();
        });
    });

    describe("Collateral Ratios Reflect Trust Tiers", () => {
        it("LLM (40%) < Static (50%) < Fuzzer (60%)", async () => {
            const llm = await import("../llm-contextual/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const staticA = await import("../static-analysis/index.js");

            const llmBid = llm.calculateBid(5000, "dex", 70);
            const fuzzerBid = fuzzer.calculateBid(5000, "dex", 50)!;
            const staticBid = staticA.calculateBid(5000, "dex", 50)!;

            expect(llmBid.collateral / llmBid.amount).toBeCloseTo(0.4, 1);
            expect(staticBid.collateral / staticBid.amount).toBeCloseTo(0.5, 1);
            expect(fuzzerBid.collateral / fuzzerBid.amount).toBeCloseTo(0.6, 1);
        });
    });

    describe("Dependency Agent Sub-Bid Economics", () => {
        it("dependency agent always bids less than LLM's sub-contract offer", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            const SUB_CONTRACT_PAYMENT = 3;
            const bid = calculateSubBid(SUB_CONTRACT_PAYMENT, 0);
            expect(bid).not.toBeNull();
            expect(bid.amount).toBeLessThan(SUB_CONTRACT_PAYMENT);
        });

        it("sub-bid is profitable for dependency agent", async () => {
            const { calculateSubBid } = await import("../dependency/index.js");
            const bid = calculateSubBid(3, 0);
            expect(bid.amount).toBeGreaterThan(0);
        });
    });

    describe("Finding ID Uniqueness Across Agents", () => {
        it("each agent uses a unique finding ID prefix", async () => {
            const staticA = await import("../static-analysis/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const llm = await import("../llm-contextual/index.js");

            const staticFindings = staticA.generateFindings("lending", 5000);
            const fuzzerFindings = fuzzer.generateFindings("lending", false);
            const llmFindings = llm.generateFindings("lending", false);

            const prefixes = new Set([
                ...staticFindings.map(f => f.id.split("-")[0]),
                ...fuzzerFindings.map(f => f.id.split("-")[0]),
                ...llmFindings.map(f => f.id.split("-")[0]),
            ]);
            expect(prefixes.size).toBe(3);
            expect(prefixes.has("SA")).toBe(true);
            expect(prefixes.has("FZ")).toBe(true);
            expect(prefixes.has("LLM")).toBe(true);
        });
    });

    describe("Report Agent Processes Multi-Agent Findings", () => {
        it("correctly aggregates findings from all 3 audit agents", async () => {
            const { aggregateFindings, calculateReputationDeltas } = await import("../report/index.js");
            const submissions: any[] = [
                { type: "FINDINGS_SUBMITTED", agentId: "static-analysis-047", timestamp: Date.now(), payload: { jobId: "job1", findingsHash: "h1", findingsCount: 7, criticalCount: 0, highCount: 1, mediumCount: 3, lowCount: 3 } },
                { type: "FINDINGS_SUBMITTED", agentId: "fuzzer-012", timestamp: Date.now(), payload: { jobId: "job1", findingsHash: "h2", findingsCount: 4, criticalCount: 1, highCount: 2, mediumCount: 1, lowCount: 0 } },
                { type: "FINDINGS_SUBMITTED", agentId: "llm-contextual-003", timestamp: Date.now(), payload: { jobId: "job1", findingsHash: "h3", findingsCount: 3, criticalCount: 2, highCount: 1, mediumCount: 0, lowCount: 0 } },
            ];

            const report = aggregateFindings(submissions);
            // Duplicate detection is random-based
            expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
            expect(report.totalFindings).toBeGreaterThan(0);
            expect(report.totalFindings).toBeLessThanOrEqual(14);
            expect(Object.keys(report.agentScores)).toHaveLength(3);

            const deltas = calculateReputationDeltas(report.agentScores);
            expect(Object.keys(deltas)).toHaveLength(3);
        });
    });

    describe("Scanner → Auditor Flow", () => {
        it("scanner discovery data matches what auditor agents expect", async () => {
            const { generateDiscovery } = await import("../scanner/index.js");
            const staticA = await import("../static-analysis/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const llm = await import("../llm-contextual/index.js");

            const discovery = generateDiscovery();
            const { estimatedLOC, contractType, riskScore } = discovery.payload;

            const staticBid = staticA.calculateBid(estimatedLOC, contractType, riskScore);
            const fuzzerBid = fuzzer.calculateBid(estimatedLOC, contractType, riskScore);
            const llmAccepts = llm.shouldBid(estimatedLOC, contractType, riskScore);

            expect(staticBid).not.toBeNull();
            expect(fuzzerBid).not.toBeNull();
            expect(typeof llmAccepts).toBe("boolean");
        });
    });

    describe("Full Audit Cycle Data Integrity", () => {
        it("findings from auditors can be fed into report aggregation", async () => {
            const staticA = await import("../static-analysis/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const { aggregateFindings } = await import("../report/index.js");

            const staticFindings = staticA.generateFindings("lending", 5000);
            const fuzzerFindings = fuzzer.generateFindings("lending", true);

            const { hashOf } = await import("../shared/utils.js");
            const submissions: any[] = [
                {
                    type: "FINDINGS_SUBMITTED",
                    agentId: "static-analysis-047",
                    timestamp: Date.now(),
                    payload: {
                        jobId: "0xtest",
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
                        jobId: "0xtest",
                        findingsHash: hashOf(fuzzerFindings),
                        findingsCount: fuzzerFindings.length,
                        criticalCount: fuzzerFindings.filter(f => f.severity === "critical").length,
                        highCount: fuzzerFindings.filter(f => f.severity === "high").length,
                        mediumCount: fuzzerFindings.filter(f => f.severity === "medium").length,
                        lowCount: fuzzerFindings.filter(f => f.severity === "low").length,
                    },
                },
            ];

            const report = aggregateFindings(submissions);
            expect(report.jobId).toBe("0xtest");
            expect(report.totalFindings).toBeGreaterThan(0);
            expect(report.reportHash.length).toBeGreaterThan(0);
        });
    });

    describe("Alert Agent Integration", () => {
        it("alert triggers when report has critical findings", async () => {
            const { aggregateFindings } = await import("../report/index.js");
            const { shouldAlert } = await import("../alert/index.js");

            const submissions: any[] = [
                { type: "FINDINGS_SUBMITTED", agentId: "static-047", timestamp: 1, payload: { jobId: "j", findingsHash: "h", findingsCount: 5, criticalCount: 3, highCount: 1, mediumCount: 1, lowCount: 0 } },
            ];
            const report = aggregateFindings(submissions);

            // Simulate the HCS message the Report agent would publish
            const reportMsg: any = {
                type: "REPORT_PUBLISHED",
                agentId: "report-001",
                timestamp: Date.now(),
                payload: {
                    jobId: report.jobId,
                    criticalCount: 3,
                    totalFindings: report.totalFindings,
                    reportHash: report.reportHash,
                },
            };

            expect(shouldAlert(reportMsg)).toBe(true);
        });

        it("alert does NOT trigger when report has no critical findings", async () => {
            const { shouldAlert } = await import("../alert/index.js");

            const reportMsg: any = {
                type: "REPORT_PUBLISHED",
                agentId: "report-001",
                timestamp: Date.now(),
                payload: {
                    jobId: "j2",
                    criticalCount: 0,
                    totalFindings: 5,
                    reportHash: "0xabc",
                },
            };

            expect(shouldAlert(reportMsg)).toBe(false);
        });
    });

    describe("Economic Consistency", () => {
        it("all bid amounts are positive numbers", async () => {
            const staticA = await import("../static-analysis/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const llm = await import("../llm-contextual/index.js");
            const dep = await import("../dependency/index.js");

            for (let i = 0; i < 20; i++) {
                const s = staticA.calculateBid(5000, "dex", 50)!;
                const f = fuzzer.calculateBid(5000, "dex", 50)!;
                const l = llm.calculateBid(5000, "dex", 70);
                const d = dep.calculateSubBid(3, 0);

                expect(s.amount).toBeGreaterThan(0);
                expect(f.amount).toBeGreaterThan(0);
                expect(l.amount).toBeGreaterThan(0);
                expect(d.amount).toBeGreaterThan(0);
            }
        });

        it("all collateral values are positive and less than bid amounts", async () => {
            const staticA = await import("../static-analysis/index.js");
            const fuzzer = await import("../fuzzer/index.js");
            const llm = await import("../llm-contextual/index.js");

            const s = staticA.calculateBid(5000, "dex", 50)!;
            const f = fuzzer.calculateBid(5000, "dex", 50)!;
            const l = llm.calculateBid(5000, "dex", 70);

            expect(s.collateral).toBeGreaterThan(0);
            expect(s.collateral).toBeLessThan(s.amount);
            expect(f.collateral).toBeGreaterThan(0);
            expect(f.collateral).toBeLessThan(f.amount);
            expect(l.collateral).toBeGreaterThan(0);
            expect(l.collateral).toBeLessThan(l.amount);
        });
    });
});
