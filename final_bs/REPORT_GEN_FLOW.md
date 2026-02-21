# Report Generation Flow

> **Purpose:** Document the complete workflow from winning agent selection to report storage

---

## Overview

This flow describes how autonomous agents generate, store, and link audit reports. The process begins when the orchestrator detects a job winner, triggers report generation, and persists the markdown report to the database.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 1. Listen for AuditAuction.WinnersSelected event              │  │
│  │ 2. Extract: jobId, winner addresses, contract details        │  │
│  │ 3. Check: Has 'REPORT_PUBLISHED' HCS message from report agent│  │
│  │ 4. Extract: CID, contentHash, findings from metadata         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                            │                                         │
│                            ▼                                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 5. Call generateAndStoreReport()                              │  │
│  │    - Fetch all FINDINGS_SUBMITTED messages for this job       │  │
│  │    - Aggregate findings into combined report                  │  │
│  │    - Generate markdown file (.md)                             │  │
│  │    - Save to data/reports/{jobId}.md                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        REPORT AGENT                                  │
│  (Already generates report + publishes to HCS REPORT_METADATA)      │
│                                                                      │
│  Current flow:                                                      │
│  1. Listen for FINDINGS_SUBMITTED (multiple agents)                 │
│  2. Aggregate all findings per job                                  │
│  3. Generate markdown report                                        │
│  4. Upload to IPFS                                                  │
│  5. Publish REPORT_METADATA to HCS (CID, hash, deployer)          │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATABASE                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Stores: AuditReport objects with deployer linkage            │  │
│  │   - jobId, contractAddress, deployerAddress                  │  │
│  │   - mdFilePath, contentHash, CID                             │  │
│  │   - agentAddresses, findingsBySeverity                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       FRONTEND                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Wallet connection → Query /api/reports?deployer={addr}       │  │
│  │ Display reports list → Click → Render markdown               │  │
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
```
HCS Discovery topic:
{
  type: "CONTRACT_DISCOVERED",
  agentId: "scanner-001",
  timestamp: 1740000000000,
  payload: {
    contractAddress: "0x123...",
    chain: "hedera",
    deployerAddress: "0xabc...",  // ← CRITICAL: Who deployed
    riskScore: 75,
    contractType: "lending"
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
  amounts: [100000000n, 100000000n],  // 1.0 GUARD each
  totalEscrowed: 200000000n
}
```

---

### Phase 3: Agent Report Generation

**Current Implementation (from `agents/report/index.ts`):**

```typescript
// Line 132-177: Listen for agent findings
hcs.subscribeAgentComms(async (msg: HCSMessage) => {
  if (msg.type !== "FINDINGS_SUBMITTED") return;
  
  // Accumulate findings per job
  const submission = msg as FindingsSubmittedEvent;
  jobFindings.get(jobId).submissions.push(submission);
});

// Line 171-176: Start aggregation timer after first submission
if (!job.timer) {
  job.timer = setTimeout(() => {
    aggregateAndPublish(jobId, hcs, contracts, wallet.evmAddress);
  }, AGGREGATION_WINDOW_MS);
}

// Line 182-443: Aggregate & publish
async function aggregateAndPublish(...) {
  // 1. Collect all findings from submissions
  // 2. Calculate agent accuracy scores
  // 3. Detect duplicates
  // 4. Compute final report hash
  
  // 5. Publish to HCS AuditLog
  await hcs.publishAuditLog({
    type: "REPORT_PUBLISHED",
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: { jobId, reportHash, ... }
  });
  
  // 6. Generate markdown report
  const markdownContent = formatReport(...);
  
  // 7. Upload to IPFS
  const cid = await uploadToIPFSSafe(markdownContent);
  
  // 8. Publish REPORT_METADATA to HCS
  await hcs.publishAuditLog({
    type: "REPORT_METADATA",
    payload: {
      jobId,
      cid,                    // IPFS content identifier
      contentHash,            // SHA3-256 of markdown
      deployer,               // ← Contract deployer wallet
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
- ❌ **Does NOT save to database** (only in-memory Zustand store)
- ❌ **Does NOT write to local .md file**

---

### Phase 4: Database Persistence (NEW)

**New Code to Implement:**

```typescript
// orchestrator/src/report-writer.ts (NEW FILE)
import fs from 'fs';
import path from 'path';
import { AuditReport } from '../shared/types.js';
import { saveReport, getReportById } from '../db/report-db.js';

