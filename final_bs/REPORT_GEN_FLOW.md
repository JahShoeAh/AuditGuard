# Report Generation Flow

> **Purpose:** Document the complete workflow from winning agent selection to report storage

---

## Overview

This flow describes how autonomous agents generate, store, and link audit reports. The process begins when the orchestrator detects a job winner, triggers report generation, uploads the markdown to S3, and persists the metadata record to PostgreSQL.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 1. Listen for AuditAuction.WinnersSelected event              │  │
│  │ 2. Extract: jobId, winner addresses, contract details         │  │
│  │ 3. Check: Has 'REPORT_PUBLISHED' HCS message from report agent│  │
│  │ 4. Extract: CID, contentHash, findings from metadata          │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                            │                                         │
│                            ▼                                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 5. Call generateAndStoreReport()                              │  │
│  │    - Fetch all FINDINGS_SUBMITTED messages for this job       │  │
│  │    - Aggregate findings into combined report                  │  │
│  │    - Generate markdown string                                 │  │
│  │    - Upload to S3 at key reports/{jobId}.md                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           AWS S3                                     │
│  Bucket: auditguard-reports                                          │
│  Key:    reports/{jobId}.md                                          │
│  (markdown content stored here; never in PostgreSQL)                 │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATABASE (PostgreSQL)                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Stores: StoredAuditReport metadata with deployer linkage      │  │
│  │   - jobId, contractAddress, deployerAddress                   │  │
│  │   - s3Key, contentHash, cid                                   │  │
│  │   - agentAddresses, findingsBySeverity, tags                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       FRONTEND (Vercel)                              │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Wallet connection → Query /api/reports?deployer={addr}        │  │
│  │ Display report list → Click → Fetch mdContent from API        │  │
│  │ API fetches mdContent from S3, returns in response            │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Complete Workflow

### Phase 1: Job Discovery & Auction

```
1. Scanner Agent discovers contract
   ↓
2. Publishes CONTRACT_DISCOVERED to HCS Discovery topic
   ↓
3. Orchestrator receives discovery
   ↓
4. Orchestrator creates AuditAuction job
   ↓
5. Auction opens → Agents submit bids
```

**Event Stream:**
```json
{
  "type": "CONTRACT_DISCOVERED",
  "agentId": "scanner-001",
  "timestamp": 1740000000000,
  "payload": {
    "contractAddress": "0x123...",
    "chain": "hedera-testnet",
    "deployerAddress": "0xabc...",
    "riskScore": 75,
    "contractType": "lending"
  }
}
```

---

### Phase 2: Agent Bidding & Winner Selection

```
6. StaticAnalysis, Fuzzer, LLMContextual agents receive AUCTION_INVITE
   ↓
7. Agents submit bids on-chain (AuditAuction.BidSubmitted)
   ↓
8. Orchestrator tracks bids, closes auction
   ↓
9. Orchestrator selects winner(s) via AuditAuction.selectWinner()
   ↓
10. AuditAuction.WinnersSelected event fires
```

**Event Stream:**
```
AuditAuction contract:
WinnersSelected {
  jobId: "123",
  winners: ["0xstatic-addr", "0xllm-addr"],
  amounts: [100000000n, 100000000n],
  totalEscrowed: 200000000n
}
```

---

### Phase 3: Agent Report Generation

**Current Implementation (from `agents/report/index.ts`):**

