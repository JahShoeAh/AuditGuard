# Report Persistence — Task Breakdown

> **Deployment stack:** Vercel (frontend) · Docker + AWS ECS (API server + orchestrator) · AWS S3 (markdown files) · PostgreSQL via `DATABASE_URL` (Vercel Postgres / AWS RDS / Supabase)
>
> **Pre-branch prerequisites already committed to `main`:**
> - `packages/sdk/db/report-types.js` — frozen `StoredAuditReport` schema, S3 key helpers, pure helpers, API envelope spec, and gap notes. **Read this before starting any task.**
> - `orchestrator/src/schema.sql` — PostgreSQL DDL. Run once at deploy time.
> - `data/reports.json` + `data/reports/.gitkeep` — local dev scaffold.

---

## Environment variables (all tasks share these)

| Variable | Used by | Notes |
|----------|---------|-------|
| `DATABASE_URL` | Tasks A, B | `postgresql://user:pass@host:5432/auditguard` |
| `AWS_S3_BUCKET` | Task A | `auditguard-reports` |
| `AWS_REGION` | Task A | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | Task A | From IAM role in ECS; explicit in local dev |
| `AWS_SECRET_ACCESS_KEY` | Task A | From IAM role in ECS; explicit in local dev |
| `API_PORT` | Task B | Default `3002`; set in ECS task definition |
| `CORS_ORIGIN` | Task B | `https://your-app.vercel.app` |
| `VITE_API_BASE_URL` | Task C | `https://api.your-domain.com` — set in Vercel project settings |

Add all backend variables to `.env` for local dev. Never commit real values.
`VITE_API_BASE_URL` is set in the Vercel dashboard under Project → Settings → Environment Variables.

---

## Task A — DB Module + Report Writer
**Branch:** `task/report-backend`
**Touches:** new files only + 2 small edits to `orchestrator/src/orchestrator.js`
**Depends on:** nothing — no stubs needed

### Files to create / modify
```
packages/sdk/db/report-db.js           ← new — PostgreSQL + S3 abstraction
orchestrator/src/report-writer.js      ← new — markdown generation + S3 upload + DB save
orchestrator/src/orchestrator.js       ← 2 small edits (deployerAddress gap + hook)
```

> `orchestrator/src/schema.sql` is already committed. Run it to initialize the DB before testing:
> ```bash
> psql "$DATABASE_URL" -f orchestrator/src/schema.sql
> ```

### report-db.js
```js
import pg from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { reportId, normalizeDeployer, s3Key, EMPTY_FINDINGS } from './report-types.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const s3 = process.env.AWS_S3_BUCKET
  ? new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
  : null;
const BUCKET = process.env.AWS_S3_BUCKET ?? '';

async function uploadMarkdown(jobId, mdContent) {
  if (!s3 || !BUCKET || !mdContent) return '';
  const key = s3Key(jobId);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key,
    Body: mdContent, ContentType: 'text/markdown',
  }));
  return key;
}

async function fetchMarkdown(key) {
  if (!s3 || !BUCKET || !key) return '';
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body.transformToString();
}

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
    ON CONFLICT (job_id) DO UPDATE SET
      s3_key = EXCLUDED.s3_key,
      content_hash = EXCLUDED.content_hash,
      finding_count = EXCLUDED.finding_count,
      findings_by_severity = EXCLUDED.findings_by_severity,
      agent_count = EXCLUDED.agent_count
  `, [
    id, report.jobId,
    normalizeDeployer(report.contractAddress),
    normalizeDeployer(report.deployerAddress),
    report.hederaAccountId ?? null,
    report.chain, report.contractType, key,
    report.contentHash, report.cid ?? '',
    report.agentAddresses ?? [],
    report.agentCount ?? 0, report.findingCount ?? 0,
    JSON.stringify(report.findingsBySeverity ?? EMPTY_FINDINGS),
    report.timestamp ?? Date.now(),
    report.tags ?? [], report.source ?? 'orchestrator',
  ]);
  return id;
}

