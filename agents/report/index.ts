import {
  HCSClient,
  ContractClient,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomFloat,
  hashOf,
  sleep,
} from "../shared/index.js";
import type { PaymentItem } from "../shared/contract-client.js";
import type { HCSMessage, FindingsSubmittedEvent } from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "report-aggregator-001";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DIRECT_SETTLEMENT = process.env.REPORT_AGENT_DIRECT_SETTLEMENT === "true";
const AGGREGATION_WINDOW_MS = DEMO_MODE ? 20 * 1000 : 120 * 1000;
const REPORT_FEE = 0.1;               // GUARD base fee per submitting agent
const REPORT_FEE_DISCOUNTED = 0.05;   // GUARD discounted fee for rep > 90
const HIGH_REP_THRESHOLD = 90;

const log = createAgentLogger(AGENT_ID, "report");

// Track all submissions per job
const jobFindings = new Map<string, {
  submissions: FindingsSubmittedEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  agentAddresses: Map<string, string>; // agentId -> evmAddress
}>();

// ---- Main ----

async function main() {
  log.info("Report Aggregator Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");

  const wallet = createAgentWallet("REPORT");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  log.info(`Wallet: ${wallet.evmAddress}`);

  // Listen for findings from auditor agents
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type !== "FINDINGS_SUBMITTED") return;

    const submission = msg as FindingsSubmittedEvent;
    const { jobId, evmAddress } = submission.payload as any;

    log.info(
      `Findings received from ${submission.agentId} for job ${String(jobId).slice(0, 10)}... ` +
      `(${submission.payload.findingsCount} findings, ${submission.payload.criticalCount} critical)`
    );

    // Initialize tracking for this job
    if (!jobFindings.has(jobId)) {
      jobFindings.set(jobId, {
        submissions: [],
        timer: null,
        agentAddresses: new Map(),
      });
    }

    const job = jobFindings.get(jobId)!;
    job.submissions.push(submission);

    // Track agent EVM address for payment settlement
    if (evmAddress) {
      job.agentAddresses.set(submission.agentId, evmAddress);
    }

    // Start aggregation timer on first submission
    if (!job.timer) {
      log.info(`Starting ${AGGREGATION_WINDOW_MS / 1000}s aggregation window for job ${String(jobId).slice(0, 10)}...`);
      job.timer = setTimeout(() => {
        aggregateAndPublish(jobId, hcs, contracts, wallet.evmAddress);
      }, AGGREGATION_WINDOW_MS);
    }
  });

  log.info("Subscribed to agent comms. Waiting for findings...");
}

