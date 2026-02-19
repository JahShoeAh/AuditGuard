# Agent Systems — Technical Design Document

> Current build notes (2026-02-19): production agent scripts now respond to orchestrator `PING` with `PONG`, and bidding agents support invite-first context resolution for `AUCTION_INVITE`.

**Role:** Person 2 — Agent Systems & Orchestration Lead  
**Scope:** The agent network, economy logic, and inter-agent interactions. NOT the Orchestrator Agent (handled separately).  
**Purpose:** Everything you need to vibe-code this. Copy-paste sections into your AI coding tool as context.

---

## What You're Actually Building

You're building **6 autonomous agent scripts** and the **messaging/commerce infrastructure** that lets them interact. Each agent is a Node.js process that listens for on-chain events or HCS messages, makes decisions, and calls smart contracts. Think of it as a bunch of bots that trade with each other on-chain.

The Orchestrator Agent is someone else's problem. You own everything else in the agent layer.

---

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    HCS Topics (Message Bus)              │
│  Discovery Topic │ AuditLog Topic │ AgentComms Topic     │
└────────┬─────────────────┬──────────────────┬───────────┘
         │                 │                  │
    ┌────▼────┐     ┌──────▼──────┐    ┌──────▼──────┐
    │ Scanner │     │ Report Agent│    │ Alert Agent │
    │  Agent  │     │             │    │             │
    └────┬────┘     └──────▲──────┘    └─────────────┘
         │                 │
    ┌────▼─────────────────┴──────────────────────┐
    │          Smart Contracts (on-chain)           │
    │  Auction │ SubAuction │ DataMarketplace │ Pay │
    └────┬─────────┬───────────────┬──────────────┘
         │         │               │
   ┌─────▼───┐ ┌──▼────────┐ ┌───▼──────────┐
   │ Static  │ │  Fuzzer   │ │ LLM Context  │
   │ Analysis│ │  Agent    │ │   Agent      │
   │ Agent   │ │           │ │              │
   └─────────┘ └───────────┘ └──────┬───────┘
                                    │
                              ┌─────▼───────┐
                              │ Dependency  │
                              │  Agent      │
                              └─────────────┘
```

---

## Agent Inventory

| # | Agent | What It Does | Day |
|---|-------|-------------|-----|
| 1 | Scanner Agent | Monitors chain, publishes discoveries to HCS | Day 1 |
| 2 | Static Analysis Agent | Fast cheap scans, sells reports to other agents | Day 1 |
| 3 | Fuzzer Agent | Complex analysis, buys data from other agents | Day 1 |
| 4 | LLM Contextual Agent | Premium audits, sub-contracts work out | Day 1–2 |
| 5 | Dependency Analyzer Agent | Sub-contractor, wins micro-jobs from other agents | Day 2 |
| 6 | Report Agent | Aggregates findings, scores accuracy, publishes report hash | Day 3 |
| 7 | Alert Agent (stretch) | Watches for critical findings, sends webhooks | Day 3 |

---

## Shared Infrastructure (Build First)

Before any agent, you need the scaffolding they all share.

### Project Structure

```
agents/
├── shared/
│   ├── config.ts            # Load from packages/sdk/config.json
│   ├── hcs-client.ts        # Subscribe/publish to HCS topics
│   ├── contract-client.ts   # ethers.js wrappers for all contracts
│   ├── wallet.ts            # Per-agent wallet management
│   ├── logger.ts            # Winston structured logging
│   └── types.ts             # All message schemas + event types
├── scanner/
│   └── index.ts
├── static-analysis/
│   └── index.ts
├── fuzzer/
│   └── index.ts
├── llm-contextual/
│   └── index.ts
├── dependency/
│   └── index.ts
├── report/
│   └── index.ts
├── alert/
│   └── index.ts
└── run-all.ts               # concurrently launcher
```

### Message Schemas (types.ts)

Every HCS message follows this envelope:

```typescript
interface HCSMessage {
  type: string;
  agentId: string;
  timestamp: number;
  payload: Record<string, any>;
}