export async function getReportsByDeployer(addr) {
  const normalized = normalizeDeployer(addr);
  const { rows } = await pool.query(`
    SELECT * FROM audit_reports
    WHERE deployer_address = $1 OR hedera_account_id = $1
    ORDER BY timestamp DESC
  `, [normalized]);
  return rows.map(toReport);
}

export async function getReportById(jobId) {
  const { rows } = await pool.query(
    'SELECT * FROM audit_reports WHERE job_id = $1', [String(jobId)]
  );
  if (!rows[0]) return null;
  const report = toReport(rows[0]);
  report.mdContent = await fetchMarkdown(report.s3Key);
  return report;
}

export async function reportExists(jobId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM audit_reports WHERE job_id = $1', [String(jobId)]
  );
  return rows.length > 0;
}

function toReport(row) {
  return {
    id: row.id, jobId: row.job_id,
    contractAddress: row.contract_address,
    deployerAddress: row.deployer_address,
    hederaAccountId: row.hedera_account_id,
    chain: row.chain, contractType: row.contract_type,
    s3Key: row.s3_key, contentHash: row.content_hash, cid: row.cid,
    agentAddresses: row.agent_addresses,
    agentCount: row.agent_count, findingCount: row.finding_count,
    findingsBySeverity: row.findings_by_severity,
    timestamp: Number(row.timestamp), tags: row.tags, source: row.source,
  };
}
```

### Local dev setup
```bash
# Start a local Postgres container
docker run -d --name pg-local -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=auditguard -p 5432:5432 postgres:16-alpine

# Add to .env
DATABASE_URL=postgresql://postgres:dev@localhost:5432/auditguard

# Run schema
psql "$DATABASE_URL" -f orchestrator/src/schema.sql

# Leave AWS_S3_BUCKET unset — saveReport() stores s3_key as '' and
# getReportById() returns empty mdContent. No S3 access needed locally.
```

### Gap fix — add deployerAddress to orchestrator job state

**Edit 1** — `handleDiscovery()` around line 786 of `orchestrator.js`:
```js
// BEFORE:
const { contractAddress, contractType, budget, riskScore, estimatedLOC } = msg.payload;

// AFTER:
const { contractAddress, contractType, budget, riskScore, estimatedLOC,
        deployerAddress } = msg.payload;
```

**Edit 2** — `setJobByKey()` call around line 1064 of `orchestrator.js`:
```js
this.setJobByKey(jobId, {
  contractAddress,
  deployerAddress: normalizeDeployer(deployerAddress ?? ''),  // ← ADD
  contractType,
  // ...rest unchanged
});
```

### report-writer.js
```js
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Key, reportId, normalizeDeployer, EMPTY_FINDINGS }
  from '../../packages/sdk/db/report-types.js';
import { saveReport, reportExists } from '../../packages/sdk/db/report-db.js';

const s3 = process.env.AWS_S3_BUCKET
  ? new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' })
  : null;

export async function generateAndStoreReport(jobId, job, findings) {
  if (await reportExists(jobId)) return;   // idempotent

  const mdContent   = formatMarkdown(jobId, job, findings);
  const contentHash = crypto.createHash('sha3-256').update(mdContent).digest('hex');

  // Upload to S3 (no-op if BUCKET not set in local dev)
  let key = '';
  if (s3 && process.env.AWS_S3_BUCKET) {
    key = s3Key(jobId);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET, Key: key,
      Body: mdContent, ContentType: 'text/markdown',
    }));
  }

  await saveReport({
    id: reportId(jobId), jobId,
    contractAddress: normalizeDeployer(job.contractAddress ?? ''),
    deployerAddress: normalizeDeployer(job.deployerAddress ?? ''),
    hederaAccountId: job.hederaAccountId ?? null,
    chain: job.contractChain ?? 'hedera-testnet',
    contractType: job.contractType ?? 'unknown',
    s3Key: key, contentHash, cid: job.cid ?? '',
    agentAddresses: job.winners ?? [],
    agentCount: (job.winners ?? []).length,
    findingCount: findings.length,
    findingsBySeverity: calculateSeverity(findings),
    timestamp: Date.now(),
    tags: extractTags(findings),
    source: 'orchestrator',
  });
}

