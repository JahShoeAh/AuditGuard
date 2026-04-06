# AuditGuard — Real Fuzzing Integration

## What "Real" Smart Contract Fuzzing Means

Unlike binary fuzzing, EVM fuzzing works by:
1. Deploying the contract in a local EVM fork
2. Sending random/mutated transactions to every public function
3. Checking **invariants** — properties that should never be false (e.g. "total supply never increases without minting", "user balance never exceeds total deposits")
4. A **violation** = a real bug

The tools that actually do this:

| Tool | Approach | Source Needed? | Best For |
|------|----------|---------------|---------|
| **Echidna** | Property-based fuzzing | Yes (Solidity) | DeFi invariants, known patterns |
| **Medusa** | Echidna successor (faster) | Yes (Solidity) | Same, better corpus management |
| **Foundry Fuzz** | Stateless fuzzing | Yes (Solidity) | Unit-level property testing |
| **ItyFuzz** | Bytecode-level, EVM fork | No (bytecode only) | Deployed contracts, no source |
| **Mythril** | Symbolic execution | No (bytecode only) | Reentrancy, integer overflow |

**For AuditGuard's use case, ItyFuzz is the most important one** — it runs directly against deployed contracts on a forked chain, no source code required. That's the only realistic option for arbitrary contracts discovered on Hedera.

---

## Architecture: Fuzzing Service on a 24/7 Server

The cleanest design is a **fuzzing microservice** that the Fuzzer agent submits jobs to:

```
Fuzzer Agent (on-chain)
    │
    │ POST /fuzz { contractAddress, bytecode, chainId, budget }
    ▼
Fuzzing Service (your server)
    ├── Job Queue (Redis/SQLite)
    ├── ItyFuzz worker (bytecode targets)
    ├── Echidna worker (verified source targets)
    └── Result store
    │
    │ GET /results/:jobId → { findings: [...], corpus: [...] }
    ▼
Fuzzer Agent
    └── Submits findings on-chain
```

---

## Step-by-Step Setup

### 1. Install the tools on your server

```bash
# ItyFuzz (works on bytecode — most useful for you)
git clone https://github.com/fuzzland/ityfuzz
cd ityfuzz
cargo build --release
# or use Docker:
docker pull fuzzland/ityfuzz:latest

# Echidna (for when you have source)
docker pull ghcr.io/crytic/echidna/echidna:latest

# Medusa (Echidna alternative, better perf)
pip install eth-brownie
go install github.com/crytic/medusa@latest

# Foundry (for source-based)
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

### 2. Create the fuzzing service

Create `packages/fuzzer-service/` as a small Express API:

```typescript
// packages/fuzzer-service/src/index.ts
import express from "express";
import { runItyFuzz } from "./runners/ityfuzz";
import { runEchidna } from "./runners/echidna";
import { JobQueue } from "./queue";

const app = express();
const queue = new JobQueue();

// Fuzzer agent submits a job here
app.post("/fuzz", async (req, res) => {
  const { contractAddress, bytecode, chainForkUrl, budgetSeconds = 300 } = req.body;

  const jobId = queue.enqueue({
    contractAddress,
    bytecode,
    chainForkUrl,          // fork Hedera testnet RPC
    budgetSeconds,         // how long to fuzz (longer = more coverage)
    tool: bytecode ? "ityfuzz" : "echidna"
  });

  res.json({ jobId, status: "queued" });
});

// Agent polls this
app.get("/results/:jobId", (req, res) => {
  const job = queue.get(req.params.jobId);
  res.json(job); // { status, findings, coverage, elapsed }
});

app.listen(4001);
```

### 3. ItyFuzz runner (bytecode target, no source needed)

```typescript
// packages/fuzzer-service/src/runners/ityfuzz.ts
import { execSync, spawn } from "child_process";
import fs from "fs";

export async function runItyFuzz(job: FuzzJob): Promise<Finding[]> {
  // ItyFuzz can fork a live chain and fuzz a deployed contract
  const args = [
    "evm",
    "--onchain-block-number", "0",         // latest block
    "--chain-id", "296",                    // Hedera testnet
    "--onchain-rpc", job.chainForkUrl,
    "--target", job.contractAddress,
    "--run-forever",                        // we kill it after budgetSeconds
    "--output-dir", `/tmp/ityfuzz-${job.id}`,
    "--bug-oracle", "all",                  // check all known patterns
  ];

  return new Promise((resolve) => {
    const proc = spawn("ityfuzz", args);
    const findings: Finding[] = [];

    proc.stdout.on("data", (data) => {
      // ItyFuzz streams findings as JSON lines
      parseItyFuzzOutput(data.toString(), findings);
    });

    // Kill after budget
    setTimeout(() => {
      proc.kill();
      resolve(findings);
    }, job.budgetSeconds * 1000);
  });
}