```typescript
// Listen for agent findings
hcs.subscribeAgentComms(async (msg) => {
  if (msg.type !== "FINDINGS_SUBMITTED") return;
  jobFindings.get(jobId).submissions.push(msg);
});

// Start aggregation timer after first submission
if (!job.timer) {
  job.timer = setTimeout(() => {
    aggregateAndPublish(jobId, hcs, contracts, wallet.evmAddress);
  }, AGGREGATION_WINDOW_MS);
}

// Aggregate & publish
async function aggregateAndPublish(...) {
  // 1. Collect all findings
  // 2. Calculate accuracy scores
  // 3. Detect duplicates
  // 4. Compute final report hash

  // 5. Publish REPORT_PUBLISHED to HCS
  await hcs.publishAuditLog({
    type: "REPORT_PUBLISHED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: { jobId, reportHash }
  });

  // 6. Generate markdown
  const markdownContent = formatReport(...);

  // 7. Upload to IPFS
  const cid = await uploadToIPFSSafe(markdownContent);

  // 8. Publish REPORT_METADATA to HCS
  await hcs.publishAuditLog({
    type: "REPORT_METADATA",
    payload: {
      jobId,
      cid,
      contentHash,
      deployer,
      agentCount: agents.length,
      findingCount: allFindings.length
    }
  });
}
```

**Current Output:**
- ✅ Agent generates markdown via `formatReport()`
- ✅ Uploads to IPFS via `uploadToIPFSSafe()`
- ✅ Publishes CID + hash + deployer to HCS `REPORT_METADATA`
- ❌ **Does NOT upload to S3**
- ❌ **Does NOT persist metadata to PostgreSQL**

---

### Phase 4: S3 Upload + Database Persistence (NEW — Task 2)

**New Code to Implement:**

```javascript
// orchestrator/src/report-writer.js (NEW FILE)
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Key, reportId, normalizeDeployer, EMPTY_FINDINGS } from '../../packages/sdk/db/report-types.js';
import { saveReport } from '../../packages/sdk/db/report-db.js';
import { createHash } from 'crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const BUCKET = process.env.AWS_S3_BUCKET;

/**
 * Orchestrator-triggered report generation and S3+DB storage.
 * Called after winner selection + REPORT_METADATA availability.
 */
export async function generateAndStoreReport({
  jobId,
  contractAddress,
  deployerAddress,
  hederaAccountId,
  chain,
  contractType,
  reportMeta,   // { cid, contentHash, agentAddresses, findingCount, agentCount }
  findings,     // array of FINDINGS_SUBMITTED payloads
}) {
  console.log(`[ReportWriter] Generating report for job ${jobId}...`);

  // Step 1: Generate markdown string
  const markdownContent = createMarkdownReport({
    jobId, contractAddress, deployerAddress, chain, contractType, findings,
    agents: reportMeta.agentAddresses ?? [],
    findingCount: reportMeta.findingCount ?? 0,
  });

  // Step 2: Compute content hash
  const contentHash = createHash('sha3-256').update(markdownContent).digest('hex');

  // Step 3: Upload to S3
  const key = s3Key(jobId);
  if (BUCKET) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: markdownContent,
      ContentType: 'text/markdown; charset=utf-8',
    }));
    console.log(`[ReportWriter] Uploaded to s3://${BUCKET}/${key}`);
  } else {
    console.warn('[ReportWriter] AWS_S3_BUCKET not set — skipping S3 upload (local dev)');
  }

  // Step 4: Build StoredAuditReport (no mdContent — that lives in S3)
  const report = {
    id: reportId(jobId),
    jobId: String(jobId),
    contractAddress: normalizeDeployer(contractAddress),
    deployerAddress: normalizeDeployer(deployerAddress),
    hederaAccountId: hederaAccountId ?? null,
    chain,
    contractType,
    s3Key: BUCKET ? key : '',
    contentHash,
    cid: reportMeta.cid ?? '',
    agentAddresses: reportMeta.agentAddresses ?? [],
    agentCount: reportMeta.agentCount ?? 0,
    findingCount: reportMeta.findingCount ?? 0,
    findingsBySeverity: calculateSeverityCounts(findings),
    timestamp: Date.now(),
    tags: extractTags(findings),
    source: 'orchestrator',
  };

  // Step 5: Persist metadata to PostgreSQL
  const dbId = await saveReport(report);
  console.log(`[ReportWriter] Saved to database with ID: ${dbId}`);

  return { s3Key: key, dbId };
}
```

**Helper functions (in same file):**

```javascript
function calculateSeverityCounts(findings) {
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
    for (const kw of KEYWORDS) {
      if (text.includes(kw)) tags.add(kw);
    }
  }
  return [...tags];
}