function calculateSeverity(findings) {
  const counts = { ...EMPTY_FINDINGS };
  for (const f of findings) {
    const sev = String(f?.severity ?? f?.level ?? 'info').toLowerCase();
    if (sev in counts) counts[sev]++;
  }
  return counts;
}

function extractTags(findings) {
  const tags = new Set();
  const KEYWORDS = ['reentrancy', 'overflow', 'underflow', 'access control', 'oracle'];
  for (const f of findings) {
    const text = (f.description ?? f.details ?? '').toLowerCase();
    for (const kw of KEYWORDS) if (text.includes(kw)) tags.add(kw);
  }
  return [...tags];
}

function formatMarkdown(jobId, job, findings) {
  const sev = calculateSeverity(findings);
  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${job.contractAddress}\`\n`;
  md += `**Chain:** ${job.contractChain ?? 'hedera-testnet'}\n`;
  md += `**Deployer:** \`${job.deployerAddress}\`\n`;
  md += `**Contract Type:** ${job.contractType}\n`;
  md += `**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n`;
  md += `## Executive Summary\n\nThis audit identified **${findings.length} findings** across ${(job.winners ?? []).length} automated analysis agents.\n\n`;
  md += `## Severity Breakdown\n\n- Critical: ${sev.critical}\n- High: ${sev.high}\n- Medium: ${sev.medium}\n- Low: ${sev.low}\n\n`;
  md += `## Findings\n\n`;
  findings.forEach((f, i) => {
    md += `### ${f.id ?? `F-${i + 1}`}: ${f.title ?? 'Finding'}\n\n`;
    md += `**Severity:** ${String(f.severity ?? 'unknown').toUpperCase()}\n`;
    md += `**Agent:** ${f.agentId ?? 'unknown'}\n\n`;
    md += `${f.description ?? f.details ?? ''}\n\n`;
    if (f.recommendation ?? f.fix) md += `**Recommendation:** ${f.recommendation ?? f.fix}\n\n`;
  });
  return md;
}
```

### Hook into orchestrator — existing WinnersSelected handler

After the existing `WINNER_SELECTED` audit log publish, add:
```js
const job = this.getJobByKey(key);
if (job && !job.reportPublished) {
  generateAndStoreReport(key, job, job.findings ?? [])
    .then(() => this.log.info(`[ReportWriter] Saved report for job ${key}`))
    .catch((err) => this.log.warn(`[ReportWriter] Failed for job ${key}: ${err.message}`));
}
```

### Test before merging
1. `saveReport()` inserts a row — verify with `psql`
2. `getReportsByDeployer()` returns records for both EVM and Hedera address
3. `saveReport()` on same `jobId` updates (no duplicate row)
4. `reportExists()` returns `true` after insert, `false` before
5. `WinnersSelected` event triggers `generateAndStoreReport()`
6. S3 object `reports/{jobId}.md` exists (or skip logged when no bucket)
7. No duplicate DB rows when `WinnersSelected` fires twice for the same job

---

## Task B — Express API Server
**Branch:** `task/report-api`
**Touches:** new directory + 6-line edit to `vite.config.js`
**Depends on:** Task A's `report-db.js` — use stub below during development

### Files to create / modify
```
packages/dashboard/server/index.js         ← new — Express entry point
packages/dashboard/server/api/reports.js   ← new — route handler
packages/dashboard/server/Dockerfile       ← new — production container
packages/dashboard/vite.config.js          ← edit — add /api proxy for local dev
```

### Stub for local dev (before Task A merges)
```js
// packages/sdk/db/report-db.js  ← temporary file, delete when Task A merges
export async function getReportsByDeployer() { return []; }
export async function getReportById()        { return null; }
export async function saveReport(r)          { return `report:${r.jobId}`; }
export async function reportExists()         { return false; }
```

### Dockerfile
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY packages/sdk/db/           ./packages/sdk/db/
COPY packages/dashboard/server/ ./packages/dashboard/server/

EXPOSE ${API_PORT:-3002}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${API_PORT:-3002}/health || exit 1

CMD ["node", "packages/dashboard/server/index.js"]
```