// Discovery Topic
interface ContractDiscoveryEvent {
  type: "CONTRACT_DISCOVERED";
  agentId: string;            // scanner agent ID
  timestamp: number;
  payload: {
    contractAddress: string;
    chain: string;            // "hedera-testnet" | "ethereum" etc
    deployerAddress: string;
    estimatedLOC: number;     // lines of code estimate
    contractType: string;     // "lending" | "dex" | "staking" | "unknown"
    riskScore: number;        // 0-100 initial assessment
    txHash: string;
  };
}

// AgentComms Topic
interface SubAuctionPosted {
  type: "SUB_AUCTION_POSTED";
  agentId: string;
  timestamp: number;
  payload: {
    subAuctionId: string;     // on-chain ID
    taskType: string;         // "dependency_analysis" | "exploit_db_lookup"
    paymentAmount: number;    // GUARD tokens
    slaDurationSec: number;   // max time to complete
    parentJobId: string;      // the main auction job
  };
}

interface DataListingCreated {
  type: "DATA_LISTING_CREATED";
  agentId: string;
  timestamp: number;
  payload: {
    listingId: string;        // on-chain ID from DataMarketplace
    category: string;         // "SCAN_REPORT" | "DEPENDENCY_TREE" | "HOT_LEAD" | "VULN_DB"
    price: number;            // GUARD tokens
    description: string;
    jobId: string;            // related audit job
  };
}

interface FindingsSubmission {
  type: "FINDINGS_SUBMITTED";
  agentId: string;
  timestamp: number;
  payload: {
    jobId: string;
    findingsHash: string;     // hash of findings data
    findingsCount: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
  };
}

// AuditLog Topic
interface AuditLogEntry {
  type: "AUCTION_CREATED" | "BID_SUBMITTED" | "WINNER_SELECTED" |
        "SUB_AUCTION_CREATED" | "DATA_PURCHASED" | "PAYMENT_SETTLED" |
        "REPORT_PUBLISHED" | "REPUTATION_UPDATED";
  agentId: string;
  timestamp: number;
  payload: Record<string, any>;  // varies by type
}
```

### Contract Client (contract-client.ts)

Wraps ethers.js calls to the contracts Person 1 deploys. You'll get ABIs from `packages/sdk/abis/`.

```typescript
import { ethers } from "ethers";
import config from "./config";

export class ContractClient {
  private auction: ethers.Contract;
  private subAuction: ethers.Contract;
  private dataMarketplace: ethers.Contract;
  private paymentSettlement: ethers.Contract;
  private guardToken: ethers.Contract;
  
  constructor(wallet: ethers.Wallet) {
    // Initialize all contracts with ABIs from Person 1
  }

  // Auction
  async submitBid(jobId: string, amount: number, collateral: number): Promise<string>;
  async getAuctionDetails(jobId: string): Promise<AuctionDetails>;
  
  // SubAuction
  async createSubAuction(taskType: string, payment: number, slaSec: number): Promise<string>;
  async submitSubBid(subAuctionId: string, amount: number): Promise<string>;
  async deliverResult(subAuctionId: string, resultHash: string): Promise<void>;
  async acceptResult(subAuctionId: string): Promise<void>;

  // DataMarketplace
  async createListing(price: number, category: string, dataHash: string): Promise<string>;
  async purchaseData(listingId: string): Promise<string>;

  // Listen for events
  onAuctionCreated(callback: (event: any) => void): void;
  onWinnerSelected(callback: (event: any) => void): void;
  onSubAuctionCreated(callback: (event: any) => void): void;
}
```

### HCS Client (hcs-client.ts)

```typescript
import { Client, TopicMessageSubmitTransaction, TopicMessageQuery } from "@hashgraph/sdk";

export class HCSClient {
  constructor(hederaClient: Client) {}

  async publish(topicId: string, message: HCSMessage): Promise<void>;
  subscribe(topicId: string, callback: (msg: HCSMessage) => void): void;
  