/**
 * Orchestrator-triggered report generation and storage
 * Called after winner selection + REPORT_METADATA availability
 */
export async function generateAndStoreReport(
  jobId: string,
  contractAddress: string,
  deployerAddress: string,
  hederaAccountId: string | null,
  chain: string,
  contractType: string
): Promise<{ mdFilePath: string; dbId: string }> {
  console.log(`[ReportWriter] Generating report for job ${jobId}...`);
  
  // Step 1: Fetch all findings from HCS REPORT_METADATA
  const reportMetadata = useStore.getState().reportMetadata[jobId];
  if (!reportMetadata) {
    throw new Error(`No REPORT_METADATA found for job ${jobId}`);
  }
  
  // Step 2: Retrieve findings from HCS (or cached store)
  const findings = await fetchFindingsForJob(jobId);
  
  // Step 3: Generate markdown content
  const markdownContent = createMarkdownReport({
    jobId,
    contractAddress,
    deployerAddress,
    chain,
    contractType,
    findings,
    agents: reportMetadata.agents || [],
    findingCount: reportMetadata.findingCount || 0
  });
  
  // Step 4: Save markdown file locally
  const reportsDir = path.join(process.cwd(), 'data', 'reports');
  const mdFileName = `${jobId}.md`;
  const mdFilePath = path.join(reportsDir, mdFileName);
  
  // Ensure directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  // Write file
  fs.writeFileSync(mdFilePath, markdownContent, 'utf8');
  console.log(`[ReportWriter] Saved markdown to ${mdFilePath}`);
  
  // Step 5: Build database record
  const contentHash = calculateSHA3256(markdownContent);
  
  const report: AuditReport = {
    id: `report:${jobId}`,
    jobId,
    contractAddress,
    deployerAddress,
    hederaAccountId,
    chain,
    contractType,
    mdContent: markdownContent,
    contentHash,
    cid: reportMetadata.cid,
    mdFilePath,
    agentAddresses: reportMetadata.agents || [],
    agentCount: reportMetadata.agentCount || 0,
    findingCount: reportMetadata.findingCount || 0,
    findingsBySeverity: calculateSeverityCounts(findings),
    timestamp: Date.now(),
    jobIdCreated: 0,  // Will be populated by scheduler
    jobIdCompleted: Date.now(),
    tags: extractTags(findings),
    source: 'orchestrator'
  };
  
  // Step 6: Save to database
  const dbId = await saveReport(report);
  console.log(`[ReportWriter] Saved to database with ID: ${dbId}`);
  
  // Step 7: Update Zustand for immediate frontend availability
  useStore.getState().addReportMetadata(jobId, {
    cid: reportMetadata.cid,
    listingId: reportMetadata.listingId,
    contentHash: reportMetadata.contentHash,
    deployer: reportMetadata.deployer,
    agentCount: reportMetadata.agentCount,
    findingCount: reportMetadata.findingCount
  });
  
  return { mdFilePath, dbId };
}

// Helper functions

function fetchFindingsForJob(jobId: string): Promise<any[]> {
  // Query HCS AuditLog for FINDINGS_SUBMITTED messages with this jobId
  const auditLog = useStore.getState().auditLog;
  return auditLog
    .filter(msg => msg.type === 'FINDINGS_SUBMITTED' && msg.payload?.jobId === jobId)
    .flatMap(msg => msg.payload?.findings || []);
}

