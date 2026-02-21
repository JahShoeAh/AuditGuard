import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Key, reportId, normalizeDeployer, EMPTY_FINDINGS } from '../../packages/sdk/db/report-types.js';
import { saveReport, reportExists } from '../../packages/sdk/db/report-db.js';

const s3 = process.env.AWS_S3_BUCKET
  ? new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
  : null;

/**
 * Generate a full audit report, upload markdown to S3, and persist metadata
 * to PostgreSQL. Idempotent — skips if a report for this jobId already exists.
 *
 * @param {string} jobId
 * @param {object} job   - Orchestrator job state (contractAddress, deployerAddress,
 *                          contractType, contractChain, hederaAccountId, cid, winners)
 * @param {object[]} findings - Array of finding objects from agents
 */
export async function generateAndStoreReport(jobId, job, findings) {
  if (await reportExists(jobId)) return;

  const mdContent   = formatMarkdown(jobId, job, findings);
  const contentHash = crypto.createHash('sha3-256').update(mdContent).digest('hex');

  // Upload to S3 (no-op if BUCKET not set in local dev)
  let key = '';
  if (s3 && process.env.AWS_S3_BUCKET) {
    key = s3Key(jobId);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: mdContent,
      ContentType: 'text/markdown; charset=utf-8',
    }));
    console.log(`[ReportWriter] Uploaded to s3://${process.env.AWS_S3_BUCKET}/${key}`);
  } else {
    console.warn('[ReportWriter] AWS_S3_BUCKET not set — skipping S3 upload (local dev)');
  }

  await saveReport({
    id: reportId(jobId),
    jobId: String(jobId),
    contractAddress: normalizeDeployer(job.contractAddress ?? ''),
    deployerAddress: normalizeDeployer(job.deployerAddress ?? ''),
    hederaAccountId: job.hederaAccountId ?? null,
    chain: job.contractChain ?? 'hedera-testnet',
    contractType: job.contractType ?? 'unknown',
    s3Key: key,
    contentHash,
    cid: job.cid ?? '',
    agentAddresses: job.winners ?? [],
    agentCount: (job.winners ?? []).length,
    findingCount: findings.length,
    findingsBySeverity: calculateSeverity(findings),
    timestamp: Date.now(),
    tags: extractTags(findings),
    source: 'orchestrator',
  });

  console.log(`[ReportWriter] Saved report for job ${jobId} to database`);
}

/**
 * Count findings by severity level.
 * @param {object[]} findings
 * @returns {import('../../packages/sdk/db/report-types.js').FindingsBySeverity}
 */
function calculateSeverity(findings) {
  const counts = { ...EMPTY_FINDINGS };
  for (const f of findings) {
    const sev = String(f?.severity ?? f?.level ?? 'info').toLowerCase();
    if (sev in counts) counts[sev]++;
  }
  return counts;
}

/**
 * Extract keyword tags from finding descriptions.
 * @param {object[]} findings
 * @returns {string[]}
 */
function extractTags(findings) {
  const tags = new Set();
  const KEYWORDS = ['reentrancy', 'overflow', 'underflow', 'access control', 'oracle'];
  for (const f of findings) {
    const text = (f.description ?? f.details ?? '').toLowerCase();
    for (const kw of KEYWORDS) {
      if (text.includes(kw)) tags.add(kw);
    }
  }
  return [...tags];
}

/**
 * Generate a markdown audit report from job state and findings.
 * @param {string} jobId
 * @param {object} job
 * @param {object[]} findings
 * @returns {string}
 */
function formatMarkdown(jobId, job, findings) {
  const sev = calculateSeverity(findings);
  const agents = job.winners ?? [];

  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${job.contractAddress ?? 'unknown'}\`\n`;
  md += `**Chain:** ${job.contractChain ?? 'hedera-testnet'}\n`;
  md += `**Deployer:** \`${job.deployerAddress ?? 'unknown'}\`\n`;
  md += `**Contract Type:** ${job.contractType ?? 'unknown'}\n`;
  md += `**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n`;

  md += `## Executive Summary\n\n`;
  md += `This audit identified **${findings.length} findings** across ${agents.length} automated analysis agents.\n\n`;

  md += `## Severity Breakdown\n\n`;
  md += `- Critical: ${sev.critical}\n`;
  md += `- High: ${sev.high}\n`;
  md += `- Medium: ${sev.medium}\n`;
  md += `- Low: ${sev.low}\n`;
  md += `- Info: ${sev.info}\n\n`;

  md += `## Findings\n\n`;
  findings.forEach((f, i) => {
    md += `### ${f.id ?? `F-${i + 1}`}: ${f.title ?? 'Finding'}\n\n`;
    md += `**Severity:** ${String(f.severity ?? 'unknown').toUpperCase()}\n`;
    md += `**Agent:** ${f.agentId ?? 'unknown'}\n`;
    if (f.location ?? f.function) {
      md += `**Location:** ${f.location ?? f.function}\n`;
    }
    md += `\n${f.description ?? f.details ?? ''}\n\n`;
    if (f.recommendation ?? f.fix) {
      md += `**Recommendation:** ${f.recommendation ?? f.fix}\n\n`;
    }
  });

  return md;
}