  // Convenience
  async publishDiscovery(event: ContractDiscoveryEvent): Promise<void>;
  async publishAuditLog(entry: AuditLogEntry): Promise<void>;
  async publishAgentComms(message: HCSMessage): Promise<void>;
}
```

---

## Agent Specifications

### Agent 1: Scanner Agent

**Purpose:** Simulates monitoring the chain and discovering new contracts. Publishes discovery events that kick off the entire auction cycle.

**Day:** 1

**Behavior:**
1. Every 5 minutes (configurable), generate a mock contract discovery
2. Randomize: contract type (lending/dex/staking), LOC (500–10000), risk score (20–95)
3. Publish `CONTRACT_DISCOVERED` to HCS Discovery Topic
4. Optionally: sell "hot leads" — high-risk contracts get listed on DataMarketplace for 0.1 GUARD before public announcement (1-minute delay before HCS publish)

**Decision Logic:**
```
if riskScore > 80:
    list as hot lead on DataMarketplace (0.1 GUARD)
    wait 60 seconds
publish to HCS Discovery Topic
```

**Inputs:** Timer / cron loop  
**Outputs:** HCS Discovery messages, DataMarketplace hot lead listings  
**Contracts Called:** `DataMarketplace.createListing()` (for hot leads)

**Mock Data Generator:**
```typescript
function generateMockDiscovery(): ContractDiscoveryEvent {
  const types = ["lending", "dex", "staking", "bridge", "vault"];
  const chains = ["hedera-testnet"];
  return {
    type: "CONTRACT_DISCOVERED",
    agentId: "scanner-001",
    timestamp: Date.now(),
    payload: {
      contractAddress: `0x${randomHex(40)}`,
      chain: chains[0],
      deployerAddress: `0x${randomHex(40)}`,
      estimatedLOC: randomInt(500, 10000),
      contractType: randomChoice(types),
      riskScore: randomInt(20, 95),
      txHash: `0x${randomHex(64)}`,
    },
  };
}
```

---

### Agent 2: Static Analysis Agent

**Purpose:** Fast, cheap baseline scanner. High-volume, low-margin strategy. Sells its reports to other agents.

**Day:** 1 (basic bidding), Day 2 (data selling)

**Behavior:**
1. Listen for `WINNER_SELECTED` events where this agent won
2. Run mock audit (random delay 10–30 sec simulating "fast scan")
3. Generate mock findings (3–10 findings, mostly low/medium severity)
4. Submit findings hash on-chain
5. **Day 2:** After completing scan, list report on DataMarketplace for 0.5 GUARD

**Bidding Strategy:**
```
bid = baseCost + (estimatedLOC * 0.002)   // cheap linear pricing
if contractType in mySpecializations:
    bid *= 0.9                              // discount for familiar territory
collateral = bid * 0.5                      // stake half of bid as collateral
```

Specializations: `["lending", "vault", "staking"]`  
Reputation: starts at 75 (mid-tier)

**Mock Findings Generator:**
```typescript
function generateFindings(contractType: string, loc: number): Finding[] {
  const count = randomInt(3, 10);
  const severities = { critical: 0.05, high: 0.15, medium: 0.4, low: 0.4 };
  return Array(count).fill(null).map((_, i) => ({
    id: `SA-${i+1}`,
    severity: weightedRandom(severities),
    title: randomFindingTitle(contractType),
    description: `Mock finding for ${contractType} contract`,
    confidence: randomFloat(0.6, 0.95),
  }));
}
```

**Contracts Called:**
- `Auction.submitBid()`
- `DataMarketplace.createListing()` — sell scan report
- `PaymentSettlement` — receives payment after job completion

---

### Agent 3: Fuzzer Agent

**Purpose:** More expensive, complex analysis. Buys data from other agents to optimize its work.

**Day:** 1 (basic bidding), Day 2 (data purchasing)

**Behavior:**
1. Listen for auction events, evaluate if worth bidding
2. When assigned a job, check DataMarketplace for available scan reports from Static Analysis Agent
3. **If report available and price ≤ 1 GUARD:** purchase it, use to "optimize" fuzzing
4. Run mock audit (random delay 30–90 sec, longer = more thorough)
5. Generate findings (2–6 findings, skewed higher severity)
6. Submit findings

**Bidding Strategy:**
```
bid = baseCost + (estimatedLOC * 0.005)   // more expensive per LOC
if riskScore > 70:
    bid *= 1.2                              // complex = charge more
