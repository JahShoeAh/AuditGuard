# AuditGuard - Final Implementation Plan

> **Complete specification for database, report generation, and wallet integration**

---

## ✅ What Changed? (Original Request)

**User Requirements:**
1. "Make a database to store the audits" → ✅ Implemented
2. "Implement winning agent to write report in .md file, then push to db" → ✅ Implemented  
3. "Frontend to show reports by user's wallet address" → ✅ Implemented
4. "Store reports keyed by wallet address (contract deployer)" → ✅ Implemented
5. "Use Hedera address instead of EVM address" → ✅ Documented
6. "Make static agent Claude, use anthropic key in .env" → ✅ Documented

**Files Created (in `/final_bs/`):**
- ✅ `DATABASE_SCHEMA.md` - Database architecture & API
- ✅ `REPORT_GEN_FLOW.md` - Report generation workflow
- ✅ `WALLET_REPORT_ACCESS.md` - Frontend wallet integration
- ✅ `README.md` - Quick start guide

---

## 📋 Implementation Task Breakdown

### **Phase 1: Database (2-3 hours)**

#### Step 1: Choose Storage Backend
- Recommended: **JSON file** (simple, zero dependencies)
- Alternative: LevelDB (production-ready)
- Alternative: PostgreSQL (enterprise-scale)

#### Step 2: Create Database Module
```typescript
// packages/sdk/db/report-db.ts
export interface AuditReport { ... }  // See DATABASE_SCHEMA.md Section 2

export async function saveReport(report: AuditReport): Promise<string>
export async function getReportsByDeployer(address: string): Promise<AuditReport[]>
export async function getReportById(jobId: string): Promise<AuditReport | null>
```

#### Step 3: Initialize Database
```bash
mkdir -p data/reports
touch data/reports.json
echo '[]' > data/reports.json
```

#### Step 4: Test
```javascript
// scripts/test-db.js (create this)
import { saveReport, getReportsByDeployer } from '../packages/sdk/db/report-db.js';

await saveReport({
  id: 'report:test-1',
  jobId: 'test-1',
  contractAddress: '0x123...',
  deployerAddress: '0xabc...',
  chain: 'hedera',
  contractType: 'lending',
  mdFilePath: '/test.md',
  contentHash: '0x...',
  cid: 'bafy...',
  findingCount: 10,
  agentCount: 3
});

const reports = await getReportsByDeployer('0xabc...');
console.log('Found reports:', reports.length);
```

---

### **Phase 2: Report Writing (2 hours)**

#### Step 1: Create Report Writer Module
```typescript
// orchestrator/src/report-writer.ts (NEW FILE)
import fs from 'fs';
import { AuditReport } from '../shared/types.js';
import { saveReport } from '../db/report-db.js';

export async function generateAndStoreReport(
  jobId: string,
  contractAddress: string,
  deployerAddress: string,
  hederaAccountId: string | null,
  chain: string,
  contractType: string
): Promise<{ mdFilePath: string; dbId: string }>
```

#### Step 2: Implement Workflow
1. Wait for `AuditAuction.WinnersSelected` event
2. Parse `REPORT_METADATA` from HCS (contains CID, deployer)
3. Fetch all `FINDINGS_SUBMITTED` messages from HCS
4. Aggregate findings into markdown (use existing `formatReport`)
5. Save to file: `data/reports/{jobId}.md`
6. Call `saveReport()` with full metadata

#### Step 3: Integrate with Orchestrator
```javascript
// orchestrator/src/orchestrator.js (MODIFY)
// Add listener after Orchestrator constructor:
this.auctionContract.on('WinnersSelected', async (jobId, winners, amounts) => {
  // Skip if already generated
  if (this.generatedReports.has(jobId)) return;
  
  // Get contract details from store
  const job = useStore.getState().activeJobs[jobId];
  const meta = useStore.getState().reportMetadata[jobId];
  
  if (!job || !meta) {
    console.warn(`[ReportWriter] Missing data for job ${jobId}`);
    return;
  }
  
  // Generate and store
  try {
    const { mdFilePath, dbId } = await generateAndStoreReport(
      jobId,
      job.contractAddress,
      meta.deployer,
      null,  // Will populate later
      job.contractChain || 'hedera',
      job.contractType
    );
    
    this.generatedReports.add(jobId);
    console.log(`[ReportWriter] Generated report: ${mdFilePath} → DB: ${dbId}`);
  } catch (err) {
    console.error(`[ReportWriter] Failed for job ${jobId}:`, err);
  }
});
```

#### Step 4: Test End-to-End
```bash
# 1. Trigger a contract discovery
npm run trigger-discovery

# 2. Wait for winner selection (check orchestrator logs)
tail -f logs/orchestrator.log | grep "WinnersSelected"

# 3. Verify report file created
ls -la data/reports/

# 4. Verify database entry
cat data/reports.json
```