async function aggregateAndPublish(
  jobId: string,
  hcs: HCSClient,
  contracts: ContractClient,
  myAddress: string
) {
  const job = jobFindings.get(jobId);
  if (!job || job.submissions.length === 0) return;

  log.info(`═══════════════════════════════════════════`);
  log.info(`AGGREGATING REPORT for job ${jobId.slice(0, 10)}...`);
  log.info(`${job.submissions.length} agent submissions received`);

  // Aggregate findings
  let totalFindings = 0;
  let totalCritical = 0;
  let totalHigh = 0;
  let totalMedium = 0;
  let totalLow = 0;

  const agentScores: Map<string, {
    accuracy: number;
    repDelta: number;
    findingsCount: number;
    fee: number;
  }> = new Map();

  for (const sub of job.submissions) {
    totalFindings += sub.payload.findingsCount;
    totalCritical += sub.payload.criticalCount;
    totalHigh += (sub.payload as any).highCount || 0;
    totalMedium += (sub.payload as any).mediumCount || 0;
    totalLow += (sub.payload as any).lowCount || 0;

    // Mock accuracy scoring (85% valid rate)
    const validFindings = Math.round(sub.payload.findingsCount * randomFloat(0.7, 1.0));
    const accuracy = sub.payload.findingsCount > 0
      ? validFindings / sub.payload.findingsCount
      : 0;

    // Reputation delta: (accuracy - 0.7) * 10
    const repDelta = Math.round((accuracy - 0.7) * 10 * 100) / 100;

    // Mock reputation lookup for fee calculation
    const mockRep = randomFloat(60, 100);
    const fee = mockRep > HIGH_REP_THRESHOLD ? REPORT_FEE_DISCOUNTED : REPORT_FEE;

    agentScores.set(sub.agentId, {
      accuracy: Math.round(accuracy * 100),
      repDelta,
      findingsCount: sub.payload.findingsCount,
      fee,
    });

    log.info(
      `  ${sub.agentId}: accuracy=${Math.round(accuracy * 100)}%, ` +
      `rep Δ=${repDelta > 0 ? "+" : ""}${repDelta}, fee=${fee} GUARD`
    );
  }

  // Duplicate detection (mock: ~20% overlap between agent pairs)
  let duplicateCount = 0;
  const subs = job.submissions;
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const overlapCount = Math.round(
        Math.min(subs[i].payload.findingsCount, subs[j].payload.findingsCount) *
        randomFloat(0.05, 0.35)
      );
      duplicateCount += overlapCount;
    }
  }

  const uniqueFindings = Math.max(1, totalFindings - duplicateCount);
  const reportHash = hashOf({
    jobId,
    totalFindings: uniqueFindings,
    totalCritical,
    agentScores: Array.from(agentScores.entries()),
  });

  log.info(`Total findings: ${totalFindings} (${duplicateCount} duplicates, ${uniqueFindings} unique)`);
  log.info(`Severity: C:${totalCritical} H:${totalHigh} M:${totalMedium} L:${totalLow}`);
  log.info(`Report hash: ${reportHash.slice(0, 16)}...`);

  // Build a preview settlement manifest. By default, the Orchestrator executes
  // settlement to keep a single source of truth for payout authority.
  const payments: PaymentItem[] = [];
  for (const [agentId, scores] of agentScores) {
    const agentAddr = job.agentAddresses.get(agentId) || ethers.ZeroAddress;
    payments.push({
      recipient: agentAddr,
      basePayment: ethers.parseUnits(scores.findingsCount.toString(), 8),
      bonus: scores.repDelta > 0
        ? ethers.parseUnits((scores.repDelta * 0.5).toString(), 8)
        : BigInt(0),
      reportFee: ethers.parseUnits(scores.fee.toString(), 8),
      paymentType: 0, // AUDIT
      description: `Payment for ${agentId} - accuracy ${scores.accuracy}%`,
    });
  }

  if (DIRECT_SETTLEMENT) {
    try {
      await contracts.settleJob(0, payments, myAddress);
      log.info("Direct settlement executed by report agent");
    } catch (err) {
      log.warn(`Direct settlement failed (continuing): ${err}`);
    }
  } else {
    log.info("Settlement execution delegated to orchestrator");
  }

  // Publish reputation updates to audit log
  for (const [agentId, scores] of agentScores) {
    await hcs.publishAuditLog({
      type: "REPUTATION_UPDATED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        targetAgentId: agentId,
        targetAddress: job.agentAddresses.get(agentId) || "unknown",
        accuracy: scores.accuracy,
        reputationDelta: scores.repDelta,
        jobId,
      },
    });
  }

  // Publish final report
  await hcs.publishAuditLog({
    type: "REPORT_PUBLISHED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      jobId,
      reportHash,
      totalFindings: uniqueFindings,
      criticalCount: totalCritical,
      highCount: totalHigh,
      mediumCount: totalMedium,
      lowCount: totalLow,
      duplicatesDetected: duplicateCount,
      agentCount: job.submissions.length,
    },
  });

  log.info(`Report published to HCS audit log`);
  log.info(`═══════════════════════════════════════════`);

  // Cleanup
  jobFindings.delete(jobId);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}

// ─── Exported Pure Functions (for testing) ─────────────────────────────────

export interface AggregatedReport {
  jobId: string;
  totalFindings: number;
  duplicatesDetected: number;
  agentScores: Record<string, number>; // agentId -> accuracy (0-1)
  reportHash: string;
}

export function aggregateFindings(submissions: FindingsSubmittedEvent[]): AggregatedReport {
  if (submissions.length === 0) {
    return { jobId: "", totalFindings: 0, duplicatesDetected: 0, agentScores: {}, reportHash: "0x0" };
  }

  const jobId = (submissions[0].payload as any).jobId;
  let totalFindings = 0;
  const scores: Record<string, number> = {};

  for (const sub of submissions) {
    totalFindings += sub.payload.findingsCount;
    // Mock accuracy: 60-100%
    scores[sub.agentId] = randomFloat(0.6, 1.0);
  }

  // Duplicate detection: ~20% overlap between pairs
  let duplicateCount = 0;
  for (let i = 0; i < submissions.length; i++) {
    for (let j = i + 1; j < submissions.length; j++) {
      duplicateCount += Math.round(
        Math.min(submissions[i].payload.findingsCount, submissions[j].payload.findingsCount) *
        randomFloat(0.05, 0.35)
      );
    }
  }

  const uniqueFindings = Math.max(1, totalFindings - duplicateCount);
  const reportHash = hashOf({ jobId, totalFindings: uniqueFindings, scores });

  return {
    jobId,
    totalFindings: uniqueFindings,
    duplicatesDetected: duplicateCount,
    agentScores: scores,
    reportHash,
  };
}

export function calculateReputationDeltas(agentScores: Record<string, number>): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const [agentId, accuracy] of Object.entries(agentScores)) {
    deltas[agentId] = Math.round((accuracy - 0.7) * 10 * 100) / 100;
  }
  return deltas;
}