Build and push to ECR:
```bash
docker build -f packages/dashboard/server/Dockerfile -t auditguard-api .
docker tag auditguard-api:latest <ecr-uri>:latest
docker push <ecr-uri>:latest
```

ECS task definition env vars to set: `DATABASE_URL`, `AWS_S3_BUCKET`, `AWS_REGION`, `API_PORT`, `CORS_ORIGIN`
In ECS use an IAM task role for AWS credentials — do not set `AWS_ACCESS_KEY_ID` in ECS.

### Express entry point (`server/index.js`)
```js
import express from 'express';
import reportsRouter from './api/reports.js';

const app  = express();
const PORT = process.env.API_PORT ?? 3002;
const CORS = process.env.CORS_ORIGIN ?? '*';   // set to Vercel URL in production

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`[API] listening on :${PORT}`));
```

### Route handler (`server/api/reports.js`)
```js
import express from 'express';
import { getReportsByDeployer, getReportById, saveReport }
  from '../../packages/sdk/db/report-db.js';
import { normalizeDeployer, reportId } from '../../packages/sdk/db/report-types.js';

const router   = express.Router();
const JOB_ID_RE = /^[a-zA-Z0-9-]+$/;

// GET /api/reports?deployer={addr}
router.get('/', async (req, res) => {
  const { deployer } = req.query;
  if (!deployer) return res.status(400).json({ success: false, error: 'Missing deployer' });
  try {
    const data = await getReportsByDeployer(normalizeDeployer(deployer));
    res.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error('[API] GET /reports:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/reports/:jobId  (includes mdContent fetched from S3)
router.get('/:jobId', async (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId))
    return res.status(400).json({ success: false, error: 'Invalid job ID' });
  try {
    const data = await getReportById(req.params.jobId);
    if (!data) return res.status(404).json({ success: false, error: 'Report not found' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /reports/:jobId:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/reports  (called from orchestrator report-writer)
router.post('/', async (req, res) => {
  const required = ['jobId', 'contractAddress', 'deployerAddress', 'contentHash'];
  const missing  = required.filter(f => !req.body[f]);
  if (missing.length) return res.status(400).json({ success: false, error: `Missing: ${missing}` });
  try {
    const id = await saveReport({
      ...req.body,
      id: reportId(req.body.jobId),
      deployerAddress: normalizeDeployer(req.body.deployerAddress),
      contractAddress: normalizeDeployer(req.body.contractAddress),
    });
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[API] POST /reports:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
```

### Vite proxy edit (`vite.config.js`) — local dev only
```js
proxy: {
  '/hedera-rpc': {                              // existing — keep
    target: 'https://testnet.hashio.io',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/hedera-rpc/, '/api'),
  },
  '/api': {                                     // ← ADD
    target: `http://localhost:${process.env.API_PORT ?? 3002}`,
    changeOrigin: true,
  },
},
```

This proxy is only active during `npm run dev`. In production the Vite build is a static bundle on Vercel; it calls `VITE_API_BASE_URL` directly — no proxy involved.

### Test before merging
```bash
# Start server locally
node packages/dashboard/server/index.js