function createMarkdownReport(options: {
  jobId: string;
  contractAddress: string;
  deployerAddress: string;
  chain: string;
  contractType: string;
  findings: any[];
  agents: string[];
  findingCount: number;
}): string {
  const { jobId, contractAddress, deployerAddress, chain, contractType, findings, agents, findingCount } = options;
  
  const severityCounts = calculateSeverityCounts(findings);
  
  let md = `# Audit Report — Job #${jobId}\n\n`;
  md += `**Contract:** \`${contractAddress}\`\n`;
  md += `**Chain:** ${chain}\n`;
  md += `**Deployer:** \`${deployerAddress}\`\n`;
  md += `**Contract Type:** ${contractType}\n`;
  md += `**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n`;
  
  md += `## Executive Summary\n\n`;
  md += `This audit identified **${findingCount} findings** across ${agents.length} automated analysis agents.\n\n`;
  
  md += `## Severity Breakdown\n\n`;
  md += `- **Critical:** ${severityCounts.critical}\n`;
  md += `- **High:** ${severityCounts.high}\n`;
  md += `- **Medium:** ${severityCounts.medium}\n`;
  md += `- **Low:** ${severityCounts.low}\n\n`;
  
  md += `### Participating Agents\n\n`;
  agents.forEach((addr, i) => {
    md += `${i + 1}. Agent: \`${addr}\`\n`;
  });
  md += '\n';
  
  md += `## Findings\n\n`;
  findings.forEach((finding, i) => {
    md += `### ${finding.id || `F-${i + 1}`} ${finding.title || 'Untitled Finding'}\n\n`;
    md += `**Severity:** ${severityBadge(finding.severity)}\n`;
    md += `**Agent:** ${finding.agentId || 'Unknown'}\n`;
    md += `**Location:** ${finding.location || finding.function || 'Not specified'}\n\n`;
    md += `**Description:**\n${finding.description || finding.details || 'No description'}\n\n`;
    
    if (finding.recommendation || finding.fix) {
      md += `**Recommendation:**\n${finding.recommendation || finding.fix}\n\n`;
    }
  });
  
  return md;
}

function calculateSeverityCounts(findings: any[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  findings.forEach(f => {
    const sev = String(f?.severity || f?.level || 'medium').toLowerCase();
    if (sev in counts) counts[sev]++;
  });
  return counts;
}

function severityBadge(severity: string): string {
  const sev = String(severity).toUpperCase();
  switch (sev) {
    case 'CRITICAL': return '❗ Critical';
    case 'HIGH': return '⚠️ High';
    case 'MEDIUM': return 'ℹ️ Medium';
    case 'LOW': return '✅ Low';
    case 'INFO': return 'ℹ️ Info';
    default: return '❓ Unknown';
  }
}

function calculateSHA3256(content: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha3-256').update(content).digest('hex');
}

function extractTags(findings: any[]): string[] {
  const tags = new Set<string>();
  findings.forEach(f => {
    // Extract tags from description keywords
    const keywords = ['reentrancy', 'overflow', 'underflow', 'access control', 'oracle'];
    keywords.forEach(k => {
      if (f.description?.toLowerCase().includes(k)) tags.add(k);
    });
  });
  return Array.from(tags);
}
```

---

### Phase 5: Frontend Display

**Updated Hook:**

```typescript
// packages/dashboard/src/hooks/useUserReports.js (NEW FILE)
import { useAsyncMemo } from 'use-async-memo';
import useWalletStore from '../store/wallet';

export function useUserReports() {
  const address = useWalletStore(s => s.address);
  
  const { value: reports, error, loading } = useAsyncMemo(async () => {
    if (!address) return [];
    
    try {
      // Query database for reports where deployer = address
      const res = await fetch(`/api/reports?deployer=${encodeURIComponent(address)}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      
      const data = await res.json();
      return data.success ? data.data : [];
    } catch (err) {
      console.error('[useUserReports] Failed to fetch:', err);
      return [];
    }
  }, [address]);
  
  return {
    reports: reports || [],
    loading,
    error
  };
}

export function useReportByJob(jobId: string) {
  const { value: report, error, loading } = useAsyncMemo(async () => {
    try {
      const res = await fetch(`/api/reports/${jobId}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      
      const data = await res.json();
      return data.success ? data.data : null;
    } catch (err) {
      console.error(`[useReportByJob] ${jobId}:`, err);
      return null;
    }
  }, [jobId]);
  
  return { report, loading, error };
}
```

**Component Usage:**

```typescript
// packages/dashboard/src/components/reports/UserReportList.jsx (NEW FILE)
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import useUserReports from '../../hooks/useUserReports';
import { fmt } from '../../utils/format';
import useWalletStore from '../../store/wallet';

export default function UserReportList() {
  const { reports, loading, error } = useUserReports();
  const address = useWalletStore(s => s.address);
  
  if (loading) {
    return <div>Loading your audit reports...</div>;
  }
  
  if (error) {
    return <div className="text-red-400">Error loading reports: {String(error)}</div>;
  }
  
  if (!address) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-400">Connect your wallet to view audit reports.</p>
      </div>
    );
  }
  
  if (reports.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-400">
          No audit reports found for wallet <code className="text-cyan-400">{fmt.shortenAddress(address)}</code>.
        </p>
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-gray-100">
        Audit Reports for {fmt.shortenAddress(address)}
      </h2>
      
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {reports.map(report => (
          <ReportCard key={report.id} report={report} />
        ))}
      </div>
    </div>
  );
}

