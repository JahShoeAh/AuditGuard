import {
  HCSClient,
  ContractClient,
  CONFIG,
  createAgentLogger,
  createAgentWallet,
  randomFloat,
  hashOf,
} from "../shared/index.js";
import type { PaymentItem } from "../shared/contract-client.js";
import type { HCSMessage, FindingsSubmittedEvent } from "../shared/types.js";
import { ethers } from "ethers";
import { formatReport, type Finding as ReportFinding } from "../shared/report-formatter.js";

// ---- Config ----
const AGENT_ID = "report-aggregator-001";
const REPORT_API_URL = process.env.REPORT_API_URL ?? "http://localhost:4000/api/reports";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
const DIRECT_SETTLEMENT = process.env.REPORT_AGENT_DIRECT_SETTLEMENT === "true";
const REPORT_AGENT_AUTO_REGISTER = process.env.REPORT_AGENT_AUTO_REGISTER === "true";
const REPORT_AGENT_STAKE_GUARD = Number(process.env.REPORT_AGENT_STAKE_GUARD ?? "100");
const REPORT_AGENT_UCP_ENDPOINT = process.env.REPORT_AGENT_UCP_ENDPOINT ?? "openclaw://report-aggregator-001";
const REPORT_AGENT_SPECIALIZATIONS = (process.env.REPORT_AGENT_SPECIALIZATIONS ?? "reporting")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AGGREGATION_WINDOW_MS = DEMO_MODE ? 20 * 1000 : 120 * 1000;
const REPORT_FEE = 0.1;               // GUARD base fee per submitting agent
const REPORT_FEE_DISCOUNTED = 0.05;   // GUARD discounted fee for rep > 90
const HIGH_REP_THRESHOLD = 90;
const GUARD_DECIMALS = 8;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const log = createAgentLogger(AGENT_ID, "report");

// Track all submissions per job
const jobFindings = new Map<string, {
  submissions: FindingsSubmittedEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  agentAddresses: Map<string, string>; // agentId -> evmAddress
  contractAddress?: string;
  deployerAddress?: string;
}>();

let marketplaceReady = false;

async function ensureReportAgentCanList(contracts: ContractClient, walletAddress: string): Promise<boolean> {
  if (marketplaceReady) return true;

  try {
    const active = await contracts.isActiveAgent(walletAddress);
    if (active) {
      marketplaceReady = true;
      return true;
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[ReportAgent] Could not verify AgentRegistry status: ${errMessage}`);
  }

  log.warn(
    `[ReportAgent] ${walletAddress} is not an active AgentRegistry seller; ` +
      `DataMarketplace listing will fail unless registered`
  );

  if (!REPORT_AGENT_AUTO_REGISTER) {
    log.warn("[ReportAgent] Set REPORT_AGENT_AUTO_REGISTER=true to attempt self-registration");
    return false;
  }

  try {
    const stakeAmount = ethers.parseUnits(REPORT_AGENT_STAKE_GUARD.toString(), GUARD_DECIMALS);
    const guardToken = new ethers.Contract(CONFIG.guardToken.evmAddress, ERC20_ABI, contracts.wallet);

    const balance: bigint = await guardToken.balanceOf(walletAddress);
    if (balance < stakeAmount) {
      log.warn(
        `[ReportAgent] Auto-register skipped: wallet has ${ethers.formatUnits(balance, GUARD_DECIMALS)} GUARD ` +
          `but needs at least ${REPORT_AGENT_STAKE_GUARD}`
      );
      return false;
    }

    const allowance: bigint = await guardToken.allowance(walletAddress, CONFIG.contracts.agentRegistry);
    if (allowance < stakeAmount) {
      const approveTx = await guardToken.approve(CONFIG.contracts.agentRegistry, stakeAmount);
      await approveTx.wait();
      log.info(`[ReportAgent] Approved ${REPORT_AGENT_STAKE_GUARD} GUARD for AgentRegistry`);
    }

    const registerTx = await contracts.registerAgent(
      AGENT_ID,
      REPORT_AGENT_UCP_ENDPOINT,
      REPORT_AGENT_SPECIALIZATIONS,
      stakeAmount
    );
    await registerTx.wait();

    const activeAfter = await contracts.isActiveAgent(walletAddress);
    marketplaceReady = activeAfter;
    if (activeAfter) {
      log.info("[ReportAgent] Auto-registration succeeded; marketplace listing enabled");
      return true;
    }

    log.warn("[ReportAgent] Auto-registration transaction completed but agent is still inactive");
    return false;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[ReportAgent] Auto-register failed: ${errMessage}`);
    return false;
  }
}

// ---- Main ----

