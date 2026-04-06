import { createRequire } from "node:module";
import { reportId, normalizeDeployer, EMPTY_FINDINGS } from "./report-types.js";

const require = createRequire(import.meta.url);

function buildPgPool() {
  if (!process.env.DATABASE_URL) return null;
  try {
    const pg = require("pg");
    return new pg.Pool({ connectionString: process.env.DATABASE_URL });
  } catch (err) {
    console.warn(
      `[report-db] pg dependency unavailable; report DB disabled: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

const pool = buildPgPool();

if (!pool) {
  console.warn("[report-db] DATABASE_URL not set — report DB operations are no-ops.");
}

const BUCKET = (process.env.AWS_S3_BUCKET ?? "").trim();
const AWS_REGION = (process.env.AWS_REGION ?? "us-east-1").trim();

let migrated = false;
let s3SdkPromise = null;

function buildS3Key(jobId) {
  return `reports/${String(jobId)}.md`;
}

function normalizeFindingsBySeverity(value) {
  if (value && typeof value === "object") {
    const src = value;
    return {
      critical: Number(src.critical ?? 0),
      high: Number(src.high ?? 0),
      medium: Number(src.medium ?? 0),
      low: Number(src.low ?? 0),
      info: Number(src.info ?? 0),
    };
  }
  return { ...EMPTY_FINDINGS };
}

async function ensureMdContentColumn() {
  if (migrated || !pool) return;
  try {
    await pool.query(`
      ALTER TABLE audit_reports
        ADD COLUMN IF NOT EXISTS md_content TEXT NOT NULL DEFAULT '';
    `);
  } catch {
    // Table may not exist yet. schema.sql creates it with md_content.
  }
  migrated = true;
}

async function loadS3Sdk() {
  if (!BUCKET) return null;
  if (!s3SdkPromise) {
    s3SdkPromise = import("@aws-sdk/client-s3")
      .then((mod) => ({
        client: new mod.S3Client({ region: AWS_REGION }),
        PutObjectCommand: mod.PutObjectCommand,
        GetObjectCommand: mod.GetObjectCommand,
      }))
      .catch((err) => {
        console.warn(
          `[report-db] AWS SDK unavailable; S3 report storage disabled: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      });
  }
  return s3SdkPromise;
}

