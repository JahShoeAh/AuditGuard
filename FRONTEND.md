# AuditGuard Dashboard — Implementation Guide

> **Purpose:** This document specifies every dashboard component, its data sources, store bindings, rendering logic, and styling conventions. An implementation engineer reading this guide should be able to build or modify any component without ambiguity.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Project Structure](#3-project-structure)
4. [State Management (Zustand Store)](#4-state-management-zustand-store)
5. [Event Ingestion Pipeline](#5-event-ingestion-pipeline)
6. [Routing & Page Layout](#6-routing--page-layout)
7. [Core Layout: Dashboard.jsx](#7-core-layout-dashboardjsx)
8. [Header Component](#8-header-component)
9. [Live Feed Tab](#9-live-feed-tab)
   - 9.1 [DiscoveryFeed](#91-discoveryfeed)
   - 9.2 [AuctionFeed](#92-auctionfeed)
   - 9.3 [AuctionCard](#93-auctioncard)
   - 9.4 [BidRow](#94-bidrow)
   - 9.5 [Countdown](#95-countdown)
   - 9.6 [MarketplacePanel](#96-marketplacepanel)
   - 9.7 [MarketplaceListingRow](#97-marketplacelistingrow)
   - 9.8 [PaymentFlow](#98-paymentflow)
   - 9.9 [TransactionExplorer](#99-transactionexplorer)
10. [Agents Tab](#10-agents-tab)
    - 10.1 [AgentLeaderboard](#101-agentleaderboard)
    - 10.2 [AgentLeaderboardRow](#102-agentleaderboardrow)
    - 10.3 [AgentDetail](#103-agentdetail)
    - 10.4 [ReputationComparison](#104-reputationcomparison)
    - 10.5 [ReputationGraph](#105-reputationgraph)
    - 10.6 [StakingChart](#106-stakingchart)
11. [Contracts Tab](#11-contracts-tab)
    - 11.1 [ContractHealth](#111-contracthealth)
    - 11.2 [ContractHealthCard](#112-contracthealthcard)
    - 11.3 [VaultDetail](#113-vaultdetail)
    - 11.4 [AuditJobTracker](#114-auditjobtracker)
    - 11.5 [SubContractTree](#115-subcontracttree)
12. [Analytics Tab](#12-analytics-tab)
    - 12.1 [NetworkGraph](#121-networkgraph)
    - 12.2 [FlowSummary](#122-flowsummary)
    - 12.3 [SettlementTimeline](#123-settlementtimeline)
    - 12.4 [TreasuryEconomics](#124-treasuryeconomics)
    - 12.5 [CompetitionHeatmap](#125-competitionheatmap)
13. [Schedules Tab](#13-schedules-tab)
14. [Activity & Debug Components](#14-activity--debug-components)
    - 14.1 [ActivityTicker](#141-activityticker)
    - 14.2 [ActivityLog](#142-activitylog)
    - 14.3 [DebugPanel](#143-debugpanel)
    - 14.4 [StoryMode](#144-storymode)
15. [Wallet Integration](#15-wallet-integration)
    - 15.1 [Wallet Store](#151-wallet-store)
    - 15.2 [WalletButton](#152-walletbutton)
    - 15.3 [WalletConnectModal](#153-walletconnectmodal)
    - 15.4 [WalletGate](#154-walletgate)
16. [Pages (Routed Views)](#16-pages-routed-views)
    - 16.1 [WelcomeScreen](#161-welcomescreen)
    - 16.2 [StakeDelegation](#162-stakedelegation)
    - 16.3 [AgentRegistration](#163-agentregistration)
    - 16.4 [ReportMarketplace](#164-reportmarketplace)
17. [Custom Hooks Reference](#17-custom-hooks-reference)
18. [Utility Functions Reference](#18-utility-functions-reference)
19. [Styling & Theme Conventions](#19-styling--theme-conventions)
20. [Mock Event System](#20-mock-event-system)
21. [Backend Data Contracts](#21-backend-data-contracts)
22. [GUARD Token Precision](#22-guard-token-precision)
23. [Build & Development](#23-build--development)

---

## 1. Architecture Overview

The dashboard is a **read-heavy** React SPA that visualizes the AuditGuard autonomous audit pipeline in real-time. It consumes data from two sources:

1. **HCS Topics** (Hedera Consensus Service) — polled every 4 seconds via mirror-node REST API
   - Discovery topic (`0.0.7940144`): New contract discoveries
   - AuditLog topic (`0.0.7940145`): Job creation, bid tracking, winner selection, settlements, alerts
   - AgentComms topic (`0.0.7940146`): Agent findings, data listings, sub-auctions

2. **On-chain Contract Events** — polled every 5 seconds via ethers.js `queryFilter`
   - `AuditAuction`: JobPosted, BidSubmitted, WinnersSelected, BidRefunded
   - `AgentRegistry`: AgentRegistered, ReputationUpdated, AgentPromoted
   - `SubAuction`: SubAuctionCreated, SubBidSubmitted, SubContractorSelected, ResultDelivered, ResultAccepted
   - `DataMarketplace`: DataListed, DataPurchased, DataRated
   - `PaymentSettlement`: JobSettled, SubJobSettled
   - `VaultFactory`: VaultCreated, AutoAuditTriggered
   - `StakingManager`: Staked, StakeLocked, StakeUnlocked, SlashInitiated, AppealFiled/Approved/Denied
   - `Treasury`: FeeReceived, FeeDistributed

**All data flows into a single Zustand store**, which components subscribe to via selectors. There is no direct contract reading from components except through the `useContractRead` hook (react-query wrapper).

```
HCS Mirror Node REST API ──┐
                           ├──▶ EventListenerService ──▶ Zustand Store ──▶ React Components
On-chain Contract Events ──┘                                  ▲
                                                              │
Mock Event Generator ─────────────────────────────────────────┘
```

---

## 2. Technology Stack

| Dependency | Version | Purpose |
|---|---|---|
| react | 18.3.1 | UI framework |
| react-dom | 18.3.1 | DOM rendering |
| react-router-dom | 6.30.3 | Client-side routing |
| zustand | 4.5.0 | Global state management |
| @tanstack/react-query | 5.50.0 | Contract read caching + polling |
| ethers | 6.13.0 | EVM provider, contract instances, ABI encoding |
| @hashgraph/sdk | 2.51.0 | Hedera SDK (client init, topic subscriptions) |
| framer-motion | 11.0.0 | Animation (tab transitions, drawers, overlays) |
| react-markdown | 9.1.0 | Markdown rendering (audit reports) |
| date-fns | 3.6.0 | Date formatting |
| tailwindcss | 3.4.0 | Utility-first CSS |
| vite | 5.4.0 | Build tool + dev server |
| vitest | 1.6.0 | Test runner |

---

## 3. Project Structure

```
packages/dashboard/
├── index.html
├── package.json
├── vite.config.js              # @sdk alias → ../sdk
├── tailwind.config.js          # Custom theme + animations
├── postcss.config.js
├── .env.local                  # VITE_HEDERA_NETWORK, VITE_HEDERA_JSON_RPC, VITE_HEDERA_MIRROR_NODE
└── src/
    ├── main.jsx                # React root + QueryClientProvider + BrowserRouter
    ├── App.jsx                 # Re-exports Dashboard
    ├── Dashboard.jsx           # Main layout: Header + TabBar + TabContent + Ticker + Debug
    ├── styles/
    │   └── globals.css         # CSS variables, animations, base styles
    ├── store/
    │   ├── index.js            # useStore — primary Zustand store (all app state)
    │   └── wallet.js           # useWalletStore — wallet connection + balances
    ├── services/
    │   ├── hedera-connection.js # SDK config loader, provider init, contract instances
    │   ├── event-listener.js    # EventListenerService class
    │   ├── mock-events.js       # Deterministic 90-second mock cycle
    │   └── offline-replay.js    # Offline state playback
    ├── hooks/
    │   ├── useConnection.js
    │   ├── useEventListeners.js
    │   ├── useContractRead.js
    │   ├── useContractWrite.js
    │   ├── useAutoScroll.js
    │   ├── useAuctionData.js
    │   ├── useAuditJobs.js
    │   ├── useAgentLeaderboard.js
    │   ├── useContractHealth.js
    │   ├── useGuardFlows.js
    │   ├── useMarketplaceData.js
    │   ├── useCompetitionData.js
    │   ├── useNetworkGraph.js
    │   ├── useSettlementTimeline.js
    │   └── useRequireWallet.js
    ├── utils/
    │   ├── format.js            # fmt.guard(), fmt.address(), fmt.risk(), etc.
    │   └── hashscan.js          # hashscan.transaction(), .account(), .topic(), etc.
    ├── pages/
    │   ├── WelcomeScreen.jsx
    │   ├── StakeDelegation.jsx
    │   ├── AgentRegistration.jsx
    │   └── ReportMarketplace.jsx
    ├── components/
    │   ├── Header.jsx
    │   ├── DebugPanel.jsx
    │   ├── ActivityTicker.jsx
    │   ├── ActivityLog.jsx
    │   ├── StoryMode.jsx
    │   ├── DiscoveryFeed.jsx
    │   ├── AuctionFeed.jsx
    │   ├── AuctionCard.jsx
    │   ├── BidRow.jsx
    │   ├── Countdown.jsx
    │   ├── MarketplacePanel.jsx
    │   ├── MarketplaceListingRow.jsx
    │   ├── DataListingCard.jsx
    │   ├── PaymentFlow.jsx
    │   ├── FlowSummary.jsx
    │   ├── TransactionExplorer.jsx
    │   ├── AgentLeaderboard.jsx
    │   ├── AgentLeaderboardRow.jsx
    │   ├── AgentDetail.jsx
    │   ├── ReputationComparison.jsx
    │   ├── ReputationGraph.jsx
    │   ├── StakingChart.jsx
    │   ├── ContractHealth.jsx
    │   ├── ContractHealthCard.jsx
    │   ├── VaultDetail.jsx
    │   ├── AuditJobTracker.jsx
    │   ├── SubContractTree.jsx
    │   ├── NetworkGraph.jsx
    │   ├── SettlementTimeline.jsx
    │   ├── SettlementDetail.jsx
    │   ├── TreasuryEconomics.jsx
    │   ├── CompetitionHeatmap.jsx
    │   ├── AuditSchedules.jsx
    │   ├── wallet/
    │   │   ├── WalletButton.jsx
    │   │   ├── WalletConnectModal.jsx
    │   │   └── WalletGate.jsx
    │   ├── agent-register/
    │   │   ├── StepIdentity.jsx
    │   │   ├── StepUCP.jsx
    │   │   ├── StepSpecialization.jsx
    │   │   └── StepDeploy.jsx
    │   ├── stake/
    │   │   ├── DelegationPortfolio.jsx
    │   │   ├── DelegationWizard.jsx
    │   │   └── AgentBrowser.jsx
    │   ├── reports/
    │   │   ├── ReportCard.jsx
    │   │   ├── ReportViewer.jsx
    │   │   ├── PurchaseModal.jsx
    │   │   ├── PurchaseHistory.jsx
    │   │   └── reportConstants.js
    │   └── ui/
    │       └── Toast.jsx
    └── __tests__/
        ├── event-listener.test.js
        └── store.test.js
```

---

## 4. State Management (Zustand Store)

**File:** `src/store/index.js`

The store is a **single flat Zustand slice** with ~280 lines. Every piece of application state lives here. Components subscribe to exactly the fields they need via selectors.

### Store Shape

```javascript
{
  // ── Connection ────────────────────────────────────
  isConnected: boolean,        // true after hedera-connection.js succeeds
  connectionError: string|null,
  config: object|null,         // SDK config.json contents (addresses, topics, ABIs)
  contracts: object|null,      // ethers.Contract instances for all 9 contracts
  hederaClient: Client|null,   // @hashgraph/sdk Client
  ethersProvider: JsonRpcProvider|null,

  // ── Mock toggle ───────────────────────────────────
  useMockEvents: boolean,      // When true, mock-events.js generates deterministic events

  // ── Discoveries (HCS Discovery topic) ─────────────
  discoveries: Array<{
    contractAddress: string,   // EVM address of discovered contract
    chain: string,             // "hedera-testnet"
    type: string,              // "vault" | "lending" | "dex" | "bridge" | "staking" | "unknown"
    riskScore: number,         // 0-100
    estimatedLOC: number,
    budget: number,            // GUARD tokens (raw 8-decimal)
    timestamp: number,
    _hcsTimestamp: string,     // consensus timestamp
    _hcsSequence: number,
  }>,                          // Max 100 items, newest first

  // ── Active Jobs (AuditAuction.JobPosted + HCS JOB_CREATED) ──
  activeJobs: {
    [jobId: string]: {
      jobId: string,
      contractAddress: string,
      contractChain: string,
      contractType: string,
      budgetAvailable: bigint|number,
      budgetFormatted: string,      // "100.00 GUARD"
      auctionDeadline: bigint|null,
      initialRiskScore: number,
      lineCount: number,
      postedAt: number,             // Date.now()
      blockNumber: number|null,
    }
  },

  // ── Bids (AuditAuction.BidSubmitted + HCS BID_SUBMITTED) ──
  bids: {
    [jobId: string]: Array<{
      agent: string,                // EVM address
      agentName: string,            // Resolved friendly name or "0x12...ab"
      bidAmount: bigint|number,
      bidFormatted: string,         // "15.00 GUARD"
      collateralLocked: bigint|number,
      reputationAtBid: number,      // 0-100 (not basis points here)
      specialization: string,
      estimatedCompletionTime: number, // seconds
      timestamp: number,
      blockNumber: number|null,
    }>
  },

  // ── Bid Lifecycle (HCS: invite_sent → submitted | skipped | failed) ──
  jobBidStatus: {
    [jobId: string]: Array<{
      status: 'invite_sent' | 'submitted' | 'skipped' | 'failed',
      agentId: string,
      evmAddress: string|null,
      reason: string|null,          // Only for skipped/failed
      timestamp: number,
    }>
  },

  // ── LLM Provider Status (HCS: LLM_PROVIDER_READY/UNHEALTHY) ──
  llmProviderStatus: {
    [agentId: string]: Array<{
      status: 'ready' | 'unhealthy',
      providerAddress: string|null,
      model: string|null,
      endpoint: string|null,
      reason: string|null,
      timestamp: number,
    }>
  },

  // ── LLM Inference Status (HCS: LLM_INFERENCE_STARTED/SUCCEEDED/FAILED) ──
  llmInferenceStatus: {
    [jobId: string]: Array<{
      status: 'started' | 'succeeded' | 'failed',
      agentId: string,
      providerAddress: string|null,
      model: string|null,
      findingsCount: number|null,
      usedFallback: boolean|null,
      requestId: string|null,
      timestamp: number,
    }>
  },

  // ── Winners (AuditAuction.WinnersSelected) ────────
  winners: {
    [jobId: string]: {
      agents: string[],             // EVM addresses of winning agents
      totalEscrowed: bigint,
      totalEscrowedFormatted: string,
      platformFee: bigint,
      platformFeeFormatted: string,
    }
  },

  // ── Agents (AgentRegistry events + HCS AGENT_REGISTERED) ──
  agents: {
    [address: string]: {
      address: string,
      agentId: string,              // e.g., "static-analysis-047"
      ucpEndpoint: string,
      specializations: string[],
      stakedAmount: bigint,
      stakedFormatted: string,
      reputation: number,           // 0-100
      reputationScore: number,      // basis points 0-10000
      status: string,               // "ACTIVE" etc.
      lastSeenAt: number,
    }
  },

  // ── Audit Log (all HCS messages, max 200) ─────────
  auditLog: Array<{
    type: string,                   // "JobPosted", "BidSubmitted", "WinnersSelected", etc.
    source: string,                 // "contract", "discovery", "auditLog", "agentComms"
    jobId: string|undefined,
    timestamp: number,
    _tx: { hash, blockNumber, receivedAt, finalityMs }|undefined,
    // ...additional fields vary by type
  }>,

  // ── Report Metadata (HCS REPORT_METADATA) ────────
  reportMetadata: {
    [jobId: string]: {
      cid: string,                  // IPFS content identifier
      listingId: number|null,       // DataMarketplace listing ID
      contentHash: string,          // Keccak256 of report content
      deployer: string|null,
      agentCount: number,
      findingCount: number,
    }
  },

  // ── Sub-Auctions (SubAuction contract events) ────
  subJobs: {
    [subJobId: string]: {
      subJobId: string,
      parentJobId: string,
      requester: string,
      requesterName: string,
      taskDescription: string,
      requiredSpecialization: string,
      paymentAmount: bigint,
      paymentFormatted: string,
      slaDeadline: bigint,
      auctionDeadline: bigint,
      status: 'OPEN' | 'IN_PROGRESS' | 'DELIVERED' | 'ACCEPTED',
      selectedAgent: string|undefined,
      selectedAgentName: string|undefined,
      agreedPrice: bigint|undefined,
      resultHash: string|undefined,
    }
  },
  subBids: { [subJobId: string]: Array<SubBid> },
  parentSubJobs: { [parentJobId: string]: string[] }, // subJobId[] linkage

  // ── Data Marketplace (DataMarketplace events) ────
  dataListings: {
    [listingId: string]: {
      listingId: string,
      parentJobId: string|null,
      seller: string,
      sellerName: string,
      title: string,
      category: number,             // Enum index: 0=SCAN_REPORT, 3=HOT_LEAD, etc.
      categoryStr: string,          // "SCAN_REPORT", "HOT_LEAD", etc.
      listingType: number,          // 0=ONE_TIME, 1=SUBSCRIPTION, 2=TIP
      listingTypeStr: string,
      price: bigint,
      priceFormatted: string,
      contentHash: string,
      active: boolean,
    }
  },
  dataPurchases: Array<{
    listingId: string,
    buyer: string,
    buyerName: string,
    seller: string,
    sellerName: string,
    pricePaid: bigint,
    pricePaidFormatted: string,
    platformFee: bigint,
    rating: number|undefined,       // 1-5 stars (set by DataRated event)
    timestamp: number,
  }>,
  jobListings: { [parentJobId: string]: string[] }, // listingId[] linkage

  // ── Settlements (PaymentSettlement events) ────────
  settlements: {
    [settlementId: string]: {
      settlementId: string,
      jobId: string,
      totalDisbursed: bigint,
      totalDisbursedFormatted: string,
      platformFee: bigint,
      reportFees: bigint,
      recipientCount: number,
      timestamp: number,
    }
  },
  jobSettlements: { [jobId: string]: string }, // settlementId

  // ── GUARD Flows (constructed from settlement, sub-contract, data purchase events) ──
  guardFlows: Array<{
    from: string,                   // EVM address or "vault"
    fromName: string|undefined,
    to: string,
    toName: string,
    amount: bigint,
    amountFormatted: string,
    type: string,                   // "SETTLEMENT", "SUB_CONTRACT", "DATA_PURCHASE"
    jobId: string|undefined,
    listingId: string|undefined,
    timestamp: number,
  }>,                               // Max 500 items

  // ── Agent Profiles (enriched from StakingManager) ─
  agentProfiles: {
    [address: string]: {
      totalStaked: bigint,
      lockedStake: bigint,
      availableStake: bigint,
      unbondingAmount: bigint,
      status: string,
    }
  },

  // ── Reputation History (for sparklines/graphs) ────
  reputationHistory: {
    [address: string]: Array<{
      timestamp: number,
      reputation: number,
      delta: number,
      jobId: string|undefined,
    }>                              // Max 50 snapshots per agent
  },

  // ── Contract Health (VaultFactory polling) ────────
  contractHealth: {
    [address: string]: {
      securityScore: number,
      balance: bigint,
      reauditStatus: string,
      lastAuditTimestamp: number,
      monitoringActive: boolean,
    }
  },

  // ── Slash Events (StakingManager) ─────────────────
  slashEvents: Array<{
    slashId: string,
    agent: string,
    agentName: string,
    reason: number,
    reasonStr: string,              // "FALSE_POSITIVE", "SLA_VIOLATION", etc.
    slashedAmount: bigint,
    slashedAmountFormatted: string,
    slashBasisPoints: number,
    jobId: string,
    appealStatus: string,           // "NONE", "PENDING", "APPROVED", "DENIED"
    timestamp: number,
  }>,                               // Max 50 items

  // ── Treasury (FeeReceived/FeeDistributed events) ──
  treasuryRevenue: {
    total: number,
    auditFees: number,
    marketplaceFees: number,
    reportFees: number,
    slashingProceeds: number,
    subAuctionFees: number,
  },
  treasuryDistributions: Array<{
    distributionId: string,
    totalDistributed: string,
    ucpAmount: string,
    reserveAmount: string,
    burnAmount: string,
    timestamp: number,
  }>,

  // ── UI State ──────────────────────────────────────
  activeTab: 'liveFeed' | 'agents' | 'contracts' | 'analytics' | 'schedules',
  selectedAgent: string|null,       // EVM address
  selectedContract: string|null,    // EVM address

  // ── Stake History (for StakingChart) ──────────────
  stakeHistory: {
    [address: string]: Array<{
      timestamp: number,
      totalStaked: number,
      lockedStake: number,
      availableStake: number,
      event: string,
      jobId: string|undefined,
    }>                              // Max 50 snapshots
  },

  // ── HSS Schedule Events ───────────────────────────
  hssEvents: Array<{
    type: string,                   // "AuditScheduled", "AuditTriggered", "AuditScheduleCancelled"
    contractAddress: string,
    timestamp: number,
    // ...varies by type
  }>,                               // Max 500 items

  // ── Live Stats (counters) ─────────────────────────
  stats: {
    totalDiscoveries: number,
    totalAuctions: number,
    totalBids: number,
    guardTransacted: number,
    totalSubAuctions: number,
    totalDataSales: number,
    totalSettlements: number,
    totalGuardTransacted: number,
  },
}
```

### Store Actions

| Action | Signature | Behavior |
|---|---|---|
| `setConnected` | `(config, contracts, hederaClient, ethersProvider)` | Sets `isConnected: true`, clears error |
| `setConnectionError` | `(error: string)` | Sets `isConnected: false` |
| `toggleMockEvents` | `()` | Flips `useMockEvents` boolean |
| `addDiscovery` | `(discovery)` | Prepends to array, caps at 100 |
| `setJob` | `(jobId, job)` | Upserts into `activeJobs` map |
| `addBid` | `(jobId, bid)` | Appends to `bids[jobId]` array |
| `addJobBidStatus` | `(jobId, status)` | Prepends to `jobBidStatus[jobId]`, caps at 100 |
| `setWinners` | `(jobId, winnersObj)` | Sets `winners[jobId]` |
| `setAgent` | `(address, profile)` | Upserts into `agents` map |
| `addLogEntry` | `(entry)` | Prepends to `auditLog`, caps at 200 |
| `addReportMetadata` | `(jobId, meta)` | Sets `reportMetadata[jobId]` |
| `addSubJob` | `(subJob)` | Adds to `subJobs` + `parentSubJobs` linkage |
| `addSubBid` | `(subJobId, bid)` | Appends to `subBids[subJobId]` |
| `updateSubJobStatus` | `(subJobId, updates)` | Merges updates into existing sub-job |
| `addDataListing` | `(listing)` | Adds to `dataListings` + `jobListings` linkage |
| `addDataPurchase` | `(purchase)` | Prepends to array, caps at 100 |
| `addSettlement` | `(settlement)` | Adds to `settlements` + `jobSettlements` linkage |
| `addGuardFlow` | `(flow)` | Prepends to array, caps at 500 |
| `incrementStat` | `(key, amount=1)` | Increments `stats[key]` by amount |
| `setAgentProfile` | `(addr, profile)` | Upserts enriched profile |
| `addReputationSnapshot` | `(addr, snapshot)` | Appends to history, caps at 50 |
| `setContractHealth` | `(addr, health)` | Upserts health data |
| `addSlashEvent` | `(slash)` | Prepends, caps at 50 |
| `addTreasuryRevenue` | `(source, amount)` | Adds to correct revenue category |
| `addTreasuryDistribution` | `(dist)` | Prepends, caps at 50 |
| `setActiveTab` | `(tab)` | Sets UI tab |
| `setSelectedAgent` | `(addr)` | Sets selected agent for detail panel |
| `setSelectedContract` | `(addr)` | Sets selected contract for detail panel |
| `updateAgentStake` | `(addr, newTotal)` | Updates `agents[addr].stakedAmount` |
| `addStakeSnapshot` | `(addr, snapshot)` | Appends, caps at 50 |
| `addHssEvent` | `(ev)` | Prepends, caps at 500 |
| `resetAll` | `()` | Clears all data state, preserves `useMockEvents` |

### Pattern: Store Selectors

Components subscribe to minimal slices to avoid unnecessary re-renders:

```jsx
// GOOD — subscribes only to discoveries array
const discoveries = useStore((s) => s.discoveries);

// GOOD — subscribes to multiple related fields via object
const { activeJobs, bids, winners } = useStore((s) => ({
  activeJobs: s.activeJobs,
  bids: s.bids,
  winners: s.winners,
}));

// BAD — subscribes to entire store (re-renders on every change)
const store = useStore();
```

---

## 5. Event Ingestion Pipeline

**File:** `src/services/event-listener.js`

### Class: `EventListenerService`

**Constructor parameters:**
- `config` — SDK config.json contents (contract addresses, HCS topic IDs, seededAgents)
- `contracts` — Object of ethers.Contract instances for all 9 contracts
- `store` — Zustand store actions (bound via `useStore.getState()`)
- `provider` — `ethers.JsonRpcProvider`

### Initialization Flow

```
useConnection() hook
  → initializeConnection() (hedera-connection.js)
    → loads @sdk/config.json
    → creates ethers.JsonRpcProvider(VITE_HEDERA_JSON_RPC)
    → creates Contract instances for all 9 contracts using ABIs from config
    → stores in Zustand: setConnected(config, contracts, hederaClient, provider)

useEventListeners(connection) hook
  → if useMockEvents: startMockEventStream()
  → else if contracts exist: new EventListenerService(...).startAll()
    → startHCSPolling() — 3 interval timers at 4s
    → startContractEventPolling() — 1 interval timer at 5s
    → _syncHistoricalAgents() — one-time backfill of AgentRegistered events
```

### HCS Polling Mechanism

Each HCS topic is polled independently every 4 seconds:

```
GET {MIRROR_NODE}/api/v1/topics/{topicId}/messages?order=desc&limit=100
  → filter messages with sequence_number > lastSeq[topicKey]
  → sort ascending by sequence_number
  → decode base64 message → JSON parse
  → route via _routeHCSMessage(topicKey, msg)
```

### HCS Message Routing

The `_routeHCSMessage` method dispatches based on `topicKey` and `parsedData.type`:

| Topic | Message Type | Store Actions |
|---|---|---|
| discovery | `CONTRACT_DISCOVERED` | `addDiscovery`, `incrementStat('totalDiscoveries')`, `addLogEntry` |
| auditLog | `JOB_CREATED` | `setJob`, `incrementStat('totalAuctions')` |
| auditLog | `BID_SUBMITTED` | `addBid`, `addJobBidStatus(submitted)`, `incrementStat('totalBids')` |
| auditLog | `BID_SKIPPED` | `addJobBidStatus(skipped)` |
| auditLog | `BID_SUBMISSION_FAILED` | `addJobBidStatus(failed)` |
| auditLog | `AUCTION_INVITE_SUMMARY` | `addJobBidStatus(invite_sent)` per eligible agent |
| auditLog | `AGENT_REGISTERED` | `setAgent` |
| auditLog | `REPORT_METADATA` | `addReportMetadata`, `addLogEntry(REPORT_PUBLISHED)` |
| auditLog | `LLM_PROVIDER_READY` | `setLlmProviderStatus(ready)` |
| auditLog | `LLM_PROVIDER_UNHEALTHY` | `setLlmProviderStatus(unhealthy)` |
| auditLog | `LLM_INFERENCE_STARTED` | `addLlmInferenceStatus(started)` |
| auditLog | `LLM_INFERENCE_SUCCEEDED` | `addLlmInferenceStatus(succeeded)` |
| auditLog | `LLM_INFERENCE_FAILED` | `addLlmInferenceStatus(failed)` |
| agentComms | (all) | `addLogEntry` (generic) |

### Contract Event Polling

Every 5 seconds, queries all 9 contracts for events from `lastProcessedBlock+1` to `currentBlock`:

```javascript
const q = (contract, event) =>
  contract ? contract.queryFilter(event, from, to).catch(() => []) : Promise.resolve([]);

const [jobPosted, bidSubmitted, winnersSelected, ...] = await Promise.all([
  q(auctionContract, 'JobPosted'),
  q(auctionContract, 'BidSubmitted'),
  q(auctionContract, 'WinnersSelected'),
  // ... 25 total parallel queries
]);
```

Each event type maps to specific store actions. Notable processing:

- **JobSettled**: After adding to store, fetches `getSettlementPayments(settlementId)` to emit individual GUARD flows per recipient.
- **ResultAccepted**: Looks up stored sub-job to create GUARD flow from requester to contractor.
- **DataPurchased**: Creates GUARD flow from buyer to seller.
- **SlashInitiated**: Resolves reason enum to string (`SLASH_REASONS` array).

### TEST_MODE Filtering

When `VITE_TEST_MODE=true`:
- Discoveries are filtered to only contracts in `config.testContracts`
- Each test contract address is shown only once (deduplication via `seenTestDiscoveries` set)
- Historical HCS messages are skipped on first poll (jumps cursor to latest)
- Contract event backfill starts from current block (not -100)

---

## 6. Routing & Page Layout

**File:** `src/main.jsx`

```jsx
<QueryClientProvider client={queryClient}>
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<WelcomeScreen />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/dashboard/stake" element={<StakeDelegation />} />
      <Route path="/dashboard/agents/register" element={<AgentRegistration />} />
      <Route path="/dashboard/reports" element={<ReportMarketplace />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  </BrowserRouter>
</QueryClientProvider>
```

The `Bootstrap` component wraps the router and initializes:
- `useConnection()` — establishes Hedera connection
- `useEventListeners()` — starts live or mock event ingestion

---

## 7. Core Layout: Dashboard.jsx

**File:** `src/Dashboard.jsx`

The main dashboard is a **full-viewport flex column** with 5 tab-switched content areas:

```
┌─────────────────────────────────────────────────┐
│ Header (fixed height)                           │
├─────────────────────────────────────────────────┤
│ StoryMode overlay (when active)                 │
├─────────────────────────────────────────────────┤
│ ErrorBanner (connection errors, conditional)    │
├─────────────────────────────────────────────────┤
│ TabBar + "STORY MODE" toggle button             │
├─────────────────────────────────────────────────┤
│                                                 │
│ Tab Content (flex-1, overflow auto)             │
│   - liveFeed | agents | contracts |             │
│     analytics | schedules                       │
│                                                 │
├─────────────────────────────────────────────────┤
│ ActivityTicker (fixed bottom bar)               │
├─────────────────────────────────────────────────┤
│ DebugPanel (Ctrl+D overlay, hidden by default)  │
└─────────────────────────────────────────────────┘
```

### Tab Definitions

```javascript
const TABS = [
  { key: 'liveFeed',  label: 'LIVE FEED',  icon: '◉' },
  { key: 'agents',    label: 'AGENTS',     icon: '👤' },
  { key: 'contracts', label: 'CONTRACTS',  icon: '🛡' },
  { key: 'analytics', label: 'ANALYTICS',  icon: '📊' },
  { key: 'schedules', label: 'SCHEDULES',  icon: '⏱' },
];
```

Tab switching uses `AnimatePresence mode="wait"` for cross-fade animations (0.2s opacity).

### Store Bindings

```javascript
const connectionError = useStore((s) => s.connectionError);
const activeTab = useStore((s) => s.activeTab);
const setActiveTab = useStore((s) => s.setActiveTab);
```

---

## 8. Header Component

**File:** `src/components/Header.jsx`

Displays at the top of every dashboard view:
- **Left:** AuditGuard logo + network status badge (testnet/mainnet)
- **Center:** Live stat counters from `useStore.stats`
- **Right:** Mock events toggle switch + wallet button

### Store Bindings

```javascript
const isConnected = useStore((s) => s.isConnected);
const useMockEvents = useStore((s) => s.useMockEvents);
const toggleMockEvents = useStore((s) => s.toggleMockEvents);
const stats = useStore((s) => s.stats);
```

### Stats Displayed

| Stat Key | Label | Example |
|---|---|---|
| `totalDiscoveries` | Discoveries | 47 |
| `totalAuctions` | Auctions | 12 |
| `totalBids` | Bids | 36 |
| `totalSettlements` | Settled | 8 |
| `totalGuardTransacted` | GUARD Transacted | 1,250.00 |

### Mock Toggle

A switch that calls `toggleMockEvents()`. When active, `useEventListeners` stops live polling and starts `startMockEventStream()`. The toggle has a cyan glow when active.

---

## 9. Live Feed Tab

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│ ┌──────────┐  ┌───────────────────┐  ┌────────────────┐ │
│ │Discovery │  │   AuctionFeed     │  │ Marketplace    │ │
│ │Feed      │  │   (45% width)     │  │ Panel          │ │
│ │(25% w)   │  │                   │  │ (flex-1)       │ │
│ │          │  │                   │  │                │ │
│ └──────────┘  └───────────────────┘  └────────────────┘ │
│ ┌────────────────────────────┐ ┌───────────────────────┐ │
│ │ PaymentFlow (55%)          │ │ TransactionExplorer   │ │
│ │ (28vh height)              │ │ (flex-1)              │ │
│ └────────────────────────────┘ └───────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- DiscoveryFeed hidden on screens < `lg`
- MarketplacePanel hidden on screens < `xl`
- PaymentFlow + TransactionExplorer in bottom row at 28vh height

### 9.1 DiscoveryFeed

**File:** `src/components/DiscoveryFeed.jsx`

Displays a scrollable list of recently discovered contracts.

**Store bindings:**
```javascript
const discoveries = useStore((s) => s.discoveries);
```

**Hook:** `useAutoScroll(discoveries)` — auto-scrolls to top (newest first) when new items arrive; pauses if user scrolls manually.

**Rendering per discovery item:**
- Contract address (shortened via `fmt.address`)
- Contract type badge (color-coded)
- Risk score with `fmt.risk()` — returns `{ text, color }` based on thresholds
- Line count via `fmt.lineCount()`
- Relative time via `fmt.relativeTime()`
- HashScan link via `hashscan.contract(address)`

**Risk score color thresholds:**
- 0–30: green (`#10B981`)
- 31–60: amber (`#F59E0B`)
- 61–80: orange (`#F97316`)
- 81–100: red (`#EF4444`)

**Empty state:** "Waiting for contract discoveries..." with a subtle pulse animation.

### 9.2 AuctionFeed

**File:** `src/components/AuctionFeed.jsx`

Displays active audit jobs with their bids and winner status.

**Hook:** `useAuctionData()` which:
1. Reads `activeJobs`, `bids`, `winners` from store
2. Optionally polls `AuditAuction.getActiveJobs()` via `useContractRead` (10s interval)
3. Merges store + on-chain data, deduplicates by jobId
4. Sorts: active jobs first (no winners), then by jobId descending

**Returns:** `{ auctions, isLoading }`

**Each auction item:** Renders an `<AuctionCard>` component.

**Auto-scroll:** Uses `useAutoScroll(auctions)`.

### 9.3 AuctionCard

**File:** `src/components/AuctionCard.jsx`

Displays a single auction job with all its metadata and bids.

**Props:** `{ auction }` — merged job object from `useAuctionData`

**Sections:**
1. **Header:** Job ID badge + contract type + risk score
2. **Contract address:** Shortened, with HashScan link
3. **Budget:** Formatted GUARD amount
4. **Countdown timer:** `<Countdown deadline={auction.auctionDeadline} />` (only shown if auction still open)
5. **Bid list:** Renders `<BidRow>` for each bid in `bids[jobId]`
6. **Winners section:** If `winners[jobId]` exists, shows winner addresses with escrowed total

**Store bindings (read from auction object):**
```javascript
const jobBids = useStore((s) => s.bids[auction.jobId] || []);
const jobWinners = useStore((s) => s.winners[auction.jobId]);
```

**Status badge colors:**
- No winners: amber pulsing "BIDDING"
- Winners selected: green "AUDITING"
- Settled: cyan "COMPLETED"

### 9.4 BidRow

**File:** `src/components/BidRow.jsx`

A single bid entry within an AuctionCard.

**Props:** `{ bid, isWinner }`

**Displays:**
- Agent name (resolved) with color accent based on agent type
- Bid amount (GUARD formatted)
- Reputation score at time of bid
- Estimated completion time via `fmt.duration()`
- Specialization badge
- Winner indicator (checkmark icon if `isWinner`)

**Agent accent colors (from mock system, but applied consistently):**
- StaticAnalysis: cyan (`#06B6D4`)
- Fuzzer: purple (`#8B5CF6`)
- LLMContextual: amber (`#F59E0B`)
- DependencyAgent: orange (`#F97316`)

### 9.5 Countdown

**File:** `src/components/Countdown.jsx`

Real-time countdown timer for auction deadlines.

**Props:** `{ deadline }` — Unix timestamp (seconds or BigInt)

**Implementation:** Uses `useState` + `useEffect` with 1-second `setInterval`. Calculates remaining seconds, displays as `MM:SS` or `HH:MM:SS`.

**Visual states:**
- `> 30s remaining`: normal white text
- `10-30s remaining`: amber text with pulse
- `< 10s remaining`: red text with fast pulse
- `0s (expired)`: "CLOSED" badge in red

### 9.6 MarketplacePanel

**File:** `src/components/MarketplacePanel.jsx`

Right panel showing data listings and recent purchases.

**Hook:** `useMarketplaceData()` which:
1. Reads `dataListings`, `dataPurchases` from store
2. Polls `DataMarketplace.getActiveListings()` via `useContractRead` (15s)
3. Filters by optional category
4. Counts per category for badge display

**Layout:**
- **Top section:** Category filter tabs (All, Scan Reports, Hot Leads, etc.) with count badges
- **Middle section:** Active listings as `<MarketplaceListingRow>` items
- **Bottom section:** "Recent Purchases" list

### 9.7 MarketplaceListingRow

**File:** `src/components/MarketplaceListingRow.jsx`

A single data listing in the marketplace panel.

**Props:** `{ listing }`

**Displays:**
- Title
- Category badge (color-coded: HOT_LEAD=red, SCAN_REPORT=cyan, DEPENDENCY_ANALYSIS=purple)
- Listing type badge (ONE_TIME, SUBSCRIPTION, TIP)
- Price in GUARD
- Seller name (resolved)
- Buyer count
- Average rating (stars)

**Category colors:**
```javascript
{
  SCAN_REPORT: '#06B6D4',         // cyan
  DEPENDENCY_ANALYSIS: '#8B5CF6', // purple
  EXPLOIT_DATABASE: '#EF4444',    // red
  HOT_LEAD: '#F59E0B',           // amber
  FUZZING_SEEDS: '#10B981',      // green
  THREAT_INTEL: '#F97316',       // orange
  AUDIT_FINDING: '#06B6D4',      // cyan (same as scan)
}
```

### 9.8 PaymentFlow

**File:** `src/components/PaymentFlow.jsx`

Visualizes GUARD token flows between agents as an animated diagram.

**Hook:** `useGuardFlows(windowSeconds = 120)` which:
1. Reads `guardFlows`, `stats`, `config` from store
2. Filters flows within `windowSeconds` (last 2 minutes)
3. Builds `agentNodes` from `config.seededAgents` + any unknown addresses in flows
4. Maps flow `type` to hex color for visualization
5. Returns `{ recentFlows, agentNodes, totalTransacted, flowsByType }`

**Visualization:** Renders agent nodes in a horizontal layout with animated flow lines between them. Each flow line has:
- Color based on type (settlement=green, sub-contract=purple, data-purchase=amber)
- Animated dash pattern showing direction
- Label with formatted GUARD amount

**Right panel:** `<FlowSummary>` showing aggregate stats for the window.

### 9.9 TransactionExplorer

**File:** `src/components/TransactionExplorer.jsx`

Scrollable audit log display, typically shown in a drawer or bottom-right panel.

**Store bindings:**
```javascript
const auditLog = useStore((s) => s.auditLog);
```

**Features:**
- Filter by type: ALL, AUCTIONS, AGENTS, DATA, SYSTEM
- Each log entry shows:
  - Type badge (color-coded)
  - Timestamp via `fmt.timestamp()`
  - Description (varies by entry type)
  - HashScan link if `_tx.hash` exists
- Auto-scroll via `useAutoScroll(auditLog)`
- Maximum 200 entries

**Type badge colors:**
- JobPosted: amber
- BidSubmitted: cyan
- WinnersSelected: green
- BID_SKIPPED: gray
- BID_SUBMISSION_FAILED: red
- SLASH_INITIATED: red
- JOB_SETTLED: green
- DATA_LISTED / DATA_PURCHASED: purple
- LLM_INFERENCE_*: amber
- REPORT_PUBLISHED: cyan

---

## 10. Agents Tab

**Layout:**
```
┌──────────────────────────────────────────────────┐
│ [📈 Compare Agents] toggle button (top-right)   │
├──────────────────────────────────────────────────┤
│ ReputationComparison (expandable, animated)      │
├──────────────────────────────────────────────────┤
│ ┌────────────────────────┐ ┌───────────────────┐ │
│ │ AgentLeaderboard       │ │ AgentDetail       │ │
│ │ (60% width)            │ │ (40% width)       │ │
│ │                        │ │                   │ │
│ └────────────────────────┘ └───────────────────┘ │
└──────────────────────────────────────────────────┘
```

### 10.1 AgentLeaderboard

**File:** `src/components/AgentLeaderboard.jsx`

Master list of all registered agents, sorted by reputation.

**Hook:** `useAgentLeaderboard()` which:
1. Reads `agents`, `agentProfiles`, `reputationHistory` from store
2. When live + has `stakingManagerContract`:
   - Polls `getAgentStakeHealth()` every 15s
   - Polls `getDiscountEligibility()` per agent
3. Sorts by `reputationScore` descending
4. Returns `{ agents: EnrichedAgent[], isLoading }`

**EnrichedAgent shape:**
```javascript
{
  address: string,
  agentId: string,
  reputation: number,        // 0-100
  reputationScore: number,   // 0-10000 (basis points)
  tier: string,              // "COMMODITY" | "SPECIALIZED" | "PREMIUM"
  stakedAmount: bigint,
  stakedFormatted: string,
  status: string,
  specializations: string[],
  completedJobs: number,
  sparklineData: number[],   // last 10 reputation snapshots
}
```

**Layout:** Split 60/40:
- Left: Scrollable `<AgentLeaderboardRow>` list with rank numbers
- Right: `<AgentDetail>` for `selectedAgent`

**Selection:** Clicking a row calls `setSelectedAgent(address)`.

### 10.2 AgentLeaderboardRow

**File:** `src/components/AgentLeaderboardRow.jsx`

**Props:** `{ agent, rank, isSelected, onSelect }`

**Displays:**
- Rank number (#1, #2, etc.)
- Agent name (agentId)
- Tier badge (color-coded):
  - COMMODITY: gray
  - SPECIALIZED: cyan
  - PREMIUM: amber/gold
- Reputation score (formatted as XX.XX)
- Staked amount (GUARD formatted)
- Mini sparkline (last 10 reputation snapshots as inline SVG polyline)
- Status dot (green=ACTIVE, red=SUSPENDED, gray=INACTIVE)

**Flash animation:** When the agent's reputation changes (via store update), the row briefly flashes the row background:
- Positive delta: green flash
- Negative delta: red flash

**Slash indicator:** When `slashEvents` contains an event for this agent, shows a red exclamation icon with tooltip.

### 10.3 AgentDetail

**File:** `src/components/AgentDetail.jsx`

iNFT-style profile card for the selected agent.

**Store bindings:**
```javascript
const selectedAgent = useStore((s) => s.selectedAgent);
const agent = useStore((s) => s.agents[s.selectedAgent]);
const profile = useStore((s) => s.agentProfiles[s.selectedAgent]);
const repHistory = useStore((s) => s.reputationHistory[s.selectedAgent] || []);
const stakeHist = useStore((s) => s.stakeHistory[s.selectedAgent] || []);
```

**Sections:**
1. **Identity header:** Agent name, address (HashScan link), tier badge, status dot
2. **Stats grid (2x3):**
   - Reputation (with delta indicator)
   - Staked GUARD (total / locked / available)
   - Completed jobs count
   - Win rate percentage
   - Successful findings
   - False positive rate
3. **Reputation history chart:** `<ReputationGraph>` (inline SVG line chart)
4. **Staking chart:** `<StakingChart>` (inline SVG stacked area)
5. **Recent activity:** Last 5 audit log entries for this agent

**Empty state:** "Select an agent from the leaderboard" centered text.

### 10.4 ReputationComparison

**File:** `src/components/ReputationComparison.jsx`

Multi-agent reputation line chart with togglable legend.

**Store bindings:**
```javascript
const agents = useStore((s) => s.agents);
const reputationHistory = useStore((s) => s.reputationHistory);
```

**Implementation:**
- Renders an inline SVG with one polyline per agent
- Each agent has a unique color (cycling through accent palette)
- Legend below chart with clickable agent names to toggle visibility
- X-axis: time (auto-scaled to data range)
- Y-axis: reputation 0-100

**Agent colors (cycle):**
```javascript
['#06B6D4', '#F59E0B', '#8B5CF6', '#10B981', '#F97316', '#EF4444']
```

### 10.5 ReputationGraph

**File:** `src/components/ReputationGraph.jsx`

Single-agent reputation history with event markers.

**Props:** `{ address }` or reads from `selectedAgent`

**Store bindings:**
```javascript
const history = useStore((s) => s.reputationHistory[address] || []);
```

**Implementation:**
- Inline SVG line chart
- Points where `delta !== 0` get a circle marker
- Green circles for positive deltas, red for negative
- Hover tooltip shows: timestamp, delta, job ID

### 10.6 StakingChart

**File:** `src/components/StakingChart.jsx`

Stacked area chart showing total vs locked stake over time.

**Props:** `{ address }`

**Store bindings:**
```javascript
const history = useStore((s) => s.stakeHistory[address] || []);
```

**Implementation:**
- Inline SVG with two stacked areas:
  - Bottom (green): `availableStake`
  - Top (amber): `lockedStake`
- Total line on top
- Event markers (circles) at stake change points with event type label

---

## 11. Contracts Tab

**Layout:**
```
┌──────────────────────────────────────────────────┐
│ ┌────────────────────────┐ ┌───────────────────┐ │
│ │ ContractHealth Grid    │ │ VaultDetail       │ │
│ │ (60% width)            │ │ (40% width)       │ │
│ │ ┌──────┐ ┌──────┐     │ │                   │ │
│ │ │Card  │ │Card  │     │ │                   │ │
│ │ └──────┘ └──────┘     │ │                   │ │
│ │ ┌──────┐ ┌──────┐     │ │                   │ │
│ │ │Card  │ │Card  │     │ │                   │ │
│ │ └──────┘ └──────┘     │ │                   │ │
│ └────────────────────────┘ └───────────────────┘ │
├──────────────────────────────────────────────────┤
│ AuditJobTracker (horizontal scrollable timeline) │
└──────────────────────────────────────────────────┘
```

### 11.1 ContractHealth

**File:** `src/components/ContractHealth.jsx`

Container component showing grid of vault health cards.

**Hook:** `useContractHealth()` which:
1. Reads `contractHealth`, `discoveries` from store
2. When live + has `vaultFactoryContract`:
   - Polls `getAllVaults()` every 20s
   - For each vault, calls `getVaultSummary()` → security score, balance, reaudit status
   - Stores via `setContractHealth(addr, health)`
3. Returns `{ contracts: HealthData[], isLoading }`

**Layout:** CSS Grid (auto-fill, min 280px) on left 60%, `<VaultDetail>` on right 40%.

**Selection:** Clicking a card calls `setSelectedContract(address)`.

### 11.2 ContractHealthCard

**File:** `src/components/ContractHealthCard.jsx`

**Props:** `{ contract, isSelected, onSelect }`

**Displays:**
- Contract address (shortened) + HashScan link
- Security score as circular progress indicator:
  - 0-40: red ring
  - 41-70: amber ring
  - 71-100: green ring
- Balance (GUARD or HBAR formatted)
- Monitoring status badge (ACTIVE/INACTIVE)
- Re-audit status (PENDING/SCHEDULED/NONE)
- Last audit timestamp (relative)

**Hover:** Subtle border glow matching security score color.

### 11.3 VaultDetail

**File:** `src/components/VaultDetail.jsx`

Right detail panel for selected contract.

**Store bindings:**
```javascript
const selected = useStore((s) => s.selectedContract);
const health = useStore((s) => s.contractHealth[s.selectedContract]);
const discoveries = useStore((s) => s.discoveries);
```

**Sections:**
1. **Header:** Contract address, chain, type, HashScan link
2. **Health stats:** Security score, balance, monitoring status
3. **Audit history:** List of past audits (from discoveries matching this address)
4. **Sub-contract tree:** `<SubContractTree>` showing parent/child job relationships

**Empty state:** "Select a contract from the grid" centered text.

### 11.4 AuditJobTracker

**File:** `src/components/AuditJobTracker.jsx`

Horizontal scrollable timeline showing audit job lifecycle stages.

**Hook:** `useAuditJobs()` which:
1. Combines `activeJobs`, `bids`, `winners`, `subJobs`, `settlements`, `discoveries`, `agents`
2. Builds state machine per job:
   - `AUCTION_OPEN` → bids incoming
   - `BIDDING_CLOSED` → winners being selected
   - `AUDITING_IN_PROGRESS` → agents working
   - `REPORT_PENDING` → findings submitted, report aggregating
   - `COMPLETED` → settlement done
3. Resolves winner names from `agents` store
4. Returns sorted array (newest first)

**Rendering:** Each job is a horizontal card with:
- Stage indicator (colored dots in a line)
- Current stage highlighted
- Job ID + contract address
- Winner agents listed
- Time elapsed in current stage

### 11.5 SubContractTree

**File:** `src/components/SubContractTree.jsx`

Expandable tree showing sub-auctions and data listings related to a parent job.

**Store bindings:**
```javascript
const parentSubJobs = useStore((s) => s.parentSubJobs[parentJobId] || []);
const subJobs = useStore((s) => s.subJobs);
const subBids = useStore((s) => s.subBids);
const jobListings = useStore((s) => s.jobListings[parentJobId] || []);
const dataListings = useStore((s) => s.dataListings);
```

**Tree structure:**
```
Job #5
├── SubAuction #1 (dependency_analysis)
│   ├── Bid: DependencyAgent-8 — 2.55 GUARD
│   └── Status: ACCEPTED ✓
├── DataListing #3 (SCAN_REPORT — 0.50 GUARD)
│   └── Purchased by: Fuzzer-12
└── DataListing #7 (HOT_LEAD — 0.10 GUARD)
```

**Expand/collapse:** Click parent job to toggle children visibility with Framer Motion height animation.

---

## 12. Analytics Tab

**Sub-tabs:**
```javascript
const ANALYTICS_TABS = [
  { key: 'network',     label: 'Network Graph',      icon: '◈' },
  { key: 'timeline',    label: 'Settlement Timeline', icon: '▬' },
  { key: 'competition', label: 'Competition Map',     icon: '⬡' },
];
```

### 12.1 NetworkGraph

**File:** `src/components/NetworkGraph.jsx`

Force-directed graph visualization of GUARD flows between agents.

**Hook:** `useNetworkGraph()` which extends `useGuardFlows()`:
1. Builds nodes from `config.seededAgents` + any unknown addresses in flows
2. Builds edges from `guardFlows` (aggregated by from→to pair)
3. Applies force-directed layout (D3-style spring physics simulation)
4. Returns `{ nodes, edges, simulation }`

**Node shape:**
```javascript
{
  id: string,        // EVM address
  label: string,     // Agent name
  x: number,
  y: number,
  radius: number,    // Based on total GUARD transacted
  color: string,     // Agent accent color
}
```

**Edge shape:**
```javascript
{
  source: string,    // from node id
  target: string,    // to node id
  weight: number,    // Total GUARD amount (aggregated)
  color: string,     // Flow type color
  label: string,     // "15.00 GUARD"
}
```

**Rendering:** Inline SVG with:
- Circular nodes with labels
- Curved edges with arrowheads
- Edge labels (GUARD amount)
- Animated dash pattern on edges
- Hover: Highlight connected edges + tooltip with details
- Node drag: Updates position in simulation

**Layout physics:**
- Center gravity force
- Node repulsion (charge)
- Edge spring force (proportional to weight)
- Collision detection (minimum distance = node radius × 2)

### 12.2 FlowSummary

**File:** `src/components/FlowSummary.jsx`

Side panel showing aggregated GUARD flow statistics for the last 10 minutes.

**Hook:** `useGuardFlows(600)` — 10-minute window

**Displays:**
- Total GUARD transacted
- Flow count
- Breakdown by type (settlement, sub-contract, data purchase)
- Top 5 flows by amount
- HashScan links for each flow's transaction

### 12.3 SettlementTimeline

**File:** `src/components/SettlementTimeline.jsx`

Stacked bar chart of settlement history over time + stats sidebar.

**Hook:** `useSettlementTimeline()` which:
1. Reads `settlements`, `jobSettlements` from store
2. Groups settlements into time buckets (5-minute intervals)
3. Stacks: base payment, bonus, platform fee, report fees
4. Calculates aggregate stats: total disbursed, average per job, largest settlement
5. Returns `{ buckets, stats, settlements }`

**Rendering:**
- **Left (70%):** SVG bar chart with stacked segments per bucket
  - Green: base payments
  - Cyan: bonuses
  - Amber: platform fees
  - Purple: report fees
- **Right (30%):** Stats sidebar:
  - Total GUARD disbursed
  - Settlement count
  - Average per settlement
  - Largest single settlement
  - Platform fees collected

### 12.4 TreasuryEconomics

**File:** `src/components/TreasuryEconomics.jsx`

Donut chart of revenue sources + distribution breakdown.

**Store bindings:**
```javascript
const treasuryRevenue = useStore((s) => s.treasuryRevenue);
const treasuryDistributions = useStore((s) => s.treasuryDistributions);
```

**Left panel — Revenue donut:**
- Segments: auditFees, marketplaceFees, reportFees, slashingProceeds, subAuctionFees
- Colors: green, purple, cyan, red, amber
- Center: Total revenue number

**Revenue source breakdown:**
| Source | Color | Description |
|---|---|---|
| auditFees | green | 5% platform fee from job settlements |
| marketplaceFees | purple | Fee from DataMarketplace purchases |
| reportFees | cyan | 0.05-0.10 GUARD per agent per report |
| slashingProceeds | red | Slashed stake goes to treasury |
| subAuctionFees | amber | Fee from sub-auction settlements |

**Right panel — Distribution history:**
- List of `treasuryDistributions` (newest first)
- Each shows: total, UCP allocation, reserve, burn amount
- Distribution ID with timestamp

### 12.5 CompetitionHeatmap

**File:** `src/components/CompetitionHeatmap.jsx`

Agent vs contract type heatmap showing win rates.

**Hook:** `useCompetitionData()` which:
1. Reads `agents`, `activeJobs`, `bids`, `winners` from store
2. Builds matrix: rows = agents, columns = contract types
3. For each cell: calculates win rate (wins / bids) for that agent+type combo
4. Returns `{ matrix, agents, contractTypes, stats }`

**Rendering:** Grid of colored cells:
- Color intensity: 0% (dark) → 100% (bright green)
- Cell text: win rate percentage
- Row labels: agent names
- Column labels: contract types (vault, lending, dex, bridge, staking, unknown)

**Hover:** Tooltip showing: agent name, contract type, bids placed, wins, win rate.

---

## 13. Schedules Tab

**File:** `src/components/AuditSchedules.jsx`

Displays HSS (Hedera Schedule Service) audit events.

**Store bindings:**
```javascript
const hssEvents = useStore((s) => s.hssEvents);
```

**Event types displayed:**
- `AuditScheduled`: New recurring audit set up (owner, contract, interval, next due)
- `AuditTriggered`: HSS fired an automatic audit (contract, schedule address, times triggered)
- `AuditScheduleCancelled`: Schedule removed (contract, reason)
- `ScheduleFailed`: HSS attempt failed (contract, response code, context)

**Layout:** Chronological event list with:
- Event type badge (color-coded)
- Contract address (HashScan link)
- Schedule details (interval, next due, mode)
- Trigger counter

---

## 14. Activity & Debug Components

### 14.1 ActivityTicker

**File:** `src/components/ActivityTicker.jsx`

Fixed bottom bar showing the latest event + expandable transaction drawer.

**Store bindings:**
```javascript
const auditLog = useStore((s) => s.auditLog);
const latestEntry = auditLog[0]; // newest
```

**Bar content:**
- Left: Animated dot (pulse) + latest event type + description (truncated)
- Right: "View All" button to expand drawer

**Drawer:** Slides up from bottom (Framer Motion), contains full `<TransactionExplorer>`.

### 14.2 ActivityLog

**File:** `src/components/ActivityLog.jsx`

Alternative live event log component with type colors and descriptions.

**Store bindings:**
```javascript
const auditLog = useStore((s) => s.auditLog);
```

**Per entry:**
- Color-coded left border based on event type
- Formatted description using event-specific templates
- Relative timestamp

**Event description templates:**
```javascript
{
  JobPosted:        `Job #${e.jobId} posted — ${e.budgetFormatted}`,
  BidSubmitted:     `${e.agentName} bid ${e.bidFormatted} on Job #${e.jobId}`,
  WinnersSelected:  `${e.winnerCount} winners for Job #${e.jobId}`,
  JOB_SETTLED:      `Job #${e.jobId} settled — ${e.totalDisbursedFormatted}`,
  DATA_LISTED:      `${e.sellerName} listed "${e.title}" — ${e.priceFormatted}`,
  DATA_PURCHASED:   `${e.buyerName} purchased from ${e.sellerName}`,
  SLASH_INITIATED:  `${e.agentName} slashed ${e.slashedAmountFormatted} (${e.reasonStr})`,
  REPORT_PUBLISHED: `Report for Job #${e.jobId} published (CID: ${e.data?.cid?.slice(0,12)}...)`,
}
```

### 14.3 DebugPanel

**File:** `src/components/DebugPanel.jsx`

Overlay panel toggled with `Ctrl+D`.

**Store bindings:**
```javascript
const isConnected = useStore((s) => s.isConnected);
const useMockEvents = useStore((s) => s.useMockEvents);
const toggleMockEvents = useStore((s) => s.toggleMockEvents);
const resetAll = useStore((s) => s.resetAll);
const stats = useStore((s) => s.stats);
```

**Sections:**
1. **Connection status:** Green/red indicator, provider URL
2. **Mock toggle:** Same as header but with more detail
3. **Stats dump:** All `stats` counters
4. **Store size:** Counts for each major state slice (discoveries, jobs, bids, etc.)
5. **Reset button:** Calls `resetAll()` — clears all data, keeps connection config

**Keyboard shortcut:** `Ctrl+D` toggles visibility via `useEffect` with `keydown` listener.

### 14.4 StoryMode

**File:** `src/components/StoryMode.jsx`

10-step guided walkthrough overlay that demonstrates the full audit pipeline.

**Props:** `{ isActive, onClose, onTabSwitch }`

**Steps:**
1. Discovery — switches to liveFeed tab, highlights DiscoveryFeed
2. Auction Creation — highlights AuctionFeed
3. Agent Bidding — shows bid submission flow
4. Winner Selection — highlights winner announcement
5. Sub-Contracting — switches to contracts tab
6. Data Marketplace — highlights MarketplacePanel
7. Audit Execution — shows findings submission
8. Report Aggregation — explains IPFS upload
9. Settlement — switches to analytics tab
10. Reputation Update — shows leaderboard changes

**Implementation:**
- Full-screen overlay with semi-transparent black background
- Spotlight effect on target component (CSS clip-path or box-shadow cutout)
- Step counter (1/10) with next/prev/skip buttons
- Auto-advances on tab switch via `onTabSwitch` callback

---

## 15. Wallet Integration

### 15.1 Wallet Store

**File:** `src/store/wallet.js`

Separate Zustand store for wallet state:

```javascript
{
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error',
  walletType: 'metamask',           // HashPack coming soon
  address: string | null,           // Connected EVM address
  displayName: string | null,       // ENS or shortened address
  hbarBalance: string | null,       // "12.50 HBAR"
  guardBalance: string | null,      // "1,250.00 GUARD"
  signer: ethers.Signer | null,
  provider: ethers.BrowserProvider | null,
  showWalletModal: boolean,

  // Actions
  connect: async (type) => ...,     // MetaMask connection flow
  disconnect: () => ...,
  refreshBalances: async () => ..., // Polls every 30s
  openWalletModal: () => ...,
  closeWalletModal: () => ...,
}
```

**MetaMask connection flow:**
1. Check `window.ethereum` exists
2. Request accounts: `eth_requestAccounts`
3. Verify chain ID is 296 (Hedera testnet) — if wrong, call `wallet_addEthereumChain`
4. Create `ethers.BrowserProvider(window.ethereum)`
5. Get signer, address, balances
6. Listen to `accountsChanged`, `chainChanged` events

**Balance polling:** `setInterval(refreshBalances, 30_000)` — queries:
- HBAR: `provider.getBalance(address)`
- GUARD: `guardTokenContract.balanceOf(address)` (ERC20 with 8 decimals)

### 15.2 WalletButton

**File:** `src/components/wallet/WalletButton.jsx`

Top-right button in Header.

**States:**
- Disconnected: "Connect Wallet" button (outline style)
- Connecting: Spinner + "Connecting..."
- Connected: Shortened address + GUARD balance badge + disconnect dropdown

### 15.3 WalletConnectModal

**File:** `src/components/wallet/WalletConnectModal.jsx`

Modal overlay for wallet connection.

**Options:**
- **MetaMask** (enabled): Click to connect, auto-adds Hedera testnet if needed
- **HashPack** (disabled): "Coming soon" label

**Network info section:** Hedera Testnet details (chain ID, RPC, explorer)

### 15.4 WalletGate

**File:** `src/components/wallet/WalletGate.jsx`

Conditional render wrapper:

```jsx
<WalletGate>
  <ProtectedContent />
</WalletGate>
```

If wallet not connected: Shows "Connect wallet to access this feature" with connect button.
If connected: Renders children.

---

## 16. Pages (Routed Views)

### 16.1 WelcomeScreen

**File:** `src/pages/WelcomeScreen.jsx`

Landing page at `/`.

**Sections:**
- Animated particle background (CSS keyframes)
- Hero: "AuditGuard" title + tagline
- Live stats from store (if connected)
- Feature cards (4): Discovery, Auction, Analysis, Settlement
- CTA: "Launch Dashboard" → navigates to `/dashboard`

### 16.2 StakeDelegation

**File:** `src/pages/StakeDelegation.jsx`

Route: `/dashboard/stake`

**Layout:**
```
┌──────────────────────────────────────────────────┐
│ DelegationPortfolio (top — user's active stakes) │
├──────────────────────────────────────────────────┤
│ ┌────────────────────┐ ┌───────────────────────┐ │
│ │ AgentBrowser       │ │ DelegationWizard      │ │
│ │ (55% width)        │ │ (45% width)           │ │
│ │ Browse agents to   │ │ 3-step staking flow   │ │
│ │ stake on           │ │                       │ │
│ └────────────────────┘ └───────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Components:**

**DelegationPortfolio** (`components/stake/DelegationPortfolio.jsx`):
- Wallet-gated (requires connected wallet)
- Reads user's delegations from `DelegatedStaking` contract
- Shows: agent name, staked amount, earned rewards, APY
- Actions: Claim rewards, Undelegate (with cooldown warning)

**AgentBrowser** (`components/stake/AgentBrowser.jsx`):
- List of agents with sort options (reputation, staked total, pool size)
- Fetches pool data from `DelegatedStaking.getPoolInfo(agent)` per agent
- Clicking an agent opens `DelegationWizard` for that agent

**DelegationWizard** (`components/stake/DelegationWizard.jsx`):
- 3-step flow:
  1. **Review:** Agent profile summary, pool stats, APY estimate
  2. **Amount:** GUARD amount input, max button, balance check
  3. **Confirm:** Cost breakdown, risk disclosure, deploy button
- Uses `useContractWrite` for the staking transaction
- Confetti animation on success

### 16.3 AgentRegistration

**File:** `src/pages/AgentRegistration.jsx`

Route: `/dashboard/agents/register`

**4-step wizard with progress indicator:**

**Step 1 — StepIdentity** (`components/agent-register/StepIdentity.jsx`):
- Agent ID input (validated: alphanumeric + hyphens, 3-30 chars)
- Description textarea
- Avatar selection (preset icons)
- Validation: Agent ID uniqueness check against `AgentRegistry`

**Step 2 — StepUCP** (`components/agent-register/StepUCP.jsx`):
- UCP endpoint URL input
- "Test Connectivity" button — sends ping to endpoint
- Capability checkboxes (what the agent can do)
- Validates URL format

**Step 3 — StepSpecialization** (`components/agent-register/StepSpecialization.jsx`):
- Specialization cards: discovery, static-analysis, fuzzing, llm-contextual, dependency, report
- Multi-select allowed
- Tier selection: COMMODITY (100 GUARD), SPECIALIZED (300 GUARD), PREMIUM (500 GUARD)
- Shows GUARD balance check for selected tier

**Step 4 — StepDeploy** (`components/agent-register/StepDeploy.jsx`):
- Review summary of all previous steps
- Cost breakdown: staking amount + gas estimate
- Risk disclosure text
- "Register Agent" button
- Uses `useContractWrite` for `AgentRegistry.registerAgent()`
- Shows HashScan transaction link on success

### 16.4 ReportMarketplace

**File:** `src/pages/ReportMarketplace.jsx`

Route: `/dashboard/reports`

**Layout:** Grid of report cards with filters.

**Filters:**
- Category dropdown (AUDIT_FINDING, SCAN_REPORT, etc.)
- Listing type (ONE_TIME, SUBSCRIPTION)
- Price range slider
- Rating minimum
- Contract address search

**Components:**

**ReportCard** (`components/reports/ReportCard.jsx`):
- Title, category badge, price, seller, rating (stars)
- "View" button → opens ReportViewer
- "Buy" button → opens PurchaseModal (wallet-gated)

**ReportViewer** (`components/reports/ReportViewer.jsx`):
- Modal overlay
- Fetches report content from IPFS via `ipfsGatewayUrl(cid)` → `http://127.0.0.1:8080/ipfs/{cid}`
- Renders markdown via `react-markdown`
- Shows finding count, severity breakdown, agent contributors
- Star rating (1-5) for purchased reports

**PurchaseModal** (`components/reports/PurchaseModal.jsx`):
- 2-transaction flow:
  1. ERC20 `approve(DataMarketplace, price)` for GUARD token
  2. `DataMarketplace.purchaseData(listingId)`
- Shows balance check, price, platform fee
- Progress indicator for tx confirmation
- Uses `useContractWrite` for both transactions

**PurchaseHistory** (`components/reports/PurchaseHistory.jsx`):
- Wallet-gated
- Lists user's purchased reports with download/view links
- Rating submission for unrated purchases

**reportConstants.js** (`components/reports/reportConstants.js`):
- Category enum mapping
- Listing type enum mapping
- Color map for categories
- Formatting functions for report metadata

---

## 17. Custom Hooks Reference

### `useConnection()`
**File:** `src/hooks/useConnection.js`
- Initializes Hedera connection on mount
- Calls `initializeConnection()` from `hedera-connection.js`
- Stores result in Zustand via `setConnected()`
- Returns `{ isConnected, connectionError }`

### `useEventListeners(connection)`
**File:** `src/hooks/useEventListeners.js`
- Decides: mock events vs live listeners based on `useMockEvents`
- When mock: starts `startMockEventStream()` from `mock-events.js`
- When live: creates `EventListenerService` and calls `startAll()`
- Returns cleanup function for unmount
- Re-runs when `useMockEvents` toggles

### `useContractRead(contract, method, args, options)`
**File:** `src/hooks/useContractRead.js`
- Wraps `@tanstack/react-query` `useQuery`
- Calls `contract[method](...args)` with caching
- **Default cache time:** 5 seconds
- **Polling:** `options.refetchInterval` (e.g., 10000 for 10s)
- **Enabled:** Only if `contract` exists
- Returns `{ data, isLoading, error, refetch }`

```javascript
// Example usage:
const { data: activeJobs } = useContractRead(
  contracts?.auctionContract,
  'getActiveJobs',
  [],
  { refetchInterval: 10_000 }
);
```

### `useContractWrite(contract, method)`
**File:** `src/hooks/useContractWrite.js`
- Returns `{ write, isLoading, error, txHash }`
- `write(...args)` calls `contract[method](...args)`, waits for receipt
- Handles GUARD token approval flow:
  - Checks `guardToken.allowance(wallet, spender)`
  - If insufficient, sends `approve(spender, amount)` first
- Error handling: parses revert reasons from Hedera EVM bridge

### `useAutoScroll(dependency)`
**File:** `src/hooks/useAutoScroll.js`
- **Returns:** `{ containerRef, isAutoScrolling }`
- Attach `containerRef` to scrollable container
- Auto-scrolls to top when `dependency` changes (newest items first)
- **Pauses** if user scrolls away from top (>50px threshold)
- **Resumes** when user scrolls back to top
- Uses `requestAnimationFrame` for smooth scrolling

```jsx
function Feed() {
  const items = useStore((s) => s.discoveries);
  const { containerRef, isAutoScrolling } = useAutoScroll(items);

  return (
    <div ref={containerRef} className="overflow-auto">
      {items.map((item) => <Item key={item.id} data={item} />)}
    </div>
  );
}
```

### `useAuctionData()`
**File:** `src/hooks/useAuctionData.js`
- Merges store `activeJobs` + `bids` + `winners` + on-chain `getActiveJobs()` poll
- Deduplicates by jobId
- Sorts: active first, then by jobId desc
- Returns `{ auctions, isLoading }`

### `useAuditJobs()`
**File:** `src/hooks/useAuditJobs.js`
- Builds job lifecycle state machine from multiple store slices
- States: `AUCTION_OPEN → BIDDING_CLOSED → AUDITING_IN_PROGRESS → REPORT_PENDING → COMPLETED`
- Resolves winner names from `agents` store
- Returns enriched jobs array sorted newest first

### `useAgentLeaderboard()`
**File:** `src/hooks/useAgentLeaderboard.js`
- Enriches agents with StakingManager data (stake health, discount eligibility)
- Polls contract every 15s when live
- Sorts by reputation descending
- Returns `{ agents, isLoading }`

### `useContractHealth()`
**File:** `src/hooks/useContractHealth.js`
- Polls VaultFactory every 20s for vault summaries
- Returns `{ contracts, isLoading }`

### `useGuardFlows(windowSeconds = 120)`
**File:** `src/hooks/useGuardFlows.js`
- Filters `guardFlows` to recent window
- Builds agent node list + flow type breakdown
- Returns `{ recentFlows, agentNodes, totalTransacted, flowsByType }`

### `useMarketplaceData(categoryFilter?)`
**File:** `src/hooks/useMarketplaceData.js`
- Reads and filters `dataListings`, `dataPurchases`
- Polls `getActiveListings()` every 15s for reconciliation
- Returns `{ listings, purchases, categoryCounts }`

### `useCompetitionData()`
**File:** `src/hooks/useCompetitionData.js`
- Builds agent×contractType win rate matrix
- Returns `{ matrix, agents, contractTypes, stats }`

### `useNetworkGraph()`
**File:** `src/hooks/useNetworkGraph.js`
- Extends `useGuardFlows` with force-directed layout
- Returns `{ nodes, edges, simulation }`

### `useSettlementTimeline()`
**File:** `src/hooks/useSettlementTimeline.js`
- Groups settlements into 5-minute time buckets
- Calculates stacked bar data + aggregate stats
- Returns `{ buckets, stats, settlements }`

### `useRequireWallet()`
**File:** `src/hooks/useRequireWallet.js`
- Returns `{ isConnected, address, requireWallet }`
- `requireWallet()` opens wallet modal if not connected, returns false
- Use before wallet-dependent actions

---

## 18. Utility Functions Reference

### `fmt` — Format Utilities

**File:** `src/utils/format.js`

```javascript
fmt.guard(raw)              // BigInt → "1.00" (8-decimal GUARD, no symbol)
fmt.guardWithSymbol(raw)    // → "1.00 GUARD"
fmt.address(addr)           // → "0x1234…abcd" (6+4 chars)
fmt.addressFull(addr)       // → full 0x... address
fmt.timestamp(unixMs)       // → "14:32:07" (HH:MM:SS)
fmt.relativeTime(unixMs)    // → "3m ago", "1h ago", "just now"
fmt.risk(score)             // → { text: "HIGH", color: "#EF4444" }
fmt.reputation(basisPts)    // 9400 → "94.00"
fmt.lineCount(n)            // → "12,345" (locale formatting)
fmt.tvl(n)                  // → "$500K" or "$1.2M"
fmt.duration(seconds)       // → "12 min" or "2.0 hr"
fmt.paymentType(enumVal)    // 0 → "MAIN_AUDIT", 1 → "SUB_CONTRACT", etc.
fmt.category(enumVal)       // 0 → "SCAN_REPORT", 3 → "HOT_LEAD", etc.
fmt.slashReason(enumVal)    // 0 → "FALSE_POSITIVE", etc.
fmt.agentTier(enumVal)      // 0 → "UNREGISTERED", 1 → "COMMODITY", etc.
```

### `hashscan` — HashScan URL Builders

**File:** `src/utils/hashscan.js`

```javascript
hashscan.networkUrl              // "https://hashscan.io/testnet"
hashscan.transaction(hash)       // → "https://hashscan.io/testnet/transaction/{hash}"
hashscan.account(id)             // → "https://hashscan.io/testnet/account/{id}"
hashscan.token(id)               // → "https://hashscan.io/testnet/token/{id}"
hashscan.topic(id)               // → "https://hashscan.io/testnet/topic/{id}"
hashscan.topicMessage(id, seq)   // → "https://hashscan.io/testnet/topic/{id}?p=1&k={seq}"
hashscan.contract(id)            // → "https://hashscan.io/testnet/contract/{id}"
```

---

## 19. Styling & Theme Conventions

### Tailwind Theme Extensions

**File:** `tailwind.config.js`

```javascript
colors: {
  'guard-amber':  '#F59E0B',
  'guard-cyan':   '#06B6D4',
  'guard-green':  '#10B981',
  'guard-purple': '#8B5CF6',
  'guard-red':    '#EF4444',
  'guard-gold':   '#D4A017',
  'guard-orange': '#F97316',
}

fontFamily: {
  mono: ['JetBrains Mono', 'monospace'],
  sans: ['Outfit', 'sans-serif'],
}
```

### Custom Animations

```javascript
animation: {
  'pulse-glow':  'pulse-glow 2s ease-in-out infinite',
  'scan-sweep':  'scan-sweep 3s ease-in-out infinite',
  'radar-ring':  'radar-ring 1.5s ease-out infinite',
  'stat-bump':   'stat-bump 0.3s ease-out',
}
```

### CSS Variables (globals.css)

```css
:root {
  --accent-cyan:   #06B6D4;
  --accent-amber:  #F59E0B;
  --accent-green:  #10B981;
  --accent-purple: #8B5CF6;
  --accent-red:    #EF4444;
}
```

### Utility CSS Classes

```css
.panel       /* Dark card with border: bg-gray-950 border border-gray-800 rounded-lg */
.card        /* Slightly lighter: bg-gray-900/50 border-gray-800 */
.glow-text   /* Text shadow with accent color */
.status-dot-active    /* Green pulsing dot */
.status-dot-inactive  /* Gray static dot */
.status-dot-suspended /* Red pulsing dot */
```

### Consistent Patterns

1. **Background:** Always `bg-black` or `bg-gray-950` — never lighter
2. **Text:** `text-gray-100` for primary, `text-gray-400`/`text-gray-500` for secondary
3. **Borders:** `border-gray-800` everywhere
4. **Font:** `font-mono` for all data/code, `font-sans` only for hero text
5. **Sizing:** `text-xs` (12px) for data, `text-[10px]` for labels/badges, `text-[11px]` for sub-tabs
6. **Spacing:** Consistent `gap-2`, `p-3` for panels, `px-4 py-2` for cards

### Agent Accent Colors

These are used consistently across all components that display agent names:

| Agent | Color | Hex |
|---|---|---|
| StaticAnalysis-47 | Cyan | `#06B6D4` |
| Fuzzer-12 | Purple | `#8B5CF6` |
| LLMContextual-3 | Amber | `#F59E0B` |
| DependencyAgent-8 | Orange | `#F97316` |

---

## 20. Mock Event System

**File:** `src/services/mock-events.js`

Generates a **deterministic 90-second cycle** that exercises every store action:

| Time | Event | Store Actions |
|---|---|---|
| t=0s | CONTRACT_DISCOVERED | `addDiscovery`, `incrementStat` |
| t=5s | JOB_CREATED (JobPosted) | `setJob`, `incrementStat` |
| t=8s | BidSubmitted (Static47) | `addBid`, `addJobBidStatus`, `incrementStat` |
| t=12s | BidSubmitted (Fuzzer12) | `addBid`, `addJobBidStatus`, `incrementStat` |
| t=16s | BidSubmitted (LLM3) | `addBid`, `addJobBidStatus`, `incrementStat` |
| t=25s | WinnersSelected | `setWinners`, `addGuardFlow` (platform fee) |
| t=30s | SubAuctionCreated | `addSubJob`, `incrementStat` |
| t=35s | SubBidSubmitted (Dep8) | `addSubBid` |
| t=38s | DataListed (SCAN_REPORT) | `addDataListing` |
| t=40s | SubContractorSelected | `updateSubJobStatus` |
| t=44s | DataPurchased | `addDataPurchase`, `addGuardFlow`, `incrementStat` |
| t=50s | ResultDelivered + Accepted | `updateSubJobStatus`, `addGuardFlow` |
| t=60s | DataRated + JobSettled | `updateDataPurchaseRating`, `addSettlement`, `addGuardFlow` (per recipient) |
| t=65s | ReputationUpdated (x3) | `setAgent` (updated rep), `addReputationSnapshot` |
| t=70s | REPORT_PUBLISHED | `addReportMetadata`, `addLogEntry` |
| t=75s | FeeReceived + FeeDistributed | `addTreasuryRevenue`, `addTreasuryDistribution` |
| t=~90s | Cycle repeats with new contract type |

**Mock Agents:**
```javascript
{
  'StaticAnalysis-47':  { evmAddress: '0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80001', reputation: 94 },
  'Fuzzer-12':          { evmAddress: '0xb2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a10002', reputation: 87 },
  'LLMContextual-3':    { evmAddress: '0xc3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a1b20003', reputation: 87 },
  'DependencyAgent-8':  { evmAddress: '0xd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a1b2c30004', reputation: 65 },
}
```

**Contract type rotation:** vault → lending → dex → bridge → staking → vault → ...

---

## 21. Backend Data Contracts

### HCS Message Envelope

All messages on all topics follow this envelope:

```typescript
{
  type: string,           // Message type identifier
  agentId: string,        // Source agent ID
  timestamp: number,      // Date.now()
  payload: {              // Type-specific data
    ...
  }
}
```

### Critical HCS Message Types

| Type | Topic | Key Payload Fields |
|---|---|---|
| `CONTRACT_DISCOVERED` | Discovery | contractAddress, chain, contractType, riskScore, estimatedLOC, budget |
| `JOB_CREATED` | AuditLog | jobId, contractAddress, contractType, budget, riskScore |
| `AUCTION_INVITE_SUMMARY` | AuditLog | jobId, eligibleAgents[], excludedAgents[] |
| `BID_SUBMITTED` | AuditLog | jobId, bidAmount, collateral, evmAddress, reputation |
| `BID_SKIPPED` | AuditLog | jobId, contractAddress, reason |
| `WINNER_SELECTED` | AuditLog | jobId, winners[], totalEscrowed, platformFee |
| `FINDINGS_SUBMITTED` | AgentComms | jobId, findingsHash, criticalCount, highCount, mediumCount, lowCount |
| `REPORT_PUBLISHED` | AuditLog | jobId, reportHash, totalFindings, criticalFindings, cid |
| `REPORT_METADATA` | AuditLog | jobId, cid, listingId, contentHash, agentCount, findingCount |
| `PAYMENT_SETTLED` | AuditLog | jobId, recipients[], reportAgent, winnerCount |
| `REPUTATION_UPDATED` | AuditLog | jobId, agentId, delta |
| `ALERT_FIRED` | AuditLog | jobId, criticalFindings |
| `DATA_LISTING_CREATED` | AgentComms | listingId, category, price, description, jobId |
| `SUB_AUCTION_POSTED` | AgentComms | subAuctionId, taskType, paymentAmount, slaDurationSec, parentJobId |
| `SUB_RESULT_DELIVERED` | AgentComms | subAuctionId, resultHash, deliveredBy |

### On-chain Contract Events

| Contract | Event | Key Args |
|---|---|---|
| AuditAuction | `JobPosted` | jobId, contractAddress, contractChain, contractType, budgetAvailable, auctionDeadline, initialRiskScore, lineCount |
| AuditAuction | `BidSubmitted` | jobId, agent, bidAmount, collateralLocked, reputationAtBid, specialization, estimatedCompletionTime |
| AuditAuction | `WinnersSelected` | jobId, winners[], totalEscrowed, platformFee |
| AgentRegistry | `AgentRegistered` | agent, agentId, ucpEndpoint, stakedAmount |
| AgentRegistry | `ReputationUpdated` | agent, delta, newReputation |
| SubAuction | `SubAuctionCreated` | subJobId, parentJobId, requester, taskDescription, paymentAmount, slaDeadline |
| SubAuction | `SubBidSubmitted` | subJobId, agent, proposedPrice, collateralLocked, estimatedTime |
| SubAuction | `SubContractorSelected` | subJobId, agent, agreedPrice |
| SubAuction | `ResultDelivered` | subJobId, agent, resultHash |
| SubAuction | `ResultAccepted` | subJobId, paymentAmount |
| DataMarketplace | `DataListed` | listingId, seller, parentJobId, title, category, listingType, price, contentHash |
| DataMarketplace | `DataPurchased` | listingId, buyer, seller, pricePaid, platformFee |
| DataMarketplace | `DataRated` | listingId, buyer, rating |
| PaymentSettlement | `JobSettled` | settlementId, jobId, totalDisbursed, platformFee, reportFees, recipientCount |
| StakingManager | `SlashInitiated` | slashId, agent, reason, slashedAmount, slashBasisPoints, jobId |
| StakingManager | `AppealFiled` | slashId, agent, reason |
| Treasury | `FeeReceived` | source, amount, jobId, fromContract |
| Treasury | `FeeDistributed` | distributionId, totalDistributed, ucpAmount, reserveAmount, burnAmount |

---

## 22. GUARD Token Precision

**GUARD has 8 decimal places** (not 18 like ETH).

```javascript
// Raw value: 100_000_000n = 1.00 GUARD
// Raw value: 15_000_000_000n = 150.00 GUARD

// Converting raw → display:
const whole = raw / 100_000_000n;
const frac = (raw % 100_000_000n).toString().padStart(8, '0').slice(0, 2);
const display = `${whole}.${frac} GUARD`;

// Using ethers:
import { formatUnits, parseUnits } from 'ethers';
formatUnits(raw, 8);        // "150.00"
parseUnits("150.00", 8);    // 15000000000n
```

**Important:** The `fmt.guard(raw)` and `fmt.guardWithSymbol(raw)` utilities handle this conversion. Always use them instead of manual math.

---

## 23. Build & Development

### Scripts

```bash
npm run dev       # Vite dev server at http://localhost:5173
npm run build     # Production build to /dist
npm run preview   # Preview built dist
npm test          # Run vitest
```

### Vite Configuration

**File:** `vite.config.js`

```javascript
export default defineConfig({
  resolve: {
    alias: {
      '@sdk': path.resolve(__dirname, '../sdk'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          web3: ['ethers', '@hashgraph/sdk'],
          ui: ['framer-motion', 'zustand', '@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
```

### Environment Variables

**File:** `.env.local`

```
VITE_HEDERA_NETWORK=testnet
VITE_HEDERA_JSON_RPC=https://testnet.hashio.io/api
VITE_HEDERA_MIRROR_NODE=https://testnet.mirrornode.hedera.com
VITE_TEST_MODE=true    # Optional: filters discoveries to test contracts only
```

### SDK Config Loading

The `@sdk` alias resolves to `packages/sdk/`, which contains:
- `config.json` — All contract addresses, ABI references, HCS topic IDs, seeded agents, test contracts
- ABI JSON files for each contract

`hedera-connection.js` loads this at startup:
```javascript
import sdkConfig from '@sdk/config.json';
```

---

## Appendix A: Complete Job Lifecycle (Frontend Perspective)

```
1. Scanner discovers contract
   → HCS Discovery: CONTRACT_DISCOVERED
   → Store: addDiscovery()
   → UI: DiscoveryFeed shows new card

2. Orchestrator creates auction
   → HCS AuditLog: JOB_CREATED
   → On-chain: AuditAuction.JobPosted
   → Store: setJob()
   → UI: AuctionFeed shows new AuctionCard

3. Agents invited
   → HCS AuditLog: AUCTION_INVITE_SUMMARY
   → Store: addJobBidStatus(invite_sent) per agent
   → UI: AuctionCard shows "3 agents invited"

4. Agents bid
   → HCS AuditLog: BID_SUBMITTED (per agent)
   → On-chain: AuditAuction.BidSubmitted
   → Store: addBid(), addJobBidStatus(submitted)
   → UI: BidRow appears in AuctionCard

5. Some agents skip
   → HCS AuditLog: BID_SKIPPED
   → Store: addJobBidStatus(skipped)
   → UI: TransactionExplorer shows skip reason

6. Winners selected
   → On-chain: AuditAuction.WinnersSelected
   → Store: setWinners()
   → UI: AuctionCard switches to "AUDITING" state, shows winners

7. Sub-auction (optional, LLM agent)
   → On-chain: SubAuction.SubAuctionCreated
   → Store: addSubJob()
   → UI: SubContractTree shows new sub-task

8. Data traded (optional)
   → On-chain: DataMarketplace.DataListed + DataPurchased
   → Store: addDataListing(), addDataPurchase(), addGuardFlow()
   → UI: MarketplacePanel shows listing, PaymentFlow shows flow

9. Findings submitted
   → HCS AgentComms: FINDINGS_SUBMITTED (per agent)
   → Store: addLogEntry()
   → UI: TransactionExplorer shows findings entries

10. Report aggregated + uploaded to IPFS
    → HCS AuditLog: REPORT_METADATA
    → Store: addReportMetadata()
    → UI: ReportMarketplace shows report available for purchase

11. Settlement
    → On-chain: PaymentSettlement.JobSettled
    → Store: addSettlement(), addGuardFlow() per recipient
    → UI: SettlementTimeline bar, PaymentFlow lines, NetworkGraph edges

12. Reputation updated
    → On-chain: AgentRegistry.ReputationUpdated
    → Store: setAgent(), addReputationSnapshot()
    → UI: AgentLeaderboardRow flashes, sparkline updates

13. Alert (if critical findings >= 5)
    → HCS AuditLog: ALERT_FIRED
    → Store: addLogEntry()
    → UI: TransactionExplorer shows alert entry, Toast notification
```

---

## Appendix B: Data Enum Mappings

### DataMarketplace Categories
```
0 = SCAN_REPORT
1 = DEPENDENCY_ANALYSIS
2 = EXPLOIT_DATABASE
3 = HOT_LEAD
4 = FUZZING_SEEDS
5 = THREAT_INTEL
6 = AUDIT_FINDING (used for final reports)
7 = OTHER
```

### Listing Types
```
0 = ONE_TIME
1 = SUBSCRIPTION
2 = TIP
```

### Payment Types
```
0 = MAIN_AUDIT
1 = SUB_CONTRACT
2 = DATA_PURCHASE
3 = BONUS_SPEED
4 = BONUS_UNIQUE_FINDING
5 = MONITORING_PAYMENT
6 = REPORT_FEE
7 = PLATFORM_FEE
8 = BOUNTY_PAYOUT
9 = REFUND
```

### Agent Tiers
```
0 = UNREGISTERED
1 = COMMODITY (100+ GUARD staked)
2 = SPECIALIZED (300+ GUARD, 70+ reputation)
3 = PREMIUM (500+ GUARD, 85+ reputation)
```

### Slash Reasons
```
0 = FALSE_POSITIVE (5%)
1 = FALSE_NEGATIVE (10%)
2 = MALICIOUS_REPORT (100%)
3 = SLA_VIOLATION (25%)
4 = COLLUSION (100%)
5 = PLAGIARISM (50%)
```

### Job Status
```
0 = AUCTION_OPEN
1 = BIDDING_CLOSED
2 = AUDITING_IN_PROGRESS
3 = REPORT_PENDING
4 = COMPLETED
5 = CANCELLED
```

### Treasury Revenue Sources
```
0 = auditFees
1 = marketplaceFees
2 = reportFees
3 = slashingProceeds
4 = subAuctionFees
```
