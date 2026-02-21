# AuditGuard - Final Implementation Guide

> **Version:** v1.0  
> **Date:** 2026-02-20  
> **Purpose:** Complete roadmap for database, report generation, and wallet integration

---

packages/sdk/db/report-types.js                                                                                                                        
                                                                                                                        
  The shared contract file. Contains:                                                                                                                    
  - Path constants — REPORTS_DB_FILE, REPORTS_DIR, REPO_ROOT — every task imports these instead of hardcoding paths                                    
  - Pure helpers — reportId(), normalizeDeployer(), deployerMatches() — no side effects, safe to import in any context                                   
  - StoredAuditReport JSDoc typedef — the frozen schema all tasks depend on                                                                              
  - EMPTY_FINDINGS constant — default FindingsBySeverity object                                                                                          
  - API envelope spec — the exact { success, data, count } shape Task 3 must produce and Task 4 must consume                                             
  - Gap comments — precise line numbers in the codebase where each task owner needs to make changes (including the critical deployerAddress fix in       
  orchestrator.js)                                                                                                                                       
                                                                                                                                                         
  data/reports.json + data/reports/.gitkeep

  Empty database file and directory scaffold so the repo has the structure before any branch needs it.

  ---
  All four branches can now open. Each branch imports from @sdk/db/report-types.js (or ../../packages/sdk/db/report-types.js) and the schema is locked.
  The gap comments tell each owner exactly where to look in the existing code.


## 📂 Directory Structure

```
final_bs/
├── README.md (this file)
├── DATABASE_SCHEMA.md          ← Database design & API specs
├── REPORT_GEN_FLOW.md          ← Agent-to-report pipeline
└── WALLET_REPORT_ACCESS.md     ← Frontend wallet integration
```

---

## 🎯 What This Guide Covers

1. **Persistent report database** (PostgreSQL via `DATABASE_URL`, markdown in AWS S3)
2. **Report generation workflow** (Orchestrator triggers → markdown files → database)
3. **Wallet address filtering** (Users see only reports for their deployed contracts)

---

## ✅ Quick Start

> **Read `tasks.md` first** — it has the canonical breakdown, full code samples, stubs, and merge order.

### Task A — DB Module + Report Writer (`task/report-backend`)
- [ ] `psql "$DATABASE_URL" -f orchestrator/src/schema.sql` — run migration
- [ ] Create `packages/sdk/db/report-db.js` (PostgreSQL + S3 — full code in `tasks.md`)
- [ ] Create `orchestrator/src/report-writer.js` (markdown + upload + save)
- [ ] Fix `deployerAddress` gap in `orchestrator.js` (2 edits — see `tasks.md`)
- [ ] Test: `saveReport()`, `getReportsByDeployer()`, `WinnersSelected` trigger

### Task B — Express API Server (`task/report-api`)
- [ ] Create `packages/dashboard/server/index.js` + `server/api/reports.js`
- [ ] Create `packages/dashboard/server/Dockerfile`
- [ ] Add `/api` Vite proxy in `vite.config.js` (local dev only)
- [ ] Test: `curl localhost:3002/api/reports?deployer=0x...`

### Task C — Frontend Hook + UI (`task/report-ui`)
- [ ] Create `packages/dashboard/src/hooks/useUserReports.js`
- [ ] Create `packages/dashboard/src/components/reports/UserReportList.jsx`
- [ ] Add "My Reports" section to `ReportMarketplace.jsx`
- [ ] Test: Wallet connect → reports list renders

### Merge order: A → B → C (B and C may merge in either order)

---

## 📖 Detailed Documentation

### 1. DATABASE_SCHEMA.md

**What it tells you:**
- AuditReport JSON schema
- Database storage options (JSON/LevelDB/PostgreSQL)
- API endpoints (`GET /api/reports?deployer={address}`)
- Report file structure
- Access control rules
- Security considerations

**Key Interfaces:**
```typescript
interface StoredAuditReport {
  id: string;
  jobId: string;
  contractAddress: string;
  deployerAddress: string;  // ← CRITICAL: who deployed, stored lowercase
  hederaAccountId: string | null;
  chain: string;
  contractType: string;
  s3Key: string;            // "reports/{jobId}.md" — mdContent lives in S3
  contentHash: string;
  cid: string;
  agentAddresses: string[];
  agentCount: number;
  findingCount: number;
  findingsBySeverity: { critical: number; high: number; medium: number; low: number; info: number; };
  timestamp: number;
  tags: string[];
  source: 'orchestrator' | 'agent' | 'manual';
}
```