function ReportCard({ report }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-cyan-500/50 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-200">
            Job #{report.jobId}
          </h3>
          <p className="text-[10px] font-mono text-gray-500 mt-1">
            {fmt.shortenAddress(report.contractAddress)}
          </p>
        </div>
        <span className={`text-[10px] font-bold px-2 py-1 rounded ${
          report.chain === 'hedera' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
        }`}>
          {report.chain.toUpperCase()}
        </span>
      </div>
      
      <div className="flex items-center gap-2 mb-3">
        {Object.entries(report.findingsBySeverity).map(([sev, count]) => (
          count > 0 && (
            <span key={sev} className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              severityStyle(sev)
            }`}>
              {sev.toUpperCase()}: {count}
            </span>
          )
        ))}
      </div>
      
      <div className="text-xs text-gray-500 mb-3">
        {report.findingCount} findings from {report.agentCount} agents
      </div>
      
      <Link
        to={`/reports/${report.jobId}`}
        className="block w-full text-center bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 px-4 rounded-lg transition-colors"
      >
        View Report →
      </Link>
    </div>
  );
}

function severityStyle(severity: string) {
  const styles: Record<string, string> = {
    critical: 'bg-red-900/30 text-red-400 border border-red-500/30',
    high: 'bg-orange-900/30 text-orange-400 border border-orange-500/30',
    medium: 'bg-amber-900/30 text-amber-300 border border-amber-500/30',
    low: 'bg-blue-900/30 text-blue-400 border border-blue-500/30'
  };
  return styles[severity] || 'bg-gray-800 text-gray-400';
}
```

---

## Event Sequence (Timeline)

```
T+0:00   → Scanner discovers contract 0x123...
T+0:05   → ORCHESTRATOR creates job #123
T+0:10   → StaticAnalysis bids 1.0 GUARD
T+0:12   → Fuzzer bids 0.8 GUARD
T+0:15   → LLMContextual bids 1.2 GUARD
T+0:20   → ORCHESTRATOR selects winner: StaticAnalysis
T+0:25   → AuditAuction.WinnersSelected event (jobId=123, winners=[StaticAnalysis])
T+0:30   →_STATIC ANALYSIS→ starts audit work
T+1:00   → STATIC ANALYSIS→ publishes FINDINGS_SUBMITTED (HCS)
T+1:05   → LLMLContextual→ publishes FINDINGS_SUBMITTED (HCS)
T+1:10   → REPORT AGENT→ aggregation window expired
T+1:15   → REPORT AGENT→ publishes REPORT_METADATA to HCS
         { cid: "bafy...", contentHash: "0x...", deployer: "0xabc..." }
T+1:20   →/ORCHESTRATOR→ reads REPORT_METADATA
T+1:25   →/ORCHESTRATOR→ generates markdown, saves to data/reports/123.md
T+1:30   →/ORCHESTRATOR→ saves report to database
T+1:35   → DATABASE→ persisted (jobId, deployerAddress, CID, hash)
T+1:40   → FRONTEND→ user refreshes, sees "1 Report Available"
```

---

## Critical Files to Create/Modify

### **New Files:**

1. **`orchestrator/src/report-writer.ts`**  
   Main orchestrator module for generating and storing reports

2. **`packages/sdk/db/report-db.ts`**  
   Database abstraction with CRUD operations

3. **`packages/dashboard/src/hooks/useUserReports.js`**  
   React hook for fetching user's report list

4. **`packages/dashboard/src/components/reports/UserReportList.jsx`**  
   React component displaying user reports

5. **`packages/sdk/db/init.ts`**  
   Database initialization & schema setup

### **Modified Files:**

1. **`agents/report/index.ts`**  
   - Add save to database after IPFS upload ( OPTIONAL - already publishes to HCS )

2. **`orchestrator/src/orchestrator.js`**  
   - Listen for `WinnersSelected` event
   - Call `generateAndStoreReport()` on winner selection

3. **`packages/dashboard/src/components/reports/ReportList.jsx`**  
   - Replace mock data with `useUserReports()` hook

4. **`packages/sdk/package.json`**  
   - Add Express endpoints if API server enabled

---

## Testing Checklist

- [ ] Orchestrator detects `WinnersSelected` event
- [ ] Report writer reads all `FINDINGS_SUBMITTED` messages
- [ ] Markdown file created at `data/reports/{jobId}.md`
- [ ] Report saved to database with correct deployer linkage
- [ ] Frontend queries `/api/reports?deployer={address}`
- [ ] Only deployer can view their reports
- [ ] CID matches IPFS uploaded content
- [ ] Content hash validates markdown integrity

---

## Error Handling

```typescript
// Report writer error cases

try {
  // ...
} catch (error) {
  console.error(`[ReportWriter] Failed for job ${jobId}:`, error);
  
  // Log to HCS audit log
  await hcs.publishAuditLog({
    type: "REPORT_GENERATION_FAILED",
    agentId: "orchestrator",
    timestamp: Date.now(),
    payload: {
      jobId,
      error: error.message,
      retryCount: (retryCounts[jobId] || 0) + 1
    }
  });
  
  // Increment retry counter
  if (!retryCounts[jobId]) retryCounts[jobId] = 0;
  retryCounts[jobId]++;
  
  // Retry after delay if < 3 attempts
  if (retryCounts[jobId] < 3) {
    setTimeout(() => {
      generateAndStoreReport(jobId, ...);
    }, 5000);
  }
}
```

---

## Performance Optimizations

1. **Batch database writes** for multiple jobs
2. **Cache recent reports** in memory for frontend
3. **Lazy-load markdown content** (return file path, fetch on click)
4. **Compress markdown** in database (gzip)
5. **Incremental updates** (only regenerate on content change)

---

## Security Considerations

1. **Path sanitization:** Validate job IDs to prevent `../../` attacks
2. **Access control:** Verify wallet ownership before serving reports
3. **Content integrity:** Always verify SHA3-256 hash matches
4. **Rate limiting:** Limit `/api/reports` queries to prevent abuse
5. **File permissions:** Restrict `data/` directory access

---

## Monitoring

```typescript
export const reportStats = {
  generated: 0,
  stored: 0,
  ipfsUploads: 0,
  databaseWrites: 0,
  errors: 0,
  averageGenerationTimeMs: 0
};

// Instrument every step
console.time(`report-${jobId}`);
// ...
console.timeEnd(`report-${jobId}`);
reportStats.averageGenerationTimeMs = calculateAverage(...);
```

---

## Summary

This workflow creates a **persistent, queryable audit report system** where:

1. ✅ Agents generate reports with aggregated findings
2. ✅ Reports uploaded to IPFS for decentralized storage
3. ✅ Report metadata stored in HCS `REPORT_METADATA` messages
4. ✅ **NEW:** Full report saved to database with deployer linkage
5. ✅ **NEW:** Frontend queries database by wallet address
6. ✅ Users view only reports for contracts they deployed

**Benefits:**

- Reports persist across app restarts
- Fast querying by wallet address
- Decentralized Content ID verification
- Access control via wallet ownership
- Markdown rendering for readability
