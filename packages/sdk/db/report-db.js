/**
 * packages/sdk/db/report-db.js
 *
 * PostgreSQL implementation. Markdown stored inline in `md_content` column.
 * Works identically for local dev and production — only DATABASE_URL differs.
 *
 * Required env:
 *   DATABASE_URL   — postgresql://user:pass@host:5432/auditguard
 */

import pg from 'pg';
import { reportId, normalizeDeployer, EMPTY_FINDINGS } from './report-types.js';

// ── Postgres pool ─────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

if (!pool) {
  console.warn('[report-db] DATABASE_URL not set — all DB operations are no-ops.');
}

// Auto-migrate: add md_content column if the table already exists without it.
let migrated = false;
async function ensureMdContentColumn() {
  if (migrated || !pool) return;
  try {
    await pool.query(`
      ALTER TABLE audit_reports
        ADD COLUMN IF NOT EXISTS md_content TEXT NOT NULL DEFAULT '';
    `);
  } catch {
    // Table may not exist yet; schema.sql will create it with the column.
  }
  migrated = true;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function toReport(row) {
  return {
    id:                 row.id,
    jobId:              row.job_id,
    contractAddress:    row.contract_address,
    deployerAddress:    row.deployer_address,
    hederaAccountId:    row.hedera_account_id,
    chain:              row.chain,
    contractType:       row.contract_type,
    contentHash:        row.content_hash,
    mdContent:          row.md_content ?? '',
    agentAddresses:     row.agent_addresses,
    agentCount:         row.agent_count,
    findingCount:       row.finding_count,
    findingsBySeverity: row.findings_by_severity,
    timestamp:          Number(row.timestamp),
    tags:               row.tags,
    source:             row.source,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a report with markdown stored inline in the DB.
 * No-op (returns id) when DATABASE_URL is not configured.
 *
 * @param {import('./report-types.js').StoredAuditReport & { mdContent?: string }} report
 * @returns {Promise<string>} canonical report id
 */
export async function saveReport(report) {
  const id = reportId(report.jobId);
  if (!pool) return id;

  await ensureMdContentColumn();

  await pool.query(`
    INSERT INTO audit_reports
      (id, job_id, contract_address, deployer_address, hedera_account_id,
       chain, contract_type, s3_key, content_hash, cid, md_content,
       agent_addresses, agent_count, finding_count, findings_by_severity,
       timestamp, tags, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO UPDATE SET
      content_hash         = EXCLUDED.content_hash,
      md_content           = EXCLUDED.md_content,
      finding_count        = EXCLUDED.finding_count,
      findings_by_severity = EXCLUDED.findings_by_severity,
      agent_count          = EXCLUDED.agent_count,
      contract_address     = COALESCE(NULLIF(EXCLUDED.contract_address, ''), audit_reports.contract_address),
      deployer_address     = COALESCE(NULLIF(EXCLUDED.deployer_address, '0x0000000000000000000000000000000000000000'), audit_reports.deployer_address)
  `, [
    id,
    String(report.jobId),
    normalizeDeployer(report.contractAddress),
    normalizeDeployer(report.deployerAddress),
    report.hederaAccountId      ?? null,
    report.chain                ?? 'hedera-testnet',
    report.contractType         ?? 'unknown',
    '',                                              // s3_key — unused
    report.contentHash,
    '',                                              // cid — unused
    report.mdContent            ?? '',
    report.agentAddresses       ?? [],
    report.agentCount           ?? 0,
    report.findingCount         ?? 0,
    JSON.stringify(report.findingsBySeverity ?? EMPTY_FINDINGS),
    report.timestamp            ?? Date.now(),
    report.tags                 ?? [],
    report.source               ?? 'agent',
  ]);

  return id;
}

/**
 * Returns all reports for a deployer address (EVM or Hedera).
 * Does NOT populate mdContent — use getReportById for that.
 *
 * @param {string} addr
 * @returns {Promise<import('./report-types.js').StoredAuditReport[]>}
 */
export async function getReportsByDeployer(addr) {
  if (!pool) return [];
  await ensureMdContentColumn();
  const normalized = normalizeDeployer(addr);
  const { rows } = await pool.query(`
    SELECT * FROM audit_reports
    WHERE deployer_address = $1 OR hedera_account_id = $1
    ORDER BY timestamp DESC
  `, [normalized]);
  return rows.map(toReport);
}

/**
 * Returns a single report by job ID including mdContent.
 *
 * @param {string} jobId
 * @returns {Promise<(import('./report-types.js').StoredAuditReport & { mdContent: string }) | null>}
 */
export async function getReportById(jobId) {
  if (!pool) return null;
  await ensureMdContentColumn();
  const { rows } = await pool.query(
    'SELECT * FROM audit_reports WHERE job_id = $1',
    [String(jobId)],
  );
  if (!rows[0]) return null;
  return toReport(rows[0]);
}

/**
 * @param {string} jobId
 * @returns {Promise<boolean>}
 */
export async function reportExists(jobId) {
  if (!pool) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM audit_reports WHERE job_id = $1',
    [String(jobId)],
  );
  return rows.length > 0;
}