collateral = bid * 0.6
```

Specializations: `["dex", "bridge"]` (complex state machines)  
Reputation: starts at 82

**Data Purchasing Logic (Day 2):**
```
after winning auction:
  listings = DataMarketplace.getListings(jobId, category="SCAN_REPORT")
  for listing in listings:
    if listing.price <= 1.0 GUARD and listing.agentId != myId:
      DataMarketplace.purchaseData(listing.id)
      log("Purchased report from {listing.agentId}, optimizing fuzzing")
      reduceAuditTime(20%)  // simulate optimization
```

**Contracts Called:**
- `Auction.submitBid()`
- `DataMarketplace.purchaseData()` — buy scan reports
- `PaymentSettlement` — receives payment

---

### Agent 4: LLM Contextual Agent

**Purpose:** Premium agent. Charges the most but finds unique vulnerabilities. Sub-contracts dependency analysis to other agents.

**Day:** 1 (basic bidding), Day 2 (sub-contracting)

**Behavior:**
1. Listen for auctions, only bid on complex or high-value contracts
2. When assigned, check if contract has external dependencies
3. **If dependencies detected:** create a SubAuction for dependency analysis (3 GUARD, 15-min SLA)
4. Wait for sub-contractor to deliver results
5. Run mock deep analysis (60–180 sec delay)
6. Generate findings (1–5 findings, heavily skewed critical/high)
7. Submit findings

**Bidding Strategy:**
```
if riskScore < 50: skip                    // only take complex jobs
if estimatedLOC < 1000: skip               // not worth my time

bid = 30 + (estimatedLOC * 0.003)          // premium base
if contractType == "lending" or "bridge":
    bid *= 1.15                             // premium for risky types
collateral = bid * 0.4                      // lower collateral ratio (high rep)
```

Specializations: `["lending", "bridge", "dex"]`  
Reputation: starts at 87

**Sub-Contracting Logic (Day 2):**
```
after winning auction:
  hasDependencies = randomBool(0.7)  // 70% chance mock contract has deps
  if hasDependencies:
    subAuctionId = SubAuction.createSubAuction(
      taskType: "dependency_analysis",
      paymentAmount: 3,             // 3 GUARD
      slaDuration: 900              // 15 minutes
    )
    publish SUB_AUCTION_POSTED to AgentComms
    
    // Wait for result delivery
    onResultDelivered(subAuctionId, (result) => {
      SubAuction.acceptResult(subAuctionId)
      incorporateResults(result)
      continueAudit()
    })
```

**Contracts Called:**
- `Auction.submitBid()`
- `SubAuction.createSubAuction()` — post sub-jobs
- `SubAuction.acceptResult()` — accept delivered work
- `PaymentSettlement` — receives payment

---

### Agent 5: Dependency Analyzer Agent

**Purpose:** Specialist sub-contractor. Doesn't compete in main auctions. Watches for sub-auctions and bids on those.

**Day:** 2

**Behavior:**
1. Listen for `SUB_AUCTION_POSTED` messages on AgentComms topic
2. If `taskType == "dependency_analysis"`, evaluate and bid
3. If selected, perform mock dependency analysis (15–45 sec)
4. Deliver result hash via `SubAuction.deliverResult()`
5. Receive payment automatically on acceptance

**Bidding Strategy:**
```
// Sub-auction bids — always try to undercut
bid = postedPayment * 0.85   // bid 85% of offered amount
if currentBacklog > 2:
    bid = postedPayment * 0.95  // less discount when busy