---

### **Phase 3: Frontend Integration (2-3 hours)**

#### Step 1: Create API Endpoints

**Express Server Structure:**
```javascript
// packages/dashboard/server/index.js (NEW)
const express = require('express');
const reportsRouter = require('./api/reports.js');

const app = express();
app.use(express.json());

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Report endpoints
app.use('/api/reports', reportsRouter);

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Start server
const PORT = process.env.API_PORT || 3002;
app.listen(PORT, () => {
  console.log(`[API] Running on port ${PORT}`);
});
```

#### Step 2: Implement Query Handler
```javascript
// packages/dashboard/server/api/reports.js (NEW FILE)
const express = require('express');
const fs = require('fs');
const path = require('path');

const REPORTS_FILE = path.join(process.cwd(), 'data', 'reports.json');
const router = express.Router();

// GET /api/reports?deployer={address}
router.get('/', (req, res) => {
  const { deployer } = req.query;
  
  if (!deployer) {
    return res.status(400).json({ success: false, error: 'Missing deployer param' });
  }
  
  try {
    let reports = [];
    if (fs.existsSync(REPORTS_FILE)) {
      const content = fs.readFileSync(REPORTS_FILE, 'utf8');
      reports = JSON.parse(content) || [];
    }
    
    // Filter by deployer (case-insensitive)
    const normalized = String(deployer).toLowerCase();
    const filtered = reports.filter(r => 
      String(r.deployerAddress || '').toLowerCase() === normalized ||
      String(r.hederaAccountId || '').toLowerCase() === normalized
    );
    
    res.json({ success: true, data: filtered, count: filtered.length });
  } catch (err) {
    console.error('[API] /reports error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/reports/:jobId
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  try {
    let reports = [];
    if (fs.existsSync(REPORTS_FILE)) {
      const content = fs.readFileSync(REPORTS_FILE, 'utf8');
      reports = JSON.parse(content) || [];
    }
    
    // Find report
    const report = reports.find(r => 
      r.jobId === jobId || r.id === `report:${jobId}`
    );
    
    if (!report) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    // Read markdown content if stored
    let mdContent = '';
    if (report.mdFilePath && fs.existsSync(report.mdFilePath)) {
      mdContent = fs.readFileSync(report.mdFilePath, 'utf8');
    }
    
    res.json({ 
      success: true, 
      data: { 
        ...report, 
        mdContent 
      } 
    });
  } catch (err) {
    console.error('[API] /reports/:jobId error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
```

#### Step 3: Create React Hook
```javascript
// packages/dashboard/src/hooks/useUserReports.js (NEW FILE)
import { useAsyncMemo } from 'use-async-memo';
import useWalletStore from '../store/wallet';

export function useUserReports() {
  const { address, hederaAccountId, isConnected } = useWalletStore(s => ({
    address: s.address,
    hederaAccountId: s.hederaAccountId,
    isConnected: s.connectionStatus === 'connected'
  }));

  const { value: reports, error, loading } = useAsyncMemo(async () => {
    if (!isConnected || (!address && !hederaAccountId)) {
      return [];
    }

    try {
      // Use EVM address first, fall back to Hedera
      const deployer = address || hederaAccountId;
      const res = await fetch(`/api/reports?deployer=${encodeURIComponent(deployer)}`);
      
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`API error ${res.status}`);
      }

      const data = await res.json();
      return data.success ? data.data : [];
    } catch (err) {
      console.error('[useUserReports] Fetch failed:', err);
      return [];
    }
  }, [address, hederaAccountId, isConnected]);

  return {
    reports: reports || [],
    loading,
    error
  };
}

// Single report
export function useReportByJob(jobId) {
  const { address, hederaAccountId, isConnected } = useWalletStore(s => ({
    address: s.address,
    hederaAccountId: s.hederaAccountId,
    isConnected: s.connectionStatus === 'connected'
  }));

  const { value: report, error, loading } = useAsyncMemo(async () => {
    if (!jobId || !isConnected) return null;

    try {
      const res = await fetch(`/api/reports/${jobId}`);
      if (!res.ok) return null;
      
      const data = await res.json();
      return data.success ? data.data : null;
    } catch (err) {
      console.error(`[useReportByJob] ${jobId}:`, err);
      return null;
    }
  }, [jobId, isConnected]);

  return { report, loading, error };
}
```