---

### 2. REPORT_GEN_FLOW.md

**What it tells you:**
- Complete event stream from winner selection to report storage
- Orchestrator role in generating reports
- HTML/MarkdoWN generation code
- Frontend query hooks
- Error handling patterns

**Critical Files to Create:**

```javascript
// orchestrator/src/report-writer.js
export async function generateAndStoreReport({
  jobId, contractAddress, deployerAddress,
  hederaAccountId, chain, contractType,
  reportMeta, findings,
}): Promise<{ s3Key: string; dbId: string }>
```

**Event Timeline:**
```
WinnersSelected event (orchestrator)
  → Fetch all FINDINGS_SUBMITTED messages (agents)
  → Aggregate findings (report-aggregator)
  → Generate markdown (formatReport)
  → Save to data/reports/{jobId}.md
  → Call saveReport() → database
  → Frontend queries /api/reports?deployer={wallet}
```

---

### 3. WALLET_REPORT_ACCESS.md

**What it tells you:**
- React hooks for querying user reports
- Express API endpoints
- Component structure (UserReportList.jsx)
- Access control logic
- Security best practices

**Key Hook:**
```javascript
// packages/dashboard/src/hooks/useUserReports.js
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function useUserReports() {
  const { address, isConnected } = useWalletStore(s => ({
    address: s.address, isConnected: s.connectionStatus === 'connected',
  }));
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isConnected || !address) { setReports([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/api/reports?deployer=${encodeURIComponent(address)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setReports(d.success ? d.data : []); })
      .catch(e => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, isConnected]);

  return { reports, loading, error };
}
```

**Access Control:**
```javascript
function canViewReport(report, userAddress) {
  return report.deployerAddress.toLowerCase() === userAddress.toLowerCase();
}
```

---

## 🔑 Core Concepts

### 1. Deployer Linkage

Every report is linked to the wallet address that **deployed** the smart contract:

```javascript
// Report metadata includes:
{
  jobId: "123",
  contractAddress: "0x123...",
  deployerAddress: "0xabc...",  // ← Who deployed, not who paid
  cid: "bafy...",
  contentHash: "0x..."
}
```

### 2. Dual Address Support

System supports both:
- **EVM addresses:** `0x1234567890abcdef...`
- **Hedera Account IDs:** `0.0.7951944`

Database stores `deployerAddress` (EVM) and optional `hederaAccountId`.

### 3. Access Control

Users can **ONLY** see reports where:
```javascript
report.deployerAddress.toLowerCase() === userWalletAddress.toLowerCase()
```

---

## 🛠️ Implementation Order

### Week 1: Database MVP
1. Create `data/reports.json` structure
2. Implement CRUD operations (read/write)
3. Test with sample report data
4. Run: `node scripts/test-db.js`

### Week 2: Orchestration
1. Parse `AuditAuction.WinnersSelected` events
2. Trigger report generation
3. Save .md files to disk
4. Call `saveReport()` database function
5. Run: `node scripts/test-report-gen.js`

### Week 3: Frontend
1. Build `/api/reports` Express server
2. Create `useUserReports` hook
3. Implement `UserReportList` component
4. Build ReportViewer page
5. Run: `npm run dev` → test dashboard

### Week 4: Polishing
1. Add Hedera address support
2. Implement Claude agent integration
3. Add rate limiting/security
4. Error handling & logging
5. Final end-to-end test

---

## 💡 Design Decisions

### Why JSON File MVP?
- ✅ Zero dependencies
- ✅ Easy to inspect/debug
- ✅ Works without external service
- ❌ Limited scalability
- ❌ No concurrency

### Why NOT LevelDB from Start?
- ✅ More complex (native bindings)
- ✅ Requires platform-specific builds
- ❌ Overkill for MVP

### Why NOT PostgreSQL/MongoDB?
- ✅ External service dependency
- ✅ Deployment complexity
- ❌ Too heavy for MVP

**Strategy:** Start with JSON, migrate to LevelDB when:
- More than 10,000 reports
- Concurrent write conflicts
- Need advanced querying

---

## 🐛 Common Pitfalls

### 1. Address Case Sensitivity
```javascript
// WRONG: Direct string comparison
if (report.deployerAddress === userAddress) { ... }

// CORRECT: Normalize to lowercase
if (report.deployerAddress.toLowerCase() === userAddress.toLowerCase()) { ... }
```