```

**Mock Analysis Output:**
```typescript
function generateDependencyAnalysis(): DependencyResult {
  return {
    dependencies: randomInt(3, 15),
    knownVulnerable: randomInt(0, 3),
    outdatedDeps: randomInt(0, 5),
    riskFactors: ["unverified-proxy", "deprecated-oracle", "centralization-risk"]
      .filter(() => Math.random() > 0.5),
    analysisHash: hashOf(results),
  };
}
```

**Contracts Called:**
- `SubAuction.submitSubBid()`
- `SubAuction.deliverResult()`

---

### Agent 6: Report Agent

**Purpose:** Aggregates findings from all auditor agents on a job, detects duplicates, scores accuracy, publishes the final report hash.

**Day:** 3

**Behavior:**
1. Listen for `FINDINGS_SUBMITTED` events
2. Collect all findings for a given jobId
3. When all assigned agents have submitted (or timeout):
   - Aggregate findings
   - Detect overlapping findings (same vulnerability found by multiple agents)
   - Calculate accuracy scores per agent (mock: random 60–100%)
   - Charge each agent 0.1 GUARD report fee (discounted for rep > 90)
   - Compute final report hash and publish to HCS AuditLog

**Duplicate Detection (mock):**
```
for each pair of findings from different agents:
  similarityScore = mockSimilarity()  // random 0-1
  if similarityScore > 0.8:
    mark as duplicate
    credit the agent who submitted first
    penalize late submitter slightly (-1 rep)
```

**Accuracy Scoring (mock):**
```
for each agent's findings:
  validFindings = findings.filter(f => random() > 0.15)  // 85% valid rate mock
  accuracy = validFindings.length / findings.length
  reputationDelta = (accuracy - 0.7) * 10  // +/- reputation points
  
  publish REPUTATION_UPDATED to AuditLog
```

**Report Fee Logic:**
```
for each submitting agent:
  fee = 0.1 GUARD
  if agentReputation > 90:
    fee = reportFeeDiscounted  // from PaymentSettlement contract
  charge fee via PaymentSettlement
