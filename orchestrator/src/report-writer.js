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

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isMissing(value) {
  const normalized = normalizeText(value).toLowerCase();
  return (
    !normalized ||
    normalized === "unknown" ||
    normalized === "n/a" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "0x0000000000000000000000000000000000000000"
  );
}

function firstPresent(candidates) {
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!isMissing(text)) return text;
  }
  return "";
}

function resolveMetadata(job, findings) {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const contractAddress = firstPresent([
    job?.contractAddress,
    ...safeFindings.map((finding) => finding?.contractAddress),
  ]);
  const deployerAddress = firstPresent([
    job?.deployerAddress,
    ...safeFindings.map((finding) => finding?.deployerAddress),
  ]);
  const contractType = firstPresent([
    job?.contractType,
    ...safeFindings.map((finding) => finding?.contractType),
  ]);
  const contractChain = firstPresent([
    job?.contractChain,
    ...safeFindings.map((finding) => finding?.contractChain),
    "hedera-testnet",
  ]);
  return {
    contractAddress: contractAddress || "unknown",
    deployerAddress: deployerAddress || "unknown",
    contractType: contractType || "unknown",
    contractChain: contractChain || "hedera-testnet",
  };
}

function formatMarkdown(jobId, job, findings) {
  const sev = calculateSeverity(findings);
  const total = totalFindings(findings);
  const agents = job.winners ?? [];
  const metadata = resolveMetadata(job, findings);
  const reportDate = new Date().toISOString().split("T")[0];

  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${metadata.contractAddress}\`\n`;
  md += `**Chain:** ${metadata.contractChain}\n`;
  md += `**Deployer:** \`${metadata.deployerAddress}\`\n`;
  md += `**Contract Type:** ${metadata.contractType}\n`;
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

  if (agents.length > 0) {
    md += "## Winning Agents\n\n";
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
  const metadata = resolveMetadata(job, safeFindings);

  if (!hasFindings && (await reportExists(jobId))) {
    return;
  }

  const mdContent = formatMarkdown(jobId, job, safeFindings);
  const contentHash = crypto.createHash("sha3-256").update(mdContent).digest("hex");

  await saveReport({
    id: reportId(jobId),
    jobId: String(jobId),
    contractAddress: normalizeDeployer(metadata.contractAddress),
    deployerAddress: normalizeDeployer(metadata.deployerAddress),
    hederaAccountId: job.hederaAccountId ?? null,
    chain: metadata.contractChain,
    contractType: metadata.contractType,
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