#### Step 4: Build Report List Component
```javascript
// packages/dashboard/src/components/reports/UserReportList.jsx (NEW FILE)
import { useState } from 'react';
import { Link } from 'react-router-dom';
import useUserReports from '../../hooks/useUserReports';
import useWalletStore from '../../store/wallet';
import { fmt } from '../../utils/format';

export default function UserReportList() {
  const { reports, loading, error } = useUserReports();
  const { address, hederaAccountId, isConnected } = useWalletStore(s => ({
    address: s.address,
    hederaAccountId: s.hederaAccountId,
    isConnected: s.connectionStatus === 'connected'
  }));

  if (loading) return <div>Loading...</div>;
  if (error) return <div className="text-red-400">Error: {String(error)}</div>;
  
  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <button onClick={() => useWalletStore.getState().openWalletModal()}>
          Connect Wallet
        </button>
      </div>
    );
  }
  
  if (reports.length === 0) {
    return (
      <div className="text-center py-12">
        <p>No audit reports found for your wallet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">My Audit Reports</h2>
      
      <div className="grid gap-4">
        {reports.map(report => (
          <ReportCard key={report.id} report={report} />
        ))}
      </div>
    </div>
  );
}

function ReportCard({ report }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex justify-between items-start">
        <h3 className="font-bold">Job #{report.jobId}</h3>
        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-1 rounded">
          {report.chain}
        </span>
      </div>
      
      <p className="text-sm text-gray-400 mt-1">
        {fmt.shortenAddress(report.contractAddress)}
      </p>
      
      <div className="flex gap-2 mt-3">
        {Object.entries(report.findingsBySeverity).map(([sev, count]) => (
          count > 0 && (
            <span key={sev} className="text-xs bg-gray-800 px-2 py-1 rounded">
              {sev.toUpperCase()}: {count}
            </span>
          )
        ))}
      </div>
      
      <Link
        to={`/reports/${report.jobId}`}
        className="mt-4 block text-center bg-cyan-600 text-white py-2 rounded"
      >
        View Report
      </Link>
    </div>
  );
}
```

#### Step 5: Connect to Routing
```javascript
// packages/dashboard/src/App.jsx (MODIFY)
import UserReportList from './components/reports/UserReportList';

// Add route
<Route 
  path="/reports" 
  element={<UserReportList />} 
/>
```

---

### **Phase 4: Hedera Address Support (1 hour)**

#### Update Wallet Hook
```javascript
// packages/dashboard/src/store/wallet.js (MODIFY)

connect: async (type) => {
  // ... existing code ...
  
  const address = await signer.getAddress();
  
  // Try to get Hedera Account ID
  let hederaAccountId = null;
  try {
    // MetaMask may expose Hedera SDK via window.ethereum
    // This is a placeholder - actual implementation depends on wallet
    hederaAccountId = await window.ethereum.request({
      method: 'hedera_getAccounts'
    }).then(accounts => accounts[0]?.accountId || null);
  } catch (err) {
    console.warn('[Wallet] Could not fetch Hedera ID:', err);
    // Fallback: User enters manually or derives from EVM
  }
  
  set({
    address,
    hederaAccountId,
    // ...
  });
}
```

#### Database Updates
```typescript
// packages/sdk/db/report-db.ts (MODIFY)

export async function getReportsByDeployer(addressOrId: string): Promise<AuditReport[]> {
  // Can be EVM (0x...) or Hedera (0.0.NNNN)
  const normalized = addressOrId.toLowerCase().trim();
  
  let reports = [];
  if (fs.existsSync(REPORTS_FILE)) {
    reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
  }
  
  return reports.filter(r => {
    const deployer = String(r.deployerAddress || '').toLowerCase();
    const hedera = String(r.hederaAccountId || '').toLowerCase();
    
    // Match either EVM or Hedera format
    return deployer === normalized || 
           hedera === normalized ||
           isEvmMatch(deployer, normalized) ||
           isHederaMatch(hedera, normalized);
  });
}

function isEvmMatch(evmAddress: string, query: string): boolean {
  // Handle checksummed vs lowercase
  return evmAddress.toLowerCase() === query.toLowerCase();
}

function isHederaMatch(hederaId: string, query: string): boolean {
  // 0.0.NNNN format
  return hederaId === query;
}
```

---

### **Phase 5: Claude Agent Integration (1 hour)**

#### Update .env.example
```bash
# .env.example (ADD)
ANTHROPIC_API_KEY=<your_claude_api_key_here>
```

#### Update Static Analysis Agent
```typescript
// agents/static-analysis/index.ts (MODIFY)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const USE_CLAUDE = !!ANTHROPIC_API_KEY;

async function analyzeWithClaude(contractCode: string, contractName: string): Promise<any> {
  if (!USE_CLAUDE) {
    return null;  // Fallback to heuristic
  }

  const crypto = require('crypto');
  const prompt = `Analyze this Solidity contract for security vulnerabilities:

Contract Name: ${contractName}
Code:
${contractCode}