function createMarkdownReport({ jobId, contractAddress, deployerAddress, chain, contractType, findings, agents, findingCount }) {
  const sev = calculateSeverityCounts(findings);
  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${contractAddress}\`\n`;
  md += `**Chain:** ${chain}\n`;
  md += `**Deployer:** \`${deployerAddress}\`\n`;
  md += `**Contract Type:** ${contractType}\n`;
  md += `**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n`;
  md += `## Executive Summary\n\n`;
  md += `This audit identified **${findingCount} findings** across ${agents.length} automated analysis agents.\n\n`;
  md += `## Severity Breakdown\n\n`;
  md += `- Critical: ${sev.critical}\n- High: ${sev.high}\n- Medium: ${sev.medium}\n- Low: ${sev.low}\n\n`;
  md += `## Findings\n\n`;
  findings.forEach((f, i) => {
    md += `### ${f.id ?? `F-${i + 1}`}: ${f.title ?? 'Finding'}\n\n`;
    md += `**Severity:** ${String(f.severity ?? 'unknown').toUpperCase()}\n`;
    md += `**Agent:** ${f.agentId ?? 'unknown'}\n`;
    md += `**Location:** ${f.location ?? f.function ?? 'not specified'}\n\n`;
    md += `${f.description ?? f.details ?? ''}\n\n`;
    if (f.recommendation ?? f.fix) md += `**Recommendation:** ${f.recommendation ?? f.fix}\n\n`;
  });
  return md;
}
```

---

### Phase 5: Frontend Display (Task 4)

**Hook (`packages/dashboard/src/hooks/useUserReports.js`):**

```javascript
import { useState, useEffect } from 'react';
import useWalletStore from '../store/wallet';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function useUserReports() {
  const address = useWalletStore(s => s.address);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!address) { setReports([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setReports(data.success ? data.data : []);
      })
      .catch(err => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [address]);

  return { reports, loading, error };
}

export function useReportByJob(jobId) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/reports/${jobId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setReport(data.success ? data.data : null);
      })
      .catch(err => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [jobId]);

  return { report, loading, error };
}
```

> **Note:** `VITE_API_BASE_URL` must be set in Vercel project settings to `https://api.your-domain.com`.
> Leave it empty (or unset) for local dev — the Vite proxy in `vite.config.js` handles `/api` routing.

---

## Event Sequence (Timeline)

```
T+0:00   → Scanner discovers contract 0x123...
T+0:05   → ORCHESTRATOR creates job #123
T+0:10   → StaticAnalysis bids 1.0 GUARD
T+0:12   → Fuzzer bids 0.8 GUARD
T+0:15   → LLMContextual bids 1.2 GUARD
T+0:20   → ORCHESTRATOR selects winner: StaticAnalysis
T+0:25   → AuditAuction.WinnersSelected event (jobId=123)
T+0:30   → StaticAnalysis starts audit work
T+1:00   → StaticAnalysis publishes FINDINGS_SUBMITTED (HCS)
T+1:05   → LLMContextual publishes FINDINGS_SUBMITTED (HCS)
T+1:10   → REPORT AGENT aggregation window expires
T+1:15   → REPORT AGENT publishes REPORT_METADATA to HCS
           { cid: "bafy...", contentHash: "0x...", deployer: "0xabc..." }
T+1:20   → ORCHESTRATOR reads REPORT_METADATA from HCS store
T+1:25   → ORCHESTRATOR generates markdown, uploads to S3 (reports/123.md)
T+1:30   → ORCHESTRATOR saves metadata record to PostgreSQL
T+1:35   → DATABASE persisted (jobId, deployerAddress, s3Key, cid, hash)
T+1:40   → FRONTEND user refreshes, sees "1 Report Available"
```

---

