/**
 * packages/sdk/db/report-types.js
 *
 * PRE-BRANCH SHARED CONTRACT — read before opening any task/report-* branch.
 *
 * This file defines:
 *   1. Storage constants and environment variable names every task must agree on
 *   2. The StoredAuditReport schema (JSDoc)
 *   3. The REST API envelope shape (Task 3 produces, Task 4 consumes)
 *   4. Pure helpers with no side-effects (safe to import anywhere)
 *
 * DEPLOYMENT STACK: Vercel (frontend) · Docker/AWS ECS (API + orchestrator) · AWS S3 (files)
 *   - Database : PostgreSQL via DATABASE_URL  (Vercel Postgres / AWS RDS / Supabase)
 *   - Files    : AWS S3 via AWS_S3_BUCKET
 *   - Local dev: set DATABASE_URL to a local Postgres container; S3 can use LocalStack or
 *               be skipped (mdContent stored inline for dev only)
 *
 * SCHEMA FREEZE: once all four branches are open, changes to
 * StoredAuditReport fields or the API envelope require a comment on
 * every open branch PR before merging.
 */

// ── Required environment variables ────────────────────────────────────────────
//
//   DATABASE_URL          postgresql://user:pass@host:5432/auditguard
//   AWS_S3_BUCKET         auditguard-reports
//   AWS_REGION            us-east-1
//   AWS_ACCESS_KEY_ID     (from IAM role or secret)
//   AWS_SECRET_ACCESS_KEY (from IAM role or secret)
//   EVENTS_API_PORT       4000 (Express server in Docker)
//   CORS_ORIGIN           https://your-app.vercel.app (set in Docker/ECS env)
//   VITE_API_BASE_URL     https://api.your-domain.com (set in Vercel env vars)
//
//   Local dev only (optional fallbacks):
//   LOCAL_REPORTS_DIR     absolute path — used when AWS_S3_BUCKET is not set

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Canonical report ID derived from job ID.
 * @param {string|number} jobId
 * @returns {string}
 */
export function reportId(jobId) {
  return `report:${String(jobId)}`;
}

/**
 * Normalize any EVM or Hedera address for storage and comparison.
 * Always returns lowercase. Returns '' for null/undefined.
 * @param {string|null|undefined} addr
 * @returns {string}
 */
export function normalizeDeployer(addr) {
  return String(addr ?? '').trim().toLowerCase();
}

/**
 * Returns true when two deployer addresses should be considered the same.
 * Case-insensitive; handles EVM (0x...) and Hedera (0.0.NNNN) formats.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function deployerMatches(a, b) {
  return normalizeDeployer(a) === normalizeDeployer(b);
}

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FindingsBySeverity
 * @property {number} critical
 * @property {number} high
 * @property {number} medium
 * @property {number} low
 * @property {number} info
 */

/**
 * Empty FindingsBySeverity — use as the default value.
 * @type {Readonly<FindingsBySeverity>}
 */
export const EMPTY_FINDINGS = Object.freeze({
  critical: 0,
  high:     0,
  medium:   0,
  low:      0,
  info:     0,
});

/**
 * StoredAuditReport — the database record written by Task 1/2 and
 * read by Tasks 3 and 4.
 *
 * ALL FOUR TASKS depend on this exact field set.
 * Do NOT add, remove, or rename fields without coordinating all branches.
 *
 * Storage mapping:
 *   id, jobId, contractAddress, deployerAddress, hederaAccountId,
 *   chain, contractType, s3Key, contentHash, cid,
 *   agentAddresses, agentCount, findingCount, findingsBySeverity,
 *   timestamp, tags, source
 *   → stored as columns in PostgreSQL table `audit_reports`
 *
 *   mdContent (markdown text)
 *   → NOT stored in PostgreSQL; fetched from S3 on demand by getReportById()
 *   → in local dev (no AWS_S3_BUCKET set), stored inline in the JSON fallback
 *
 * @typedef {Object} StoredAuditReport
 * @property {string}              id                - "report:{jobId}"
 * @property {string}              jobId             - On-chain AuditAuction job ID
 * @property {string}              contractAddress   - Audited contract EVM address (lowercase)
 * @property {string}              deployerAddress   - Contract deployer EVM address (lowercase)
 * @property {string|null}         hederaAccountId   - Hedera 0.0.NNNN ID if available, else null
 * @property {string}              chain             - e.g. "hedera-testnet"
 * @property {string}              contractType      - "lending"|"dex"|"staking"|"bridge"|"vault"
 * @property {string}              contentHash       - SHA3-256 hex digest of markdown content
 * @property {string}              mdContent         - Full markdown text, stored inline in DB
 * @property {string[]}            agentAddresses    - EVM addresses of winning agents
 * @property {number}              agentCount
 * @property {number}              findingCount
 * @property {FindingsBySeverity}  findingsBySeverity
 * @property {number}              timestamp         - Unix ms when this record was written
 * @property {string[]}            tags              - Keywords extracted from findings
 * @property {'orchestrator'|'agent'|'manual'} source
 */

// ── REST API envelope (Task 3 produces, Task 4 consumes) ──────────────────────
//
// GET /api/reports?deployer={addr}
//   200 → { success: true,  data: StoredAuditReport[], count: number }
//   400 → { success: false, error: string }
//   500 → { success: false, error: string }
//
// GET /api/reports/:jobId
//   200 → { success: true,  data: StoredAuditReport & { mdContent: string } }
//   404 → { success: false, error: 'Report not found' }
//   500 → { success: false, error: string }
//
// POST /api/reports   body: Partial<StoredAuditReport>
//   201 → { success: true,  id: string }
//   400 → { success: false, error: string }
//   500 → { success: false, error: string }
//
// The envelope shape above is frozen. Do not change without tagging
// all four branch owners.
//
// In production the API base URL differs from the Vite dev server.
// Task 4 must use:   const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
// Vercel env var:    VITE_API_BASE_URL=https://api.your-domain.com