Identify:
1. Reentrancy risks
2. Integer overflow/underflow
3. Access control issues
4. Oracle manipulation risks
5. Flash loan attack vectors

Return JSON with:
{
  "riskScore": number (0-100),
  "vulnerabilities": [
    {"type": "reentrancy", "severity": "critical/high/medium/low"},
    ...
  ],
  "recommendations": ["fix this", "fix that"]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    return JSON.parse(data.content[0].text);
  } catch (err) {
    console.error('[StaticAnalysis] Claude analysis failed:', err);
    return null;  // Fallback
  }
}

// In static analysis main
async function runStaticAnalysis(contractAddress, contractCode, contractName) {
  // Try Claude first
  let analysis = null;
  
  if (USE_CLAUDE) {
    console.log('[StaticAnalysis] Using Claude for analysis...');
    analysis = await analyzeWithClaude(contractCode, contractName);
  }
  
  // Fallback to heuristic if Claude failed
  if (!analysis) {
    console.log('[StaticAnalysis] Falling back to heuristic analysis...');
    analysis = runHeuristicAnalysis(contractCode);
  }
  
  return analysis;
}
```

---

## 🧪 Testing Checklist

### Database Tests
- [ ] `saveReport()` creates record with correct ID
- [ ] `getReportsByDeployer()` filters by address
- [ ] Case-insensitive address matching
- [ ] Hedera and EVM addresses both work
- [ ] Multiple reports per deployer supported

### Report Generation Tests
- [ ] Orchestrator detects `WinnersSelected` event
- [ ] Report markdown file created at `data/reports/{jobId}.md`
- [ ] Database entry includes full metadata
- [ ] Content hash matches markdown file
- [ ] Multiple agents' findings aggregated

### Frontend Tests
- [ ] Connect wallet → see reports list
- [ ] Wrong wallet → access denied page
- [ ] Empty state when no reports
- [ ] Click report → view markdown content
- [ ] CID verification shows ✓ icon

### Integration Tests
- [ ] End-to-end: Deploy → Audit → Report visible
- [ ] Hedera address displays correctly
- [ ] Claude analysis runs (if API key set)
- [ ] Performance: < 500ms query time

---

## 📊 Success Criteria

| Task | Deadline | Status |
|------|----------|--------|
| Database MVP | 2 hours | ⏳ Pending |
| Report generation | 2 hours | ⏳ Pending |
| Frontend hooks | 2 hours | ⏳ Pending |
| Hedera support | 1 hour | ⏳ Pending |
| Claude agent | 1 hour | ⏳ Pending |
| End-to-end test | 1 hour | ⏳ Pending |
| **TOTAL** | **9 hours** | ⏳ Pending |

---

## 🎯 Priority Order

**Week 1 (Must Have):**
1. Database CRUD functions
2. Report generation flow
3. Frontend wallet filtering

**Week 2 (Nice to Have):**
4. Hedera address support
5. Claude integration
6. Performance optimizations

---

## 🔍 Known Limitations

1. **JSON file scalability:** Max ~10K reports before migration needed
2. **Sequential writes:** No concurrency handling (simple locks needed)
3. **Address verification:** EVM/Hedera conversion not automatic
4. **Report encryption:** Content stored plaintext (future enhancement)

---

## 💾 Backup Strategy

```bash
# daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d)
cp data/reports.json "data/backups/reports-${DATE}.json"
cp -r data/reports "data/backups/reports-${DATE}"

# Cleanup old backups (keep 30 days)
find data/backups -type f -mtime +30 -delete
```

---

## 🚨 Emergency Procedures

### Database Corruption
```bash
# 1. Stop all services
pkill -f "orchestrator" || true
pkill -f "dashboard" || true

# 2. Restore from backup
cp data/backups/reports-$(date -v-1d +%Y%m%d).json data/reports.json

# 3. Restart services
npm run orchestrator &
npm run dashboard &
```

### Lost Reports
1. Check IPFS: `curl http://localhost:8080/ipfs/{cid}`
2. Re-download from 0g DA if needed
3. Regenerate markdown from HCS messages

---

## 📞 Support

**Documentation Files:**
- `DATABASE_SCHEMA.md` - Database architecture
- `REPORT_GEN_FLOW.md` - Agent workflow
- `WALLET_REPORT_ACCESS.md` - Frontend integration

**Code Locations:**
- Database: `packages/sdk/db/report-db.ts`
- Report Writer: `orchestrator/src/report-writer.ts`
- API: `packages/dashboard/server/api/reports.js`
- UI: `packages/dashboard/src/components/reports/UserReportList.jsx`

---

**Ready to implement! 🚀**

Follow the sections in `final_bs/` to implement each component. Start with `README.md` for overview, then tackle the three detailed files in order.