curl "http://localhost:3002/health"
curl "http://localhost:3002/api/reports?deployer=0xabc..."
curl "http://localhost:3002/api/reports/42"
curl "http://localhost:3002/api/reports/../etc/passwd"   # must return 400
```

Test Docker build locally:
```bash
docker build -f packages/dashboard/server/Dockerfile -t auditguard-api-test .
docker run --env-file .env -p 3002:3002 auditguard-api-test
curl http://localhost:3002/health
```

---

## Task C — Frontend Hook + UI
**Branch:** `task/report-ui`
**Touches:** new files + 1 small edit to an existing reports page
**Depends on:** Task B's API shape (already frozen in `report-types.js`) — use mock server during dev

### Files to create / modify
```
packages/dashboard/src/hooks/useUserReports.js               ← new
packages/dashboard/src/components/reports/UserReportList.jsx ← new
packages/dashboard/src/pages/ReportMarketplace.jsx           ← edit — add My Reports section
```

### Production API base URL

All fetch calls must be prefixed with `VITE_API_BASE_URL` so that the Vercel-deployed frontend reaches the AWS API server:

```js
// At the top of useUserReports.js
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
// Usage:
fetch(`${API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`)
```

Set in Vercel project settings → Environment Variables:
```
VITE_API_BASE_URL = https://api.your-domain.com
```
Leave unset (or empty) for local dev — the Vite proxy handles routing.

### Hook (`useUserReports.js`)
```js
import { useState, useEffect } from 'react';
import useStore from '../store';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function useUserReports() {
  const address = useStore(s => s.walletAddress);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!address) { setReports([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setReports(d.success ? d.data : []); setError(d.error ?? null); } })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

  return { reports, loading, error };
}

export function useReportByJob(jobId) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/reports/${jobId}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setReport(d.success ? d.data : null); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId]);

  return { report, loading, error };
}
```

Do not use `useAsyncMemo` — the package is not installed.

### Component (`UserReportList.jsx`)
States to handle in order:
1. `!address` — "Connect your wallet to view reports"
2. `loading` — spinner
3. `error` — error banner
4. `reports.length === 0` — empty state
5. Grid of `ReportCard` — severity chips, "View Report" link to `/reports/:jobId`

Use `fmt.address()` from `utils/format.js` for shortened addresses.
Use existing severity color conventions from `reportConstants.js` or match the dashboard's existing pattern.

### Wire into existing page
Add a "My Reports" tab or section in `ReportMarketplace.jsx` that renders `<UserReportList />`. Do not replace existing marketplace content.

### Mock server for development (before Task B merges)
```bash
node scripts/mock-api.js   # starts on :3002 with hardcoded sample data
```

### Test before merging
1. Wallet not connected → connect prompt shown, no console errors
2. Wallet connected → fetch fires with `API_BASE` prefix, reports render
3. Set `VITE_API_BASE_URL=http://localhost:3002` in `.env.local` → confirm it overrides the proxy (simulates Vercel production)
4. Different wallet address → list clears and re-fetches
5. API returns 500 → error banner shown, no crash

---

## Merge Order

```
main (report-types.js + schema.sql already committed)
  │
  ├─ task/report-backend   → merge first (run schema.sql migration before merge)
  │     └─ removes stubs from task/report-api and task/report-ui
  │
  ├─ task/report-api       → merge second (independent of task/report-ui)
  │     └─ ensure CORS_ORIGIN is set in ECS before deploying
  │
  └─ task/report-ui        → merge third (remove mock-api.js if added)
```

Tasks B and C may merge in either order — they share no modified files.

---

## Deployment Checklist

### Before first deploy
- [ ] `psql "$DATABASE_URL" -f orchestrator/src/schema.sql` — run migration
- [ ] S3 bucket `auditguard-reports` created with private ACL
- [ ] ECS IAM task role has `s3:PutObject` + `s3:GetObject` on the bucket
- [ ] ECS task definition has all env vars: `DATABASE_URL`, `AWS_S3_BUCKET`, `AWS_REGION`, `API_PORT`, `CORS_ORIGIN`
- [ ] Vercel project has `VITE_API_BASE_URL` pointing to ECS service URL
- [ ] Vite proxy config added (only active in local dev, inert in Vercel build)

### Cross-task code checklist
- [ ] All addresses go through `normalizeDeployer()` — no raw string comparison
- [ ] Job IDs validated against `/^[a-zA-Z0-9-]+$/` before use in S3 keys or DB queries
- [ ] `mdContent` is never stored in PostgreSQL — only fetched from S3 on demand
- [ ] `deployerAddress` is present and lowercase on every `StoredAuditReport` written
- [ ] No hardcoded paths, ports, or bucket names — all via env vars
- [ ] `VITE_API_BASE_URL` prefix on every `fetch()` call in Task C