async function main() {
  log.info("Report Aggregator Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");

  const wallet = createAgentWallet("REPORT");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  log.info(`Wallet: ${wallet.evmAddress}`);
  await ensureReportAgentCanList(contracts, wallet.evmAddress);

  // Listen for findings from auditor agents
  hcs.subscribeAgentComms(async (msg: HCSMessage) => {
    if (msg.type === "PING") {
      try {
        await hcs.publishAgentComms({
          type: "PONG",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {},
        });
      } catch (err) {
        log.warn(`PONG publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

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

    // Capture contract metadata from first submission that includes it
    // (agents include contractAddress/deployerAddress in their FINDINGS_SUBMITTED payloads)
    const p = submission.payload as any;
    if (!job.contractAddress && p.contractAddress) {
      job.contractAddress = String(p.contractAddress);
    }
    if (!job.deployerAddress && p.deployerAddress) {
      job.deployerAddress = String(p.deployerAddress);
    }

    // Track agent EVM address for payment settlement
    if (evmAddress) {
      job.agentAddresses.set(submission.agentId, evmAddress);
    }

    // Start aggregation timer on first submission
    if (!job.timer) {
      log.info(`Starting ${AGGREGATION_WINDOW_MS / 1000}s aggregation window for job ${String(jobId).slice(0, 10)}...`);
      job.timer = setTimeout(() => {
        aggregateAndPublish(jobId, hcs, contracts, wallet.evmAddress).catch((err) => {
          log.error(`[ReportAgent] aggregateAndPublish failed for job ${jobId}: ${err}`);
        });
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
      log.info(`[ReportAgent] On-chain settlement succeeded for job ${jobId}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Direct settlement failed: ${error}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "REPORT_SETTLEMENT_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: { jobId, strictLive: true, error },
        });
        return;
      }
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

  // --- Generate, upload, and list real audit report ---
  const agentFindings = job.submissions as any[];
  const allFindings: ReportFinding[] = agentFindings.flatMap((af: any) =>
    (af?.findings || af?.results || af?.payload?.findings || af?.payload?.results || []).map((f: any) => ({
      severity: String(f?.severity || f?.level || "MEDIUM").toUpperCase(),
      title: f?.title || f?.name || "Unnamed Finding",
      description: f?.description || f?.details || "",
      location: f?.location || f?.function || undefined,
      recommendation: f?.recommendation || f?.fix || undefined,
    }))
  );

  const jobMeta = job as any;
  const firstPayload = (job.submissions[0] as any)?.payload ?? {};
  const contractAddr =
    jobMeta?.contractAddress ||
    jobMeta?.payload?.contractAddress ||
    firstPayload?.contractAddress ||
    "unknown";
  const chain = jobMeta?.chain || jobMeta?.payload?.chain || firstPayload?.chain || "hedera";
  const contractType =
    jobMeta?.contractType ||
    jobMeta?.payload?.contractType ||
    firstPayload?.contractType ||
    "unknown";
  const agents = agentFindings.map((af: any) => af?.agentId || af?.agent || "unknown");

  const markdownContent = formatReport(jobId, contractAddr, chain, contractType, agents, allFindings);
  log.info(`[ReportAgent] Generated ${markdownContent.length} char report with ${allFindings.length} findings`);

  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(markdownContent));

  // Persist report to Postgres via the dashboard API server.
  const deployer =
    jobMeta?.deployerAddress ||
    jobMeta?.payload?.deployerAddress ||
    firstPayload?.deployerAddress ||
    null;

  try {
    const res = await fetch(REPORT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        contractAddress: contractAddr,
        deployerAddress: deployer ?? ethers.ZeroAddress,
        chain,
        contractType,
        contentHash,
        mdContent: markdownContent,
        agentAddresses: Array.from(job.agentAddresses.values()),
        agentCount: agents.length,
        findingCount: totalFindings,
        findingsBySeverity: {
          critical: totalCritical,
          high:     totalHigh,
          medium:   totalMedium,
          low:      totalLow,
          info:     0,
        },
        timestamp: Date.now(),
        source: "agent",
      }),
    });
    if (res.ok) {
      const body = await res.json() as { id?: string };
      log.info(`[ReportAgent] Report saved to DB: ${body.id}`);
    } else {
      const text = await res.text().catch(() => "");
      log.warn(`[ReportAgent] DB save failed (${res.status}): ${text}`);
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[ReportAgent] DB save error: ${errMessage}`);
  }

  // Publish REPORT_METADATA for dashboard HCS stream.
  await hcs.publishAuditLog({
    type: "REPORT_METADATA",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      jobId,
      contentHash,
      deployer,
      agentCount: agents.length,
      findingCount: totalFindings,
    },
  });
  log.info(`[ReportAgent] Published REPORT_METADATA for job ${jobId}`);

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