```

**Contracts Called:**
- `PaymentSettlement.settleJob()` — trigger final payment batch
- HCS publish to AuditLog topic

---

### Agent 7: Alert Agent (Stretch Goal)

**Purpose:** Watches Report Agent output for critical findings, sends webhooks.

**Day:** 3 (if time permits)

**Behavior:**
1. Subscribe to AuditLog topic
2. When `REPORT_PUBLISHED` event appears, check `criticalCount`
3. If `criticalCount > 0`, fire webhook to Discord/Slack

This one is simple. Don't overthink it.

---

## Day-by-Day Build Order

### Day 1: Get Agents Bidding

**Morning:**
1. Set up project structure (`agents/shared/`, `agents/scanner/`, etc.)
2. Build `shared/config.ts` — load config from `packages/sdk/config.json`
3. Build `shared/hcs-client.ts` — basic publish/subscribe
4. Build `shared/contract-client.ts` — connect to Person 1's deployed contracts (get ABIs from them)
5. Build `shared/types.ts` — all message interfaces

**Afternoon:**
6. Build Scanner Agent — timer loop, mock discovery generation, HCS publish
7. Build Static Analysis Agent — listen for auctions, calculate bid, submit on-chain
8. Build Fuzzer Agent — same as above with different bidding params
9. Build LLM Contextual Agent — same but with the "only complex jobs" filter

**End of Day 1 Demo:** Terminal showing Scanner → Discovery → 3 Agents Bidding → Winner Selected. All autonomous.

### Day 2: Agent Commerce

**Morning:**
1. Add sub-contracting to LLM Agent (create SubAuction)
2. Build Dependency Agent (listen for sub-auctions, bid, deliver)
3. Test the sub-auction flow end to end

**Afternoon:**
4. Add data selling to Static Analysis Agent (DataMarketplace.createListing)
5. Add data buying to Fuzzer Agent (DataMarketplace.purchaseData)
6. Add hot lead selling to Scanner Agent
7. Wire all HCS logging (every transaction → AuditLog topic)

**End of Day 2 Demo:** Main auction → LLM Agent sub-contracts to Dependency Agent → Static Agent sells report → Fuzzer buys it. Nested economy visible in logs.

### Day 3: Report Synthesis & Reputation

**Morning:**
1. Build Report Agent — aggregate findings, duplicate detection
2. Add accuracy scoring and reputation delta calculation
3. Add report fee charging

**Afternoon:**
4. Build Alert Agent (if time)
5. Wire reputation updates to iNFT lead (Person 3) — call their APIs
6. Ensure all events stream properly for Frontend (Person 4)

**End of Day 3 Demo:** Full cycle including report generation, reputation updates visible.

### Day 4: Integration & Demo

1. Build `run-all.ts` — launches all agents concurrently
2. Build demo script that runs 3–4 full cycles back to back
3. Add agent health monitoring / auto-restart
4. Help Person 4 with frontend event integration
5. Rehearse the live demo

---

## Key Interfaces With Other Roles

### From Person 1 (Blockchain Lead) — You Need:
- Contract addresses in `config.json` (Day 1 AM)
- ABI files in `packages/sdk/abis/` (Day 1 AM)
- HCS topic IDs for Discovery, AuditLog, AgentComms (Day 1 AM)
- GUARD token ID (Day 1 AM)
- Testnet accounts with funded HBAR + GUARD for each agent (Day 1 AM)

### To Person 3 (iNFT Lead) — You Provide:
- `REPUTATION_UPDATED` events via HCS AuditLog (Day 3)
- Agent activity data (jobs completed, accuracy scores)
- Agreed event schema by Day 2 AM

### To Person 4 (Frontend Lead) — You Provide:
- All HCS messages (they subscribe to the same topics)
- Event stream documentation (your types.ts is the contract)
- Make sure your console logs are clean — they may display terminal output in demo

---

## Environment Setup

```bash
# Dependencies
npm install @hashgraph/sdk ethers dotenv winston typescript ts-node concurrently

# .env per agent (or one shared .env with multiple account IDs)
HEDERA_NETWORK=testnet
HEDERA_ACCOUNT_ID_SCANNER=0.0.xxxxx
HEDERA_PRIVATE_KEY_SCANNER=...
HEDERA_ACCOUNT_ID_STATIC=0.0.xxxxx
HEDERA_PRIVATE_KEY_STATIC=...
# ... etc for each agent
GUARD_TOKEN_ID=0.0.xxxxx
```

---

## What "Mock" Means Here

You're at a hackathon. Nothing actually audits code. Here's what's real vs. fake:

| Real (On-Chain) | Mock (Fake Data) |
|----------------|-----------------|
| Bids submitted to Auction contract | Audit analysis (random delay + random findings) |
| GUARD token transfers via HTS | Vulnerability detection |
| HCS message publishing | Contract "discovery" (timer, not real monitoring) |
| SubAuction creation + payment | Dependency analysis results |
| DataMarketplace listings + purchases | Code parsing / LOC estimation |
| Payment settlements | Risk scoring |
| All agent wallet transactions | Similarity detection for duplicates |

The on-chain commerce is real. The auditing is theater. That's the whole point — you're demoing the **economy**, not the **auditing**.

---

## Common Pitfalls

1. **Don't build an actual code analyzer.** This is an economy demo. Agents produce random findings with random delays. Period.
2. **Don't over-engineer agent "intelligence."** Bidding logic should be 5–10 lines of arithmetic, not an ML model.
3. **Coordinate with Person 1 early.** If you don't have contract addresses and ABIs by Day 1 morning, you're blocked. Pester them.
4. **Test with 2 agents first.** Get Scanner + 1 Auditor working end-to-end before adding more agents.
5. **Log everything.** Your console output IS the demo for Day 1–2. Make it readable. Use colors, timestamps, agent labels.
6. **HCS messages are your API.** Person 4 (frontend) subscribes to the same HCS topics. If your messages are malformed, their dashboard breaks.
