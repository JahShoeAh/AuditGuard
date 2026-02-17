/**
 * End-to-End Agent Flow Test
 * 
 * Simulates the full AuditGuard lifecycle:
 *   Scanner discovers → Agents bid → Audits run → Findings submitted →
 *   Report aggregates → Reputation scored → Alert fires
 * 
 * All agents run in-process using their exported logic functions.
 * No Hedera/HCS connection needed — this exercises the economic logic.
 */

import { describe, it, expect } from "vitest";

// ─── Import every agent's exported logic ───────────────────────────────────

// Scanner
import { generateDiscovery } from "../scanner/index.js";

// Static Analysis
import {
    calculateBid as staticBid,
    generateFindings as staticFindings,
} from "../static-analysis/index.js";

// Fuzzer
import {
    calculateBid as fuzzerBid,
    generateFindings as fuzzerFindings,
} from "../fuzzer/index.js";

// LLM Contextual
import {
    shouldBid as llmShouldBid,
    calculateBid as llmBid,
    generateFindings as llmFindings,
} from "../llm-contextual/index.js";

// Dependency
import {
    calculateSubBid,
    generateDependencyAnalysis,
} from "../dependency/index.js";

// Report
import {
    aggregateFindings,
    calculateReputationDeltas,
} from "../report/index.js";

// Alert
import { shouldAlert, fireWebhook } from "../alert/index.js";

// Shared utilities
import { hashOf } from "../shared/utils.js";
import type {
    FindingsSubmittedEvent,
    HCSMessage,
    ContractType,
} from "../shared/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeSubmission(
    agentId: string,
    jobId: string,
    findings: { severity: string }[]
): FindingsSubmittedEvent {
    return {
        type: "FINDINGS_SUBMITTED",
        agentId,
        timestamp: Date.now(),
        payload: {
            jobId,
            findingsHash: hashOf(findings),
            findingsCount: findings.length,
            criticalCount: findings.filter((f) => f.severity === "critical").length,
            highCount: findings.filter((f) => f.severity === "high").length,
            mediumCount: findings.filter((f) => f.severity === "medium").length,
            lowCount: findings.filter((f) => f.severity === "low").length,
        },
    };
}

// ─── The Full Lifecycle Test ───────────────────────────────────────────────

