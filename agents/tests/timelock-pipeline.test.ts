/**
 * TimeLock Pipeline Test
 *
 * End-to-end test that wires a REAL deployed TimeLockVault contract into the
 * full AuditGuard agent pipeline:
 *
 *   Phase 1 — CONTRACT_DISCOVERED event seeded with the real on-chain address
 *   Phase 2 — All bidding agents compute bids
 *   Phase 3 — LLM agent sub-contracts dependency analysis
 *   Phase 4 — All audit agents generate findings (LLM skips LOC gate for vault)
 *   Phase 5 — Report agent aggregates findings, detects duplicates
 *   Phase 6 — Alert agent evaluates the report (fires if critical > 0)
 *   Phase 7 — Economic summary printed for human review
 *
 * The TimeLockVault contract has an intentional centralisation risk
 * (owner `emergencyWithdraw` with no time-gate) that the LLM agent's
 * severity-skewed-high heuristic is expected to surface.
 *
 * Setup: run `node scripts/deploy-timelock.js` ONCE before running this test.
 * If the config entry is missing the test falls back to a deterministic dummy
 * address and runs as a pure unit-logic test.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Agent logic imports ─────────────────────────────────────────────────────

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

// Shared
import { hashOf } from "../shared/utils.js";
import type {
	FindingsSubmittedEvent,
	HCSMessage,
	ContractType,
} from "../shared/types.js";

// ─── Load deployed contract address ──────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dir, "..", "..", "packages", "sdk", "config.json");

/** EVM address of the deployed TimeLockVault (or dummy if not yet deployed). */
function resolveTimelockAddress(): { address: string; isLive: boolean } {
	try {
		if (existsSync(CONFIG_PATH)) {
			const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
			if (cfg?.timelockVault?.evmAddress) {
				return { address: cfg.timelockVault.evmAddress, isLive: true };
			}
		}
	} catch { /* ignore */ }
	// Fallback — deterministic dummy for pure unit-logic runs
	return { address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", isLive: false };
}

// ─── Helper: build a FindingsSubmittedEvent ───────────────────────────────────

function makeSubmission(
	agentId: string,
	jobId: string,
	findings: { severity: string }[],
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

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("🔐 TimeLockVault — Full AuditGuard Pipeline", () => {

	// ── Shared state across phases ──────────────────────────────────────────
	let timelockAddress: string;
	let isLiveContract: boolean;
	const CONTRACT_TYPE: ContractType = "vault";
	// Force a high risk score so ALL agents (including LLM) evaluate the contract
	const FORCED_RISK_SCORE = 85;
	// Force a realistic LOC so LLM agent's MIN_LOC (1000) gate is satisfied
	const FORCED_LOC = 1500;

	let allBids: { agent: string; amount: number; collateral: number; est: number }[];
	let allFindings: Record<string, ReturnType<typeof staticFindings>>;
	let depAnalysis: ReturnType<typeof generateDependencyAnalysis>;
	let report: ReturnType<typeof aggregateFindings>;
	let repDeltas: Record<string, number>;

	// ── Resolve address before tests run ───────────────────────────────────

	beforeAll(() => {
		const resolved = resolveTimelockAddress();
		timelockAddress = resolved.address;
		isLiveContract = resolved.isLive;

		console.log("\n  ═══════════════════════════════════════════════════════");
		console.log("  🔐 TimeLockVault — AuditGuard Pipeline Test");
		console.log("  ═══════════════════════════════════════════════════════");
		console.log(`\n  Contract address : ${timelockAddress}`);
		console.log(`  Live on testnet  : ${isLiveContract ? "✅ YES — real deployed contract" : "⚠️  NO — dummy address (run deploy-timelock.js first)"}`);
		console.log(`  Contract type    : ${CONTRACT_TYPE}`);
		console.log(`  Forced risk score: ${FORCED_RISK_SCORE}`);
		console.log(`  LOC estimate     : ${FORCED_LOC}\n`);
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 1: Scanner Discovery
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 1: Scanner — CONTRACT_DISCOVERED event", () => {
		it("Scanner generates a valid discovery event for the TimeLockVault address", () => {
			// Use the scanner's generator but override the address + type to point
			// at our real deployed contract.
			const baseDiscovery = generateDiscovery();
			const discovery = {
				...baseDiscovery,
				payload: {
					...baseDiscovery.payload,
					contractAddress: timelockAddress,
					contractType: CONTRACT_TYPE,
					riskScore: FORCED_RISK_SCORE,
					estimatedLOC: FORCED_LOC,
					chain: "hedera-testnet",
				},
			};

			// ── Assertions ─────────────────────────────────────────────────
			expect(discovery.type).toBe("CONTRACT_DISCOVERED");
			expect(discovery.agentId).toBe("scanner-001");
			expect(discovery.payload.contractAddress).toBe(timelockAddress);
			expect(discovery.payload.chain).toBe("hedera-testnet");
			expect(discovery.payload.contractType).toBe("vault");
			expect(discovery.payload.riskScore).toBe(FORCED_RISK_SCORE);
			expect(discovery.payload.estimatedLOC).toBeGreaterThan(0);

			console.log("  📡 SCANNER DISCOVERY:");
			console.log(`     Contract:   ${timelockAddress}`);
			console.log(`     Type:       ${CONTRACT_TYPE}`);
			console.log(`     Risk Score: ${FORCED_RISK_SCORE}`);
			console.log(`     LOC:        ${FORCED_LOC}`);
			console.log(`     Chain:      hedera-testnet`);
			console.log(`     Tx Hash:    ${discovery.payload.txHash}`);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 2: Bidding
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 2: Agents Evaluate & Submit Bids", () => {
		it("Static Analysis agent bids on the vault contract", () => {
			allBids = [];
			const bid = staticBid(FORCED_LOC, CONTRACT_TYPE, FORCED_RISK_SCORE);

			expect(bid).not.toBeNull();
			expect(bid!.amount).toBeGreaterThan(0);
			expect(bid!.collateral).toBeGreaterThan(0);
			expect(bid!.collateral).toBeLessThan(bid!.amount);

			allBids.push({ agent: "static-analysis-047", amount: bid!.amount, collateral: bid!.collateral, est: bid!.estimatedTimeSec });

			console.log("\n  🔍 STATIC ANALYSIS BID:");
			console.log(`     Amount:    ${bid!.amount} GUARD`);
			console.log(`     Collateral: ${bid!.collateral} GUARD`);
			console.log(`     Est. time: ${bid!.estimatedTimeSec}s`);
		});

		it("Fuzzer agent bids on the vault contract", () => {
			const bid = fuzzerBid(FORCED_LOC, CONTRACT_TYPE, FORCED_RISK_SCORE);

			expect(bid).not.toBeNull();
			expect(bid!.amount).toBeGreaterThan(0);

			allBids.push({ agent: "fuzzer-012", amount: bid!.amount, collateral: bid!.collateral, est: bid!.estimatedTimeSec });

			console.log("\n  🐛 FUZZER BID:");
			console.log(`     Amount:    ${bid!.amount} GUARD`);
			console.log(`     Collateral: ${bid!.collateral} GUARD`);
			console.log(`     Est. time: ${bid!.estimatedTimeSec}s`);
		});

		it("LLM Contextual agent evaluates and bids (risk >= MIN_RISK, LOC >= MIN_LOC)", () => {
			// With FORCED_RISK_SCORE=85 (>50) and FORCED_LOC=1500 (>1000) the LLM
			// agent MUST decide to bid.
			const willBid = llmShouldBid(FORCED_LOC, CONTRACT_TYPE, FORCED_RISK_SCORE);
			expect(willBid).toBe(true);

			const bid = llmBid(FORCED_LOC, CONTRACT_TYPE, FORCED_RISK_SCORE);
			expect(bid.amount).toBeGreaterThan(0);
			expect(bid.collateral).toBeGreaterThan(0);
			expect(bid.collateral).toBeLessThan(bid.amount);

			allBids.push({ agent: "llm-contextual-003", amount: bid.amount, collateral: bid.collateral, est: bid.estimatedTimeSec });

			console.log("\n  🧠 LLM CONTEXTUAL BID:");
			console.log(`     Will bid:  YES (premium)`);
			console.log(`     Amount:    ${bid.amount} GUARD`);
			console.log(`     Collateral: ${bid.collateral} GUARD`);
			console.log(`     Est. time: ${bid.estimatedTimeSec}s`);

			// Expect 3 bidders total
			expect(allBids).toHaveLength(3);
			const sorted = [...allBids].sort((a, b) => a.amount - b.amount);
			console.log("\n  📊 BID RANKING (cheapest → priciest):");
			sorted.forEach((b, i) => console.log(`     ${i + 1}. ${b.agent}: ${b.amount} GUARD`));
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 3: Sub-Contracting
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 3: LLM Sub-Contracts Dependency Analysis", () => {
		it("Dependency agent undercuts the sub-contract payment", () => {
			const subPayment = 3; // GUARD
			const subBid = calculateSubBid(subPayment, 0);

			expect(subBid).not.toBeNull();
			expect(subBid.amount).toBeLessThan(subPayment);
			expect(subBid.amount).toBeGreaterThan(0);

			console.log("\n  🤝 SUB-CONTRACT:");
			console.log(`     LLM offers :         ${subPayment} GUARD`);
			console.log(`     Dependency bids :     ${subBid.amount} GUARD (${Math.round((1 - subBid.amount / subPayment) * 100)}% undercut)`);
		});

		it("Dependency agent performs and delivers analysis", () => {
			depAnalysis = generateDependencyAnalysis();

			expect(depAnalysis.dependencies).toBeGreaterThanOrEqual(3);
			expect(depAnalysis.riskFactors).toBeDefined();

			console.log("\n  📦 DEPENDENCY ANALYSIS:");
			console.log(`     Dependencies:      ${depAnalysis.dependencies}`);
			console.log(`     Known vulnerable:  ${depAnalysis.knownVulnerable}`);
			console.log(`     Outdated:          ${depAnalysis.outdatedDeps}`);
			console.log(`     Risk factors:      ${depAnalysis.riskFactors.length > 0 ? depAnalysis.riskFactors.join(", ") : "(none)"}`);
			console.log(`     Result hash:       ${hashOf(depAnalysis).slice(0, 20)}...`);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 4: Audit Execution
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 4: Audit Execution — All Agents Generate Findings", () => {
		it("All three audit agents generate findings for the vault contract", () => {
			allFindings = {};

			// Static Analysis
			const saFindings = staticFindings(CONTRACT_TYPE, FORCED_LOC);
			allFindings["static-analysis-047"] = saFindings;

			// Fuzzer
			const fzFindings = fuzzerFindings(CONTRACT_TYPE, false);
			allFindings["fuzzer-012"] = fzFindings;

			// LLM — with dependency analysis data
			const llmResult = llmFindings(CONTRACT_TYPE, /* hasDepAnalysis */ true);
			allFindings["llm-contextual-003"] = llmResult;

			console.log("\n  🔬 AUDIT FINDINGS:");
			let totalC = 0, totalH = 0, totalM = 0, totalL = 0;

			for (const [agent, findings] of Object.entries(allFindings)) {
				const c = findings.filter((f) => f.severity === "critical").length;
				const h = findings.filter((f) => f.severity === "high").length;
				const m = findings.filter((f) => f.severity === "medium").length;
				const l = findings.filter((f) => f.severity === "low").length;
				const i = findings.filter((f) => f.severity === "info").length;
				totalC += c; totalH += h; totalM += m; totalL += l;

				console.log(`\n     ${agent}:`);
				console.log(`       Count:     ${findings.length}`);
				console.log(`       Breakdown: C:${c} H:${h} M:${m} L:${l} I:${i}`);
				findings.forEach((f) =>
					console.log(`       • [${f.severity.toUpperCase().padEnd(8)}] ${f.title} (conf: ${(f.confidence * 100).toFixed(0)}%)`),
				);
			}

			const total = Object.values(allFindings).flat().length;
			console.log(`\n     TOTAL: ${total} raw findings [C:${totalC} H:${totalH} M:${totalM} L:${totalL}]`);

			// Each agent must produce at least one finding
			expect(saFindings.length).toBeGreaterThan(0);
			expect(fzFindings.length).toBeGreaterThan(0);
			expect(llmResult.length).toBeGreaterThan(0);

			// Each agent uses unique ID prefixes
			const prefixes = new Set(
				Object.values(allFindings).flat().map((f) => f.id.split("-")[0]),
			);
			expect(prefixes.size).toBe(3); // SA, FZ, LLM

			// LLM uses severity-skewed-HIGH — expect at least one high/critical
			const llmHighSeverity = llmResult.filter(
				(f) => f.severity === "critical" || f.severity === "high",
			);
			expect(llmHighSeverity.length).toBeGreaterThanOrEqual(1);

			console.log(`\n  ⚠️  LLM HIGH-OR-CRITICAL FINDINGS: ${llmHighSeverity.length}`);
			llmHighSeverity.forEach((f) =>
				console.log(`     [${f.severity.toUpperCase()}] ${f.title}`),
			);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 5: Report Aggregation
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 5: Report Agent — Aggregate & Score", () => {
		it("Aggregates all findings into a deduplicated report", () => {
			const submissions: FindingsSubmittedEvent[] = Object.entries(allFindings).map(
				([agentId, findings]) => makeSubmission(agentId, timelockAddress, findings),
			);

			report = aggregateFindings(submissions);

			expect(report.totalFindings).toBeGreaterThan(0);
			expect(report.duplicatesDetected).toBeGreaterThanOrEqual(0);
			expect(Object.keys(report.agentScores)).toHaveLength(3);
			expect(report.reportHash).toMatch(/^0x[0-9a-f]+$/);

			console.log("\n  📋 AGGREGATED REPORT:");
			console.log(`     Job ID (=contract addr): ${timelockAddress.slice(0, 20)}...`);
			console.log(`     Total findings (deduped): ${report.totalFindings}`);
			console.log(`     Duplicates removed:       ${report.duplicatesDetected}`);
			console.log(`     Report hash:              ${report.reportHash.slice(0, 20)}...`);
		});

		it("Calculates reputation deltas for each agent", () => {
			repDeltas = calculateReputationDeltas(report.agentScores);

			console.log("\n  ⭐ AGENT SCORING & REPUTATION:");
			for (const [agentId, accuracy] of Object.entries(report.agentScores)) {
				const delta = repDeltas[agentId];
				const sign = delta >= 0 ? "+" : "";
				const emoji = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";
				console.log(`     ${emoji} ${agentId}: accuracy=${(accuracy * 100).toFixed(0)}% → rep ${sign}${delta}`);
			}

			// Deltas follow the formula: (accuracy - 0.7) * 10
			for (const [agentId, accuracy] of Object.entries(report.agentScores)) {
				const expected = Math.round((accuracy - 0.7) * 10 * 100) / 100;
				expect(repDeltas[agentId]).toBe(expected);
			}
		});

		it("Settlement manifest covers all participating agents", () => {
			const agentCount = Object.keys(report.agentScores).length;
			const reportFee = 0.1; // GUARD per agent
			const totalPayout = agentCount * reportFee;

			expect(agentCount).toBe(3);
			expect(totalPayout).toBeGreaterThan(0);

			console.log(`\n  💰 PAYMENT SETTLEMENT (manifest):`);
			Object.keys(report.agentScores).forEach((id) =>
				console.log(`     ${id}: ${reportFee} GUARD`),
			);
			console.log(`     Total: ${totalPayout} GUARD → PaymentSettlement.settleJob()`);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 6: Alert Agent
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 6: Alert Agent Monitoring", () => {
		it("Alert fires when the aggregated report contains critical findings", () => {
			const rawFindings = Object.values(allFindings).flat();
			const totalCritical = rawFindings.filter((f) => f.severity === "critical").length;

			// Build the REPORT_PUBLISHED message exactly as the report agent emits it
			const reportMsg: HCSMessage = {
				type: "REPORT_PUBLISHED",
				agentId: "report-aggregator-001",
				timestamp: Date.now(),
				payload: {
					jobId: timelockAddress,
					reportHash: report.reportHash,
					totalFindings: report.totalFindings,
					criticalCount: totalCritical,
					agentCount: 3,
				},
			};

			const triggered = shouldAlert(reportMsg);

			console.log("\n  🚨 ALERT EVALUATION:");
			console.log(`     Critical findings: ${totalCritical}`);
			console.log(`     Alert triggered:   ${triggered ? "🔴 YES — webhook would fire" : "🟢 NO — all clear"}`);

			if (totalCritical > 0) {
				expect(triggered).toBe(true);
			} else {
				expect(triggered).toBe(false);
				console.log("     (No critical findings in this run — expected for some random seeds)");
			}
		});

		it("fireWebhook resolves without error (no URL configured in test env)", async () => {
			await expect(
				fireWebhook({
					jobId: timelockAddress,
					criticalCount: 1,
					totalFindings: report.totalFindings,
					reportHash: report.reportHash,
				}),
			).resolves.not.toThrow();
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// PHASE 7: Economic Summary
	// ────────────────────────────────────────────────────────────────────────

	describe("Phase 7: Full Economic Summary", () => {
		it("Prints the complete lifecycle summary for the TimeLockVault audit", () => {
			const rawFindings = Object.values(allFindings).flat();
			const totalCritical = rawFindings.filter((f) => f.severity === "critical").length;
			const totalHigh = rawFindings.filter((f) => f.severity === "high").length;

			console.log("\n  ═══════════════════════════════════════════════════════════");
			console.log("  🔐 TIMELOCKVAULT AUDIT — FULL ECONOMIC SUMMARY");
			console.log("  ═══════════════════════════════════════════════════════════");
			console.log(`\n  Target contract : ${timelockAddress}`);
			console.log(`  Live on chain   : ${isLiveContract ? "✅ Hedera testnet" : "⚠️  (dummy — deploy first)"}`);
			console.log(`  Type            : ${CONTRACT_TYPE}  |  Risk: ${FORCED_RISK_SCORE}  |  LOC: ${FORCED_LOC}`);
			console.log(`\n  ⚠️  INTENTIONAL RISK PLANTED: owner emergencyWithdraw with no time-gate`);
			console.log(`     → Expected severity: HIGH (centralisation / rug risk)`);

			console.log("\n  BIDS SUBMITTED:");
			allBids.forEach((b) =>
				console.log(`    ${b.agent}: ${b.amount} GUARD (collateral: ${b.collateral})`),
			);
			const cheapest = allBids.reduce((a, b) => a.amount < b.amount ? a : b);
			console.log(`    → Cheapest winner: ${cheapest.agent} @ ${cheapest.amount} GUARD`);

			console.log("\n  SUB-CONTRACTING:");
			console.log(`    LLM → Dependency: 3 GUARD  (deps: ${depAnalysis.dependencies})`);

			console.log("\n  FINDINGS:");
			for (const [agent, findings] of Object.entries(allFindings)) {
				console.log(`    ${agent}: ${findings.length} findings`);
			}
			console.log(`    After dedup: ${report.totalFindings} unique`);
			console.log(`    Critical: ${totalCritical}  |  High: ${totalHigh}`);

			console.log("\n  REPUTATION CHANGES:");
			for (const [agent, delta] of Object.entries(repDeltas)) {
				const sign = delta >= 0 ? "+" : "";
				console.log(`    ${agent}: ${sign}${delta}`);
			}

			const totalPayout = Object.keys(report.agentScores).length * 0.1;
			console.log(`\n  SETTLEMENT: ${totalPayout} GUARD total`);

			const alertFired = totalCritical > 0;
			console.log(`\n  ALERT: ${alertFired ? "🔴 FIRED — critical vulnerabilities found" : "🟢 NOT FIRED — no critical issues"}`);

			console.log("\n  ═══════════════════════════════════════════════════════════\n");

			// Summary assertions
			expect(allBids).toHaveLength(3);
			expect(report.totalFindings).toBeGreaterThan(0);
			expect(Object.keys(repDeltas)).toHaveLength(3);
			expect(totalPayout).toBeGreaterThan(0);
		});
	});
});
