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

### **Task A: DB Module + Report Writer**

> Full code in `tasks.md`. Summary of steps below.

#### Step 1: Initialize DB
```bash
# Start local Postgres (Docker)
docker run -d --name pg-local -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=auditguard -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/auditguard

# Run pre-committed schema
psql "$DATABASE_URL" -f orchestrator/src/schema.sql
```

#### Step 2: Create Database Module
```js
// packages/sdk/db/report-db.js
import pg from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { reportId, normalizeDeployer, s3Key, EMPTY_FINDINGS } from './report-types.js';

export async function saveReport(report) { ... }
export async function getReportsByDeployer(addr) { ... }
export async function getReportById(jobId) { ... }   // fetches mdContent from S3
export async function reportExists(jobId) { ... }
```

Leave `AWS_S3_BUCKET` unset locally — S3 upload is skipped silently.

#### Step 3: Fix orchestrator gap + create report-writer.js
See `tasks.md` → Task A for exact edits to `orchestrator.js` and full `report-writer.js` code.

#### Step 4: Test
```bash
node scripts/test-db.js   # saveReport, getReportsByDeployer, reportExists
# Then trigger WinnersSelected and confirm DB row + S3 object
```

---

### **Task B: Express API Server**

> Full code in `tasks.md` → Task B.

#### Step 1: Stub report-db.js (until Task A merges)
```js
// packages/sdk/db/report-db.js  ← temporary
export async function getReportsByDeployer() { return []; }
export async function getReportById()        { return null; }
export async function saveReport(r)          { return `report:${r.jobId}`; }
```

#### Step 2: Create Express server + route handler
See `tasks.md` → Task B for full `server/index.js` and `server/api/reports.js`.

#### Step 3: Add Vite proxy for local dev
```js
// packages/dashboard/vite.config.js — add to proxy block:
'/api': { target: `http://localhost:${process.env.API_PORT ?? 3002}`, changeOrigin: true }
```

#### Step 4: Build and test Docker image
```bash
node packages/dashboard/server/index.js
curl http://localhost:3002/health
curl "http://localhost:3002/api/reports?deployer=0xabc..."
```

---

### **Task C: Frontend Hook + UI**

> Full code in `tasks.md` → Task C and `WALLET_REPORT_ACCESS.md`.

#### Step 1: Start mock API (until Task B merges)
```bash
node scripts/mock-api.js   # serves sample data on :3002
```

#### Step 2: Create hook (`useUserReports.js`)
Use `useState + useEffect`. Do **not** use `useAsyncMemo` (not installed).
Prefix all fetch calls with `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''`.

#### Step 3: Create `UserReportList.jsx`
Handle states in order: no wallet → loading → error → empty → report grid.
Use `fmt.address()` from `utils/format.js` and existing severity colors.

#### Step 4: Wire into existing page
Add "My Reports" section to `ReportMarketplace.jsx` — do not replace existing content.

#### Step 5: Test
```bash
# Wallet connect → reports list renders
# Set VITE_API_BASE_URL in .env.local → confirm Vercel-style routing works
```

---

### **Phase 4: Hedera Address Support (handled in Task A)**

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

### Task A Tests
- [ ] `saveReport()` creates row with correct ID
- [ ] `getReportsByDeployer()` filters by EVM address (case-insensitive)
- [ ] `getReportsByDeployer()` also matches on `hedera_account_id`
- [ ] `saveReport()` on same `jobId` updates row (no duplicate)
- [ ] `reportExists()` returns `true` after insert, `false` before
- [ ] `WinnersSelected` event triggers `generateAndStoreReport()`
- [ ] S3 upload happens (or logs skip when `AWS_S3_BUCKET` not set)
- [ ] `deployerAddress` is lowercase in every saved row

### Task B Tests
- [ ] `GET /health` returns `{ ok: true }`
- [ ] `GET /api/reports?deployer=0x...` returns array
- [ ] `GET /api/reports/:jobId` returns report with `mdContent`
- [ ] `GET /api/reports/../etc/passwd` returns 400
- [ ] `POST /api/reports` with missing fields returns 400
- [ ] Docker image builds and serves health check

### Task C Tests
- [ ] Wallet not connected → connect prompt, no console errors
- [ ] Wallet connected → fetch fires with `API_BASE` prefix, reports render
- [ ] `VITE_API_BASE_URL` in `.env.local` overrides Vite proxy
- [ ] Different wallet → list clears and re-fetches
- [ ] API returns 500 → error banner shown, no crash

---

## 📊 Success Criteria

| Task | Branch | Status |
|------|--------|--------|
| Task A — DB + Report Writer | `task/report-backend` | ⏳ Pending |
| Task B — Express API | `task/report-api` | ⏳ Pending |
| Task C — Frontend | `task/report-ui` | ⏳ Pending |

**Merge order:** Task A → Task B → Task C (B and C may merge in either order)

---

## 🎯 Priority Order

**Must Have (all three tasks):**
1. Task A — DB module + report writer (backend pipeline)
2. Task B — Express API (HTTP layer)
3. Task C — Frontend hook + UI

**All three can run in parallel.** Task B and C use stubs/mocks until Task A merges.

---

## 🔍 Known Limitations

1. **S3 in local dev:** Skipped silently when `AWS_S3_BUCKET` is unset — `mdContent` will be empty until S3 is configured
2. **Address verification:** EVM/Hedera conversion not automatic — both formats stored in separate columns
3. **Report encryption:** Content stored in S3 without encryption (future enhancement)

---

## 💾 Backup Strategy

PostgreSQL and S3 have their own backup mechanisms:
- **PostgreSQL:** Use `pg_dump` or enable automated backups in RDS / Vercel Postgres
- **S3:** Enable versioning on `auditguard-reports` bucket; reports can be re-fetched by CID from IPFS/0g if S3 is lost

### Emergency: Lost DB Row
1. The CID is stored in the DB row — if the row is lost, re-index from HCS `REPORT_METADATA` messages
2. `mdContent` in S3 can be re-uploaded using the CID and IPFS: `curl http://localhost:8080/ipfs/{cid}`

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