## Critical Files to Create/Modify

### Task A — New Files:

1. **`packages/sdk/db/report-db.js`**
   PostgreSQL + S3 abstraction — `saveReport()`, `getReportById()`, `getReportsByDeployer()`.

2. **`orchestrator/src/report-writer.js`**
   Generates markdown, uploads to S3, saves metadata to PostgreSQL.

> `orchestrator/src/schema.sql` is already committed as a pre-branch artifact. Run once before testing.

### Task A — Modified Files:

1. **`orchestrator/src/orchestrator.js`**
   - Extract `deployerAddress` in `handleDiscovery()` (line ~786)
   - Store `deployerAddress` in `setJobByKey()` (line ~1064)
   - Call `generateAndStoreReport()` on `REPORT_METADATA` HCS message

### Task B — New Files:

2. **`packages/dashboard/server/index.js`** + **`server/api/reports.js`**
   Express server + router — `GET /api/reports`, `GET /api/reports/:jobId`, `POST /api/reports`.

3. **`packages/dashboard/server/Dockerfile`**
   Production container for ECS deployment.

### Task B — Modified Files:

4. **`packages/dashboard/vite.config.js`**
   Add `/api` proxy for local dev (target: `http://localhost:${API_PORT}`).

### Task C — New Files:

5. **`packages/dashboard/src/hooks/useUserReports.js`**
   React hook fetching reports from the Express API using `VITE_API_BASE_URL`.

6. **`packages/dashboard/src/components/reports/UserReportList.jsx`**
   Component rendering report cards from `useUserReports()`.

---

## Testing Checklist

- [ ] Orchestrator extracts `deployerAddress` from `CONTRACT_DISCOVERED` payload
- [ ] Report writer generates markdown and uploads to S3
- [ ] S3 object `reports/{jobId}.md` is created with correct content
- [ ] PostgreSQL row inserted with correct `deployer_address` and `s3_key`
- [ ] `GET /api/reports?deployer={addr}` returns correct reports (no `mdContent`)
- [ ] `GET /api/reports/:jobId` fetches `mdContent` from S3 and includes it in response
- [ ] Frontend `useUserReports` renders report cards after wallet connect
- [ ] `VITE_API_BASE_URL` routes correctly in Vercel-deployed build
- [ ] Content hash matches SHA3-256 of the uploaded markdown

---

## Error Handling

```javascript
// report-writer.js — log S3/DB failures to HCS audit log
try {
  await generateAndStoreReport(...);
} catch (error) {
  console.error(`[ReportWriter] Failed for job ${jobId}:`, error);
  await hcs.publishAuditLog({
    type: "REPORT_GENERATION_FAILED",
    agentId: "orchestrator",
    timestamp: Date.now(),
    payload: { jobId, error: error.message },
  }).catch(() => {});
}
```

---

## Security Considerations

1. **Path sanitization:** Validate `jobId` is numeric before building S3 key to prevent traversal
2. **Access control:** Verify wallet ownership before serving reports in the Express API
3. **Content integrity:** Always verify SHA3-256 hash matches when serving from S3
4. **Rate limiting:** Limit `/api/reports` queries to prevent abuse
5. **CORS:** Express sets `Access-Control-Allow-Origin` to `CORS_ORIGIN` env var only

---

## Summary

This workflow creates a **persistent, queryable audit report system** where:

1. ✅ Agents generate reports with aggregated findings and publish metadata to HCS
2. ✅ Orchestrator uploads full markdown to S3 (`reports/{jobId}.md`)
3. ✅ PostgreSQL stores metadata with deployer linkage (no large markdown blobs)
4. ✅ Express API serves `GET /api/reports?deployer={addr}` from PostgreSQL
5. ✅ Express API fetches `mdContent` from S3 on `GET /api/reports/:jobId`
6. ✅ Frontend hooks use `VITE_API_BASE_URL` so Vercel build hits the AWS API
7. ✅ Users view only reports for contracts they deployed
