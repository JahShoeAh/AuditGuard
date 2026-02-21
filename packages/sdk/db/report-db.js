import pg from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { reportId, normalizeDeployer, s3Key, EMPTY_FINDINGS } from './report-types.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const s3 = process.env.AWS_S3_BUCKET
  ? new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
  : null;
const BUCKET = process.env.AWS_S3_BUCKET ?? '';

/**
 * Upload markdown content to S3. Skips silently when AWS_S3_BUCKET is not set.
 * @param {string|number} jobId
 * @param {string} mdContent
 * @returns {Promise<string>} S3 key or '' if skipped
 */
async function uploadMarkdown(jobId, mdContent) {
  if (!s3 || !BUCKET || !mdContent) return '';
  const key = s3Key(jobId);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: mdContent,
    ContentType: 'text/markdown; charset=utf-8',
  }));
  return key;
}

/**
 * Fetch markdown content from S3. Returns '' when bucket/key is empty.
 * @param {string} key
 * @returns {Promise<string>}
 */
async function fetchMarkdown(key) {
  if (!s3 || !BUCKET || !key) return '';
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await res.Body.transformToString();
  } catch (err) {
    console.error(`[report-db] Failed to fetch S3 key ${key}:`, err.message);
    return '';
  }
}

/**
 * Save or update a report record in PostgreSQL. Idempotent via ON CONFLICT.
 * @param {import('./report-types.js').StoredAuditReport & { mdContent?: string }} report
 * @returns {Promise<string>} report ID
 */
export async function saveReport(report) {
  const key = report.s3Key || await uploadMarkdown(report.jobId, report.mdContent);
  const id  = reportId(report.jobId);
  await pool.query(`
    INSERT INTO audit_reports
      (id, job_id, contract_address, deployer_address, hedera_account_id,
       chain, contract_type, s3_key, content_hash, cid,
       agent_addresses, agent_count, finding_count, findings_by_severity,
       timestamp, tags, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (id) DO UPDATE SET
      s3_key               = EXCLUDED.s3_key,
      content_hash         = EXCLUDED.content_hash,
      finding_count        = EXCLUDED.finding_count,
      findings_by_severity = EXCLUDED.findings_by_severity,
      agent_count          = EXCLUDED.agent_count
  `, [
    id,
    String(report.jobId),
    normalizeDeployer(report.contractAddress),
    normalizeDeployer(report.deployerAddress),
    report.hederaAccountId ?? null,
    report.chain ?? 'hedera-testnet',
    report.contractType ?? 'unknown',
    key,
    report.contentHash ?? '',
    report.cid ?? '',
    report.agentAddresses ?? [],
    report.agentCount ?? 0,
    report.findingCount ?? 0,
    JSON.stringify(report.findingsBySeverity ?? EMPTY_FINDINGS),
    report.timestamp ?? Date.now(),
    report.tags ?? [],
    report.source ?? 'orchestrator',
  ]);
  return id;
}

/**
 * Fetch all reports for a deployer address. Does NOT include mdContent.
 * Matches on deployer_address OR hedera_account_id (case-insensitive).
 * @param {string} addr
 * @returns {Promise<import('./report-types.js').StoredAuditReport[]>}
 */
export async function getReportsByDeployer(addr) {
  const normalized = normalizeDeployer(addr);
  const { rows } = await pool.query(`
    SELECT * FROM audit_reports
    WHERE deployer_address = $1 OR hedera_account_id = $1
    ORDER BY timestamp DESC
  `, [normalized]);
  return rows.map(toReport);
}

/**
 * Fetch a single report by job ID, including mdContent from S3.
 * @param {string|number} jobId
 * @returns {Promise<(import('./report-types.js').StoredAuditReport & { mdContent: string }) | null>}
 */
export async function getReportById(jobId) {
  const { rows } = await pool.query(
    'SELECT * FROM audit_reports WHERE job_id = $1',
    [String(jobId)]
  );
  if (!rows[0]) return null;
  const report = toReport(rows[0]);
  report.mdContent = await fetchMarkdown(report.s3Key);
  return report;
}

/**
 * Check if a report exists for the given job ID.
 * @param {string|number} jobId
 * @returns {Promise<boolean>}
 */
export async function reportExists(jobId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM audit_reports WHERE job_id = $1',
    [String(jobId)]
  );
  return rows.length > 0;
}

/**
 * Map a PostgreSQL snake_case row to a camelCase StoredAuditReport object.
 * @param {object} row
 * @returns {import('./report-types.js').StoredAuditReport}
 */
function toReport(row) {
  return {
    id:                 row.id,
    jobId:              row.job_id,
    contractAddress:    row.contract_address,
    deployerAddress:    row.deployer_address,
    hederaAccountId:    row.hedera_account_id,
    chain:              row.chain,
    contractType:       row.contract_type,
    s3Key:              row.s3_key,
    contentHash:        row.content_hash,
    cid:                row.cid,
    agentAddresses:     row.agent_addresses,
    agentCount:         row.agent_count,
    findingCount:       row.finding_count,
    findingsBySeverity: row.findings_by_severity,
    timestamp:          Number(row.timestamp),
    tags:               row.tags,
    source:             row.source,
  };
}
