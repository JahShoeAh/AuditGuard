import crypto from "node:crypto";
import {
  reportId,
  normalizeDeployer,
  EMPTY_FINDINGS,
} from "../../packages/sdk/db/report-types.js";
import { saveReport, reportExists } from "../../packages/sdk/db/report-db.js";

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function totalFindings(findings) {
  return findings.reduce((sum, finding) => {
    const explicitCount = toNumber(finding?.findingsCount, NaN);
    if (Number.isFinite(explicitCount)) return sum + Math.max(0, Math.floor(explicitCount));
    return sum + 1;
  }, 0);
}

/**
 * Accepts either aggregate findings ({ findingsCount, criticalCount }) or
 * per-finding items ({ severity }).
 * @param {Array<Record<string, unknown>>} findings
 * @returns {import("../../packages/sdk/db/report-types.js").FindingsBySeverity}
 */
function calculateSeverity(findings) {
  const counts = { ...EMPTY_FINDINGS };

  for (const finding of findings) {
    const criticalCount = toNumber(finding?.criticalCount, NaN);
    const findingsCount = toNumber(finding?.findingsCount, NaN);

    if (Number.isFinite(findingsCount) || Number.isFinite(criticalCount)) {
      const critical = Math.max(0, Math.floor(Number.isFinite(criticalCount) ? criticalCount : 0));
      const total = Math.max(0, Math.floor(Number.isFinite(findingsCount) ? findingsCount : critical));
      counts.critical += critical;
      counts.high += Math.max(0, total - critical);
      continue;
    }

    const sev = String(finding?.severity ?? finding?.level ?? "info").toLowerCase();
    if (sev in counts) counts[sev] += 1;
  }

  return counts;
}

function extractTags(findings) {
  const tags = new Set();
  const keywords = ["reentrancy", "overflow", "underflow", "access control", "oracle"];
  for (const finding of findings) {
    const text = String(finding?.description ?? finding?.details ?? "").toLowerCase();
    for (const keyword of keywords) {
      if (text.includes(keyword)) tags.add(keyword);
    }
  }
  return [...tags];
}

function formatMarkdown(jobId, job, findings) {
  const sev = calculateSeverity(findings);
  const total = totalFindings(findings);
  const agents = job.winners ?? [];
  const reportDate = new Date().toISOString().split("T")[0];

  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${job.contractAddress ?? "unknown"}\`\n`;
  md += `**Chain:** ${job.contractChain ?? "hedera-testnet"}\n`;
  md += `**Deployer:** \`${job.deployerAddress ?? "unknown"}\`\n`;
  md += `**Contract Type:** ${job.contractType ?? "unknown"}\n`;
  md += `**Report Date:** ${reportDate}\n\n`;

  md += "## Executive Summary\n\n";
  md += `This audit identified **${total} finding${total === 1 ? "" : "s"}** `;
  md += `across ${agents.length} automated analysis agent${agents.length === 1 ? "" : "s"}.\n\n`;

  md += "## Severity Breakdown\n\n";
  md += `- Critical: ${sev.critical}\n`;
  md += `- High: ${sev.high}\n`;
  md += `- Medium: ${sev.medium}\n`;
  md += `- Low: ${sev.low}\n`;
  md += `- Info: ${sev.info}\n\n`;

  md += "## Agent Contributions\n\n";
  if (findings.length === 0) {
    md += "No findings were submitted by any agent.\n\n";
  } else {
    md += "| Agent | Findings | Critical | Hash |\n";
    md += "|-------|----------|----------|------|\n";
    for (const finding of findings) {
      const hash = finding?.findingsHash
        ? `\`${String(finding.findingsHash).slice(0, 12)}...\``
        : "—";
      md += `| ${finding?.agentId ?? "unknown"} | ${toNumber(finding?.findingsCount, 0)} | `;
      md += `${toNumber(finding?.criticalCount, 0)} | ${hash} |\n`;
    }
    md += "\n";
  }

  md += "## Winning Agents\n\n";
  if (agents.length === 0) {
    md += "No winning agents recorded.\n\n";
  } else {
    for (const addr of agents) {
      md += `- \`${addr}\`\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Generate and persist an audit report for a job.
 * For already-existing rows, allows updates when findings are available.
 *
 * @param {string|number} jobId
 * @param {Record<string, unknown>} job
 * @param {Array<Record<string, unknown>>} findings
 */
export async function generateAndStoreReport(jobId, job, findings) {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const hasFindings = safeFindings.length > 0;

  if (!hasFindings && (await reportExists(jobId))) {
    return;
  }

  const mdContent = formatMarkdown(jobId, job, safeFindings);
  const contentHash = crypto.createHash("sha3-256").update(mdContent).digest("hex");

  await saveReport({
    id: reportId(jobId),
    jobId: String(jobId),
    contractAddress: normalizeDeployer(job.contractAddress ?? ""),
    deployerAddress: normalizeDeployer(job.deployerAddress ?? ""),
    hederaAccountId: job.hederaAccountId ?? null,
    chain: job.contractChain ?? "hedera-testnet",
    contractType: job.contractType ?? "unknown",
    s3Key: "",
    contentHash,
    cid: job.cid ?? "",
    mdContent,
    agentAddresses: Array.isArray(job.winners) ? job.winners : [],
    agentCount: Array.isArray(job.winners) ? job.winners.length : 0,
    findingCount: totalFindings(safeFindings),
    findingsBySeverity: calculateSeverity(safeFindings),
    timestamp: Date.now(),
    tags: extractTags(safeFindings),
    source: "orchestrator",
  });
}