async function uploadMarkdown(jobId, mdContent) {
  if (!mdContent || !BUCKET) return "";
  const sdk = await loadS3Sdk();
  if (!sdk) return "";

  const key = buildS3Key(jobId);
  try {
    await sdk.client.send(new sdk.PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: mdContent,
      ContentType: "text/markdown; charset=utf-8",
    }));
    return key;
  } catch (err) {
    console.warn(
      `[report-db] Failed uploading markdown for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return "";
  }
}

async function fetchMarkdown(key) {
  if (!key || !BUCKET) return "";
  const sdk = await loadS3Sdk();
  if (!sdk) return "";

  try {
    const res = await sdk.client.send(
      new sdk.GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    return await res.Body.transformToString();
  } catch (err) {
    console.warn(
      `[report-db] Failed fetching markdown for key ${key}: ${err instanceof Error ? err.message : String(err)}`
    );
    return "";
  }
}

function toReport(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    contractAddress: row.contract_address,
    deployerAddress: row.deployer_address,
    hederaAccountId: row.hedera_account_id,
    chain: row.chain,
    contractType: row.contract_type,
    s3Key: row.s3_key ?? "",
    contentHash: row.content_hash,
    cid: row.cid ?? "",
    mdContent: row.md_content ?? "",
    agentAddresses: Array.isArray(row.agent_addresses) ? row.agent_addresses : [],
    agentCount: Number(row.agent_count ?? 0),
    findingCount: Number(row.finding_count ?? 0),
    findingsBySeverity: normalizeFindingsBySeverity(row.findings_by_severity),
    timestamp: Number(row.timestamp ?? Date.now()),
    tags: Array.isArray(row.tags) ? row.tags : [],
    source: row.source ?? "orchestrator",
  };
}

/**
 * @param {import("./report-types.js").StoredAuditReport & { mdContent?: string }} report
 * @returns {Promise<string>}
 */
export async function saveReport(report) {
  const id = reportId(report.jobId);
  if (!pool) return id;

  await ensureMdContentColumn();

  const mdContent = typeof report.mdContent === "string" ? report.mdContent : "";
  const uploadedKey = await uploadMarkdown(report.jobId, mdContent);
  const key = report.s3Key || uploadedKey || "";

  await pool.query(`
    INSERT INTO audit_reports
      (id, job_id, contract_address, deployer_address, hedera_account_id,
       chain, contract_type, s3_key, content_hash, cid, md_content,
       agent_addresses, agent_count, finding_count, findings_by_severity,
       timestamp, tags, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO UPDATE SET
      s3_key               = COALESCE(NULLIF(EXCLUDED.s3_key, ''), audit_reports.s3_key),
      content_hash         = EXCLUDED.content_hash,
      cid                  = COALESCE(NULLIF(EXCLUDED.cid, ''), audit_reports.cid),
      md_content           = COALESCE(NULLIF(EXCLUDED.md_content, ''), audit_reports.md_content),
      finding_count        = EXCLUDED.finding_count,
      findings_by_severity = EXCLUDED.findings_by_severity,
      agent_count          = EXCLUDED.agent_count,
      agent_addresses      = EXCLUDED.agent_addresses,
      tags                 = EXCLUDED.tags,
      source               = EXCLUDED.source,
      contract_address     = COALESCE(
        NULLIF(NULLIF(EXCLUDED.contract_address, ''), 'unknown'),
        audit_reports.contract_address
      ),
      contract_type        = COALESCE(
        NULLIF(NULLIF(EXCLUDED.contract_type, ''), 'unknown'),
        audit_reports.contract_type
      ),
      deployer_address     = COALESCE(
        NULLIF(
          NULLIF(
            NULLIF(EXCLUDED.deployer_address, ''),
            'unknown'
          ),
          '0x0000000000000000000000000000000000000000'
        ),
        audit_reports.deployer_address
      )
  `, [
    id,
    String(report.jobId),
    normalizeDeployer(report.contractAddress),
    normalizeDeployer(report.deployerAddress),
    report.hederaAccountId ?? null,
    report.chain ?? "hedera-testnet",
    report.contractType ?? "unknown",
    key,
    report.contentHash ?? "",
    report.cid ?? "",
    mdContent,
    report.agentAddresses ?? [],
    report.agentCount ?? 0,
    report.findingCount ?? 0,
    JSON.stringify(report.findingsBySeverity ?? EMPTY_FINDINGS),
    report.timestamp ?? Date.now(),
    report.tags ?? [],
    report.source ?? "orchestrator",
  ]);

  return id;
}

/**
 * @param {string} addr
 * @returns {Promise<import("./report-types.js").StoredAuditReport[]>}
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
 * @param {string|number} jobId
 * @returns {Promise<(import("./report-types.js").StoredAuditReport & { mdContent: string }) | null>}
 */
export async function getReportById(jobId) {
  if (!pool) return null;
  await ensureMdContentColumn();

  const { rows } = await pool.query(
    "SELECT * FROM audit_reports WHERE job_id = $1",
    [String(jobId)]
  );
  if (!rows[0]) return null;

  const report = toReport(rows[0]);
  if (!report.mdContent && report.s3Key) {
    report.mdContent = await fetchMarkdown(report.s3Key);
  }
  return report;
}

/**
 * @param {string|number} jobId
 * @returns {Promise<boolean>}
 */
export async function reportExists(jobId) {
  if (!pool) return false;
  const { rows } = await pool.query(
    "SELECT 1 FROM audit_reports WHERE job_id = $1",
    [String(jobId)]
  );
  return rows.length > 0;
}
