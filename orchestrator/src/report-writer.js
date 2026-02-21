/**
 * orchestrator/src/report-writer.js
 *
 * Generates a markdown audit report from in-memory job state, uploads it to
 * S3 (when AWS_S3_BUCKET is set), and persists the record to PostgreSQL.
 *
 * The findings array passed here contains per-agent summary records:
 *   { agentId, evmAddress, findingsHash, findingsCount, criticalCount }
 * — not individual vulnerability objects (those live off-chain with the agents).
 */

import crypto from 'node:crypto';
import { reportId, normalizeDeployer, EMPTY_FINDINGS } from '../../packages/sdk/db/report-types.js';
import { saveReport, reportExists } from '../../packages/sdk/db/report-db.js';

/**
 * Generate, store, and persist an audit report for a completed job.
 * Idempotent — silently returns if a report for this jobId already exists.
 *
 * @param {string|number} jobId
 * @param {object} job  In-memory job record from orchestrator
 * @param {Array<{agentId:string, evmAddress?:string, findingsHash?:string, findingsCount?:number, criticalCount?:number}>} findings
 */
export async function generateAndStoreReport(jobId, job, findings) {
  const mdContent   = formatMarkdown(jobId, job, findings);
  const contentHash = crypto.createHash('sha3-256').update(mdContent).digest('hex');

  await saveReport({
    id:                 reportId(jobId),
    jobId:              String(jobId),
    contractAddress:    normalizeDeployer(job.contractAddress ?? ''),
    deployerAddress:    normalizeDeployer(job.deployerAddress ?? ''),
    hederaAccountId:    job.hederaAccountId ?? null,
    chain:              job.contractChain   ?? 'hedera-testnet',
    contractType:       job.contractType    ?? 'unknown',
    s3Key:              '',           // saveReport uploads mdContent to S3 when BUCKET is set
    contentHash,
    cid:                job.cid       ?? '',
    agentAddresses:     job.winners   ?? [],
    agentCount:         (job.winners  ?? []).length,
    findingCount:       totalFindings(findings),
    findingsBySeverity: calculateSeverity(findings),
    timestamp:          Date.now(),
    tags:               [],
    source:             'orchestrator',
    mdContent,          // passed through to saveReport for optional S3 upload
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function totalFindings(findings) {
  return findings.reduce((sum, f) => sum + Number(f.findingsCount ?? 0), 0);
}

/**
 * Derives severity counts from per-agent summary records.
 * Only critical counts are known precisely; remaining findings are recorded
 * as high severity since per-finding severity lives with the agents.
 *
 * @param {Array} findings
 * @returns {import('../../packages/sdk/db/report-types.js').FindingsBySeverity}
 */
function calculateSeverity(findings) {
  const counts = { ...EMPTY_FINDINGS };
  for (const f of findings) {
    const critical = Number(f.criticalCount ?? 0);
    const total    = Number(f.findingsCount ?? 0);
    counts.critical += critical;
    counts.high     += Math.max(0, total - critical);
  }
  return counts;
}

function formatMarkdown(jobId, job, findings) {
  const sev    = calculateSeverity(findings);
  const total  = totalFindings(findings);
  const date   = new Date().toISOString().split('T')[0];
  const agents = job.winners ?? [];

  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${job.contractAddress ?? 'unknown'}\`\n`;
  md += `**Chain:** ${job.contractChain ?? 'hedera-testnet'}\n`;
  md += `**Deployer:** \`${job.deployerAddress ?? 'unknown'}\`\n`;
  md += `**Contract Type:** ${job.contractType ?? 'unknown'}\n`;
  md += `**Report Date:** ${date}\n\n`;

  md += `## Executive Summary\n\n`;
  md += `This audit identified **${total} finding${total !== 1 ? 's' : ''}** `;
  md += `across ${agents.length} automated analysis agent${agents.length !== 1 ? 's' : ''}.\n\n`;

  md += `## Severity Breakdown\n\n`;
  md += `- Critical: ${sev.critical}\n`;
  md += `- High: ${sev.high}\n`;
  md += `- Medium: ${sev.medium}\n`;
  md += `- Low: ${sev.low}\n`;
  md += `- Info: ${sev.info}\n\n`;

  md += `## Agent Contributions\n\n`;
  if (findings.length === 0) {
    md += `No findings were submitted by any agent.\n\n`;
  } else {
    md += `| Agent | Findings | Critical | Hash |\n`;
    md += `|-------|----------|----------|------|\n`;
    for (const f of findings) {
      const hash = f.findingsHash ? `\`${String(f.findingsHash).slice(0, 12)}…\`` : '—';
      md += `| ${f.agentId ?? 'unknown'} | ${f.findingsCount ?? 0} | ${f.criticalCount ?? 0} | ${hash} |\n`;
    }
    md += `\n`;
  }

  md += `## Winning Agents\n\n`;
  if (agents.length === 0) {
    md += `No winning agents recorded.\n\n`;
  } else {
    for (const addr of agents) {
      md += `- \`${addr}\`\n`;
    }
    md += `\n`;
  }

  return md;
}