function parseItyFuzzOutput(output: string, findings: Finding[]) {
  // ItyFuzz outputs: BUG FOUND: reentrancy at 0x... via calldata 0x...
  const reentrantcy = /BUG FOUND: (\w+) at (0x\w+)/g;
  let match;
  while ((match = reentrantcy.exec(output)) !== null) {
    findings.push({
      id: `FUZZ-${Date.now()}`,
      title: `${match[1]} vulnerability found`,
      severity: mapBugTypeToSeverity(match[1]),
      type: match[1],
      reproTx: match[2],
    });
  }
}
```

### 4. Wire the Fuzzer agent to use the service

In `agents/fuzzer/index.ts`, replace `generateFindings()` with:

```typescript
async function analyzeContract(job: AuctionInvite): Promise<Finding[]> {
  const FUZZER_SERVICE = process.env.FUZZER_SERVICE_URL ?? "http://localhost:4001";

  // Submit job
  const { jobId } = await fetch(`${FUZZER_SERVICE}/fuzz`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractAddress: job.contractAddress,
      chainForkUrl: process.env.HEDERA_JSON_RPC_URL,
      budgetSeconds: Math.min(job.estimatedCompletionTime - 30, 600), // use most of the SLA
    })
  }).then(r => r.json());

  // Poll for results (agent's estimated completion time is the deadline)
  const deadline = Date.now() + job.estimatedCompletionTime * 1000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const result = await fetch(`${FUZZER_SERVICE}/results/${jobId}`).then(r => r.json());
    if (result.status === "done") return result.findings;
  }

  return []; // timed out — no findings, still submit
}
```

---

## Corpus Persistence (the 24/7 advantage)

The big win from running continuously is **corpus accumulation**. Each contract that gets fuzzed builds up a corpus of interesting inputs. When the same contract is audited again (e.g., after redeployment), fuzzing starts from a much better seed:

```typescript
// In the fuzzer service
const CORPUS_DIR = "/data/fuzzing-corpus";

function getCorpusPath(contractAddress: string) {
  return path.join(CORPUS_DIR, contractAddress.toLowerCase());
}

// ItyFuzz: pass existing corpus
args.push("--corpus-dir", getCorpusPath(job.contractAddress));
// After run: corpus is automatically saved there for next time
```

This means a contract audited 5 times gets progressively deeper fuzzing — impossible with ephemeral runs.

---

## Realistic Findings You'd Get

ItyFuzz running on the 3 demo vaults in this repo would find:

| Contract | Expected Finding | Severity |
|----------|-----------------|---------|
| `VulnerableVault1.sol` | Integer overflow / underflow | High |
| `VulnerableVault2.sol` | Reentrancy on withdraw | Critical |
| `VulnerableVault3.sol` | Access control bypass | High |
| `TimeLockVault.sol` | Owner can drain any deposit (the intentional rug) | Critical |

The `TimeLockVault.sol` finding is literally planted in the code as an audit target — ItyFuzz would catch it by finding the path where `emergencyWithdraw` bypasses the time lock.

---

## Minimum Server Spec

| Component | Minimum | Better |
|-----------|---------|--------|
| CPU | 4 cores | 16+ cores (parallel jobs) |
| RAM | 8 GB | 32 GB (large contract state) |
| Storage | 100 GB SSD | 1 TB (corpus persistence) |
| OS | Ubuntu 22.04 | Same |

ItyFuzz is CPU-bound, not GPU. More cores = more parallel fuzzing campaigns.

---

## What to Build

1. **`packages/fuzzer-service/`** — small Express API wrapping ItyFuzz + Echidna (2-3 days)
2. **`agents/fuzzer/index.ts`** — replace `generateFindings()` with HTTP call to the service (2 hours)
3. **`.env`** — add `FUZZER_SERVICE_URL=http://your-server:4001`
4. **Corpus directory on server** — persists between jobs, gets smarter over time

The Fuzzer agent already handles everything else — bidding, winning, submitting on-chain, HCS messaging. You'd only be replacing the ~30 lines of mock `generateFindings()` with a real subprocess call.