describe("🔄 End-to-End: Full Audit Lifecycle", () => {
    // Shared state across the lifecycle steps
    let contractAddress: string;
    let contractType: ContractType;
    let riskScore: number;
    let estimatedLOC: number;
    let allBids: { agent: string; amount: number; collateral: number; est: number }[];
    let allFindings: Record<string, ReturnType<typeof staticFindings>>;
    let depAnalysis: ReturnType<typeof generateDependencyAnalysis>;
    let report: ReturnType<typeof aggregateFindings>;
    let repDeltas: Record<string, number>;

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 1: Scanner Discovery
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 1: Scanner Discovery", () => {
        it("Scanner discovers a new smart contract", () => {
            const discovery = generateDiscovery();

            expect(discovery.type).toBe("CONTRACT_DISCOVERED");
            expect(discovery.agentId).toBe("scanner-001");
            expect(discovery.payload.contractAddress).toMatch(/^0x[0-9a-f]{40,}$/);
            expect(discovery.payload.chain).toBe("hedera-testnet");
            expect(discovery.payload.estimatedLOC).toBeGreaterThan(0);
            expect(discovery.payload.riskScore).toBeGreaterThanOrEqual(20);
            expect(discovery.payload.riskScore).toBeLessThanOrEqual(95);

            // Save for subsequent phases
            contractAddress = discovery.payload.contractAddress;
            contractType = discovery.payload.contractType;
            riskScore = discovery.payload.riskScore;
            estimatedLOC = discovery.payload.estimatedLOC;

            console.log("\n  📡 SCANNER DISCOVERY:");
            console.log(`     Contract: ${contractAddress}`);
            console.log(`     Type: ${contractType}`);
            console.log(`     Risk Score: ${riskScore}`);
            console.log(`     Lines of Code: ${estimatedLOC}`);
            console.log(`     Chain: ${discovery.payload.chain}`);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 2: Agents Evaluate & Bid
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 2: Agents Evaluate & Submit Bids", () => {
        it("Static Analysis agent calculates a bid", () => {
            allBids = [];

            const bid = staticBid(estimatedLOC, contractType, riskScore);
            expect(bid).not.toBeNull();
            expect(bid!.amount).toBeGreaterThan(0);
            expect(bid!.collateral).toBeGreaterThan(0);
            expect(bid!.collateral).toBeLessThan(bid!.amount);

            allBids.push({
                agent: "static-analysis-047",
                amount: bid!.amount,
                collateral: bid!.collateral,
                est: bid!.estimatedTimeSec,
            });

            console.log("\n  🔍 STATIC ANALYSIS BID:");
            console.log(`     Amount: ${bid!.amount} GUARD`);
            console.log(`     Collateral: ${bid!.collateral} GUARD (${Math.round(bid!.collateral / bid!.amount * 100)}%)`);
            console.log(`     Estimated Time: ${bid!.estimatedTimeSec}s`);
        });

        it("Fuzzer agent calculates a bid", () => {
            const bid = fuzzerBid(estimatedLOC, contractType, riskScore);
            expect(bid).not.toBeNull();
            expect(bid!.amount).toBeGreaterThan(0);

            allBids.push({
                agent: "fuzzer-012",
                amount: bid!.amount,
                collateral: bid!.collateral,
                est: bid!.estimatedTimeSec,
            });

            console.log("\n  🐛 FUZZER BID:");
            console.log(`     Amount: ${bid!.amount} GUARD`);
            console.log(`     Collateral: ${bid!.collateral} GUARD (${Math.round(bid!.collateral / bid!.amount * 100)}%)`);
            console.log(`     Estimated Time: ${bid!.estimatedTimeSec}s`);
        });

        it("LLM Contextual agent evaluates whether to bid", () => {
            const willBid = llmShouldBid(estimatedLOC, contractType, riskScore);
            console.log(`\n  🧠 LLM CONTEXTUAL EVALUATION:`);
            console.log(`     Will bid: ${willBid ? "YES" : "NO (below thresholds)"}`);

            if (willBid) {
                const bid = llmBid(estimatedLOC, contractType, riskScore);
                allBids.push({
                    agent: "llm-contextual-003",
                    amount: bid.amount,
                    collateral: bid.collateral,
                    est: bid.estimatedTimeSec,
                });

                console.log(`     Amount: ${bid.amount} GUARD (premium pricing)`);
                console.log(`     Collateral: ${bid.collateral} GUARD (${Math.round(bid.collateral / bid.amount * 100)}%)`);
                console.log(`     Estimated Time: ${bid.estimatedTimeSec}s`);
            }

            // Verify bid hierarchy
            if (allBids.length >= 2) {
                console.log("\n  📊 BID RANKING:");
                const sorted = [...allBids].sort((a, b) => a.amount - b.amount);
                sorted.forEach((b, i) => {
                    console.log(`     ${i + 1}. ${b.agent}: ${b.amount} GUARD`);
                });
            }
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 3: Sub-Contracting (LLM → Dependency)
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 3: Sub-Contracting (LLM → Dependency Agent)", () => {
        it("LLM agent sub-contracts dependency analysis", () => {
            const subPayment = 3; // GUARD
            const subBid = calculateSubBid(subPayment, 0);

            expect(subBid).not.toBeNull();
            expect(subBid.amount).toBeLessThan(subPayment);
            expect(subBid.amount).toBeGreaterThan(0);

            console.log("\n  🤝 SUB-CONTRACT:");
            console.log(`     LLM offers: ${subPayment} GUARD for dependency analysis`);
            console.log(`     Dependency bids: ${subBid.amount} GUARD (${Math.round((1 - subBid.amount / subPayment) * 100)}% undercut)`);
        });

        it("Dependency agent performs analysis and delivers result", () => {
            depAnalysis = generateDependencyAnalysis();

            expect(depAnalysis.dependencies).toBeGreaterThanOrEqual(3);
            expect(depAnalysis.riskFactors).toBeDefined();

            console.log("\n  📦 DEPENDENCY ANALYSIS RESULT:");
            console.log(`     Dependencies: ${depAnalysis.dependencies}`);
            console.log(`     Known Vulnerable: ${depAnalysis.knownVulnerable}`);
            console.log(`     Outdated: ${depAnalysis.outdatedDeps}`);
            console.log(`     Risk Factors: ${depAnalysis.riskFactors.length > 0 ? depAnalysis.riskFactors.join(", ") : "(none)"}`);
            console.log(`     Result Hash: ${hashOf(depAnalysis).slice(0, 20)}...`);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 4: Audit Execution (All Winners Run Analysis)
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 4: Audit Execution", () => {
        it("All audit agents generate findings", () => {
            allFindings = {};

            // Static Analysis findings
            const saFindings = staticFindings(contractType, estimatedLOC);
            allFindings["static-analysis-047"] = saFindings;

            // Fuzzer findings (without purchased data for simplicity)
            const fzFindings = fuzzerFindings(contractType, false);
            allFindings["fuzzer-012"] = fzFindings;

            // LLM findings (with dependency analysis if available)
            const llmResult = llmFindings(contractType, true);
            allFindings["llm-contextual-003"] = llmResult;

            console.log("\n  🔬 AUDIT FINDINGS:");
            let totalC = 0, totalH = 0, totalM = 0, totalL = 0;

            for (const [agent, findings] of Object.entries(allFindings)) {
                const c = findings.filter(f => f.severity === "critical").length;
                const h = findings.filter(f => f.severity === "high").length;
                const m = findings.filter(f => f.severity === "medium").length;
                const l = findings.filter(f => f.severity === "low").length;
                const info = findings.filter(f => f.severity === "info").length;

                totalC += c; totalH += h; totalM += m; totalL += l;

                console.log(`\n     ${agent}:`);
                console.log(`       Count: ${findings.length}`);
                console.log(`       Breakdown: C:${c} H:${h} M:${m} L:${l} I:${info}`);
                findings.forEach(f => {
                    console.log(`       • [${f.severity.toUpperCase()}] ${f.title} (conf: ${(f.confidence * 100).toFixed(0)}%)`);
                });
            }

            console.log(`\n     TOTAL: ${Object.values(allFindings).flat().length} raw findings [C:${totalC} H:${totalH} M:${totalM} L:${totalL}]`);

            // Verify each agent used unique prefixes
            const prefixes = new Set(
                Object.values(allFindings).flat().map(f => f.id.split("-")[0])
            );
            expect(prefixes.size).toBe(3);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 5: Report Aggregation & Settlement
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 5: Report Aggregation & Payment Settlement", () => {
        it("Report agent aggregates findings from all audit agents", () => {
            // Build submissions as they'd arrive via HCS
            const submissions: FindingsSubmittedEvent[] = Object.entries(allFindings).map(
                ([agentId, findings]) => makeSubmission(agentId, contractAddress, findings)
            );

            report = aggregateFindings(submissions);

            expect(report.totalFindings).toBeGreaterThan(0);
            expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
            expect(Object.keys(report.agentScores)).toHaveLength(3);
            expect(report.reportHash).toMatch(/^0x[0-9a-f]+$/);

            console.log("\n  📋 AGGREGATED REPORT:");
            console.log(`     Job ID: ${report.jobId.slice(0, 16)}...`);
            console.log(`     Total Findings: ${report.totalFindings} (after dedup)`);
            console.log(`     Duplicates Removed: ${report.duplicatesDetected}`);
            console.log(`     Report Hash: ${report.reportHash.slice(0, 20)}...`);
        });

        it("Report agent scores each agent and calculates reputation deltas", () => {
            repDeltas = calculateReputationDeltas(report.agentScores);

            console.log("\n  ⭐ AGENT SCORING & REPUTATION:");
            for (const [agentId, accuracy] of Object.entries(report.agentScores)) {
                const delta = repDeltas[agentId];
                const sign = delta >= 0 ? "+" : "";
                const emoji = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";
                console.log(`     ${emoji} ${agentId}: accuracy=${(accuracy * 100).toFixed(0)}% → rep ${sign}${delta}`);
            }

            // Verify deltas follow the formula
            for (const [agentId, accuracy] of Object.entries(report.agentScores)) {
                const expected = Math.round((accuracy - 0.7) * 10 * 100) / 100;
                expect(repDeltas[agentId]).toBe(expected);
            }
        });

        it("Report agent settles payments for the job", () => {
            const reportFee = 0.1; // GUARD per agent
            const totalSettlement = Object.keys(report.agentScores).length * reportFee;

            console.log("\n  💰 PAYMENT SETTLEMENT:");
            for (const agentId of Object.keys(report.agentScores)) {
                console.log(`     ${agentId}: ${reportFee} GUARD`);
            }
            console.log(`     Total Settlement: ${totalSettlement} GUARD`);
            console.log(`     PaymentSettlement.settleJob() → on-chain`);

            expect(totalSettlement).toBeGreaterThan(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 6: Alert Agent
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 6: Alert Agent Monitoring", () => {
        it("Alert agent evaluates the published report", () => {
            // Build the REPORT_PUBLISHED message as it would arrive via HCS
            const totalCritical = Object.values(allFindings).flat()
                .filter(f => f.severity === "critical").length;

            const reportMsg: HCSMessage = {
                type: "REPORT_PUBLISHED",
                agentId: "report-001",
                timestamp: Date.now(),
                payload: {
                    jobId: contractAddress,
                    reportHash: report.reportHash,
                    totalFindings: report.totalFindings,
                    criticalFindings: totalCritical,
                    agentCount: 3,
                },
            };

            const triggered = shouldAlert(reportMsg);

            console.log("\n  🚨 ALERT EVALUATION:");
            console.log(`     Critical findings: ${totalCritical}`);
            console.log(`     Alert triggered: ${triggered ? "YES — firing webhook" : "NO — all clear"}`);

            if (totalCritical > 0) {
                expect(triggered).toBe(true);
                console.log(`     Webhook payload: job=${contractAddress.slice(0, 16)}... critical=${totalCritical}`);
            } else {
                expect(triggered).toBe(false);
                console.log(`     No action needed.`);
            }
        });

        it("fireWebhook executes without error (no URL configured)", async () => {
            await expect(
                fireWebhook({
                    jobId: contractAddress,
                    criticalFindings: 1,
                    totalFindings: report.totalFindings,
                    reportHash: report.reportHash,
                })
            ).resolves.not.toThrow();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 7: Economic Summary
    // ────────────────────────────────────────────────────────────────────────

    describe("Phase 7: Economic Summary", () => {
        it("prints the full economic flow", () => {
            const totalCritical = Object.values(allFindings).flat()
                .filter(f => f.severity === "critical").length;

            console.log("\n  ═══════════════════════════════════════════════════");
            console.log("  💎 FULL AUDIT LIFECYCLE — ECONOMIC SUMMARY");
            console.log("  ═══════════════════════════════════════════════════");
            console.log(`\n  Target: ${contractAddress}`);
            console.log(`  Type: ${contractType} | Risk: ${riskScore} | LOC: ${estimatedLOC}`);

            console.log("\n  BIDS SUBMITTED:");
            allBids.forEach(b => {
                console.log(`    ${b.agent}: ${b.amount} GUARD (collateral: ${b.collateral})`);
            });

            if (allBids.length > 0) {
                const cheapest = allBids.reduce((a, b) => a.amount < b.amount ? a : b);
                console.log(`    → Cheapest: ${cheapest.agent} at ${cheapest.amount} GUARD`);
            }

            console.log("\n  SUB-CONTRACTING:");
            console.log(`    LLM → Dependency: 3 GUARD (deps found: ${depAnalysis.dependencies})`);

            console.log("\n  FINDINGS:");
            for (const [agent, findings] of Object.entries(allFindings)) {
                console.log(`    ${agent}: ${findings.length} findings`);
            }
            console.log(`    After dedup: ${report.totalFindings} unique`);
            console.log(`    Critical: ${totalCritical}`);

            console.log("\n  REPUTATION CHANGES:");
            for (const [agent, delta] of Object.entries(repDeltas)) {
                const sign = delta >= 0 ? "+" : "";
                console.log(`    ${agent}: ${sign}${delta}`);
            }

            console.log("\n  SETTLEMENT:");
            console.log(`    Total paid: ${Object.keys(report.agentScores).length * 0.1} GUARD`);

            console.log("\n  ALERT:");
            console.log(`    ${totalCritical > 0 ? "🔴 FIRED — critical vulnerabilities found" : "🟢 NOT FIRED — no critical issues"}`);

            console.log("\n  ═══════════════════════════════════════════════════\n");

            // This test always passes — it's for the human-readable output
            expect(true).toBe(true);
        });
    });
});