### 2. Path Traversal Attacks
```javascript
// WRONG: Direct file path
const filePath = `data/reports/${jobId}.md`;

// CORRECT: Sanitize input
if (jobId.includes('..') || jobId.includes('/')) {
  throw new Error('Invalid job ID');
}
const filePath = path.resolve('data', 'reports', `${jobId}.md`);
```

### 3. Missing Content Hash Verification
```javascript
// WRONG: Trust fetched content
const mdContent = await fetchIPFS(cid);

// CORRECT: Verify hash after fetch
const contentHash = sha3_256(mdContent);
if (contentHash !== report.contentHash) {
  throw new Error('Hash mismatch - content corrupted');
}
```

### 4. Race Conditions in File Writes
```javascript
// WRONG: Multiple writes without locking
fs.writeFileSync(file, JSON.stringify(reports));

// CORRECT: Use atomic writes or locking
const lock = await acquireLock();
try {
  // ... write operations ...
} finally {
  releaseLock(lock);
}
```

---

## 📊 Performance Expectations

| Operation | Expected Latency | Notes |
|-----------|-----------------|-------|
| `GET /api/reports?deployer={addr}` | < 100ms | JSON file < 1MB |
| Report generation | 2-5s | Depends on finding count |
| IPFS fetch | 1-3s | Cached on average |
| DB save | < 50ms | Synchronous write |
| Frontend load | < 500ms | Client-side filtering |

**Scaling Limits (JSON file):**
- Reports: 10,000 (before migration needed)
- Report size: 50KB avg (markdown)
- Total DB size: ~500MB max

---

## 🔒 Security Checklist

- [ ] All addresses normalized (lowercase)
- [ ] Job IDs sanitized (no `../`)
- [ ] Content hashes verified before render
- [ ] Auth checks on all `/api/reports` endpoints
- [ ] Rate limiting on Express API
- [ ] File paths use `path.resolve()` (no relative paths)
- [ ] Error messages don't leak stack traces to clients
- [ ] Database file permissions restrictive (`chmod 600`)

---

## 🚀 Deployment Checklist

### Local Development
```bash
# 1. Initialize database structure
mkdir -p data/reports
touch data/reports.json
echo '[]' > data/reports.json

# 2. Start backend
npm run dev  # or node packages/dashboard/server/index.js

# 3. Start agents
npm run agents

# 4. Trigger test audit cycle
```

### Production (PostgreSQL Example)
```bash
# 1. Setup database
psql -U auditguard -c "CREATE DATABASE auditguard;"
psql -U auditguard -d auditguard -f packages/sdk/db/schema.sql

# 2. Configure connection
export DATABASE_URL="postgresql://auditguard:password@localhost:5432/auditguard"

# 3. Deploy Express server
pm2 start packages/dashboard/server/index.js --name auditguard-api

# 4. Monitor
pm2 logs auditguard-api
```

---

## 📞 Support & Questions

### Current Gaps (See Original Analysis)
1. ❓ Which agent writes report? (Assuming `report-aggregator-001`)
2. ❓ When exactly is report generated? (After `REPORT_PUBLISHED` HCS event)
3. ❓ Hedera account ID extraction from wallet? (Requires MetaMask Snap)

### Next Steps
1. ✅ Choose storage backend (JSON recommended)
2. ✅ Implement database CRUD functions
3. ✅ Create orchestrator report trigger
4. ✅ Build frontend query hooks

---

## 🎓 Learning Resources

### Relevant Files to Study
1. `agents/report/index.ts` (Lines 370-443) - Current report generation
2. `packages/dashboard/src/store/wallet.js` (Lines 80-182) - Wallet state
3. `packages/sdk/abis/DataMarketplace.json` - Existing data model
4. `packages/dashboard/src/store/index.js` (Lines 170-174) - Report metadata

### API Specifications
- **IPFS:** `/api/v0/add` endpoint
- **0g DA:** Storage layer with `rootHash`
- **Hedera Mirror Node:** `/api/v1/topics/{topic}/messages`

---

## 🏆 Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Report persistence | 100% survive restarts | Database write verification |
| Query latency | < 500ms | Frontend timing measurements |
| Access control success | 95% (5% false negatives) | User testing |
| Report generation success | 90% first attempt | Agent logs |
| Frontend UX rating | > 4.5/5 | User feedback |

---

## 📝 Changelog

**v1.0 (2026-02-20)**
- Initial implementation guide
- Database schema documented
- Report generation flow defined
- Wallet integration specs complete

---

## 📄 License

Same as AuditGuard project (Apache 2.0)

---

**End of Guide**

For questions, refer to the original Discord discussion or the three detailed markdown files in this directory.
