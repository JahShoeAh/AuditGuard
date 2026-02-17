# Blockchain Infrastructure Reference

## Day 1

| Artifact | Location | What It Is |
|---|---|---|
| `config.json` | `packages/sdk/config.json` | Token IDs, contract addresses, HCS topics, seeded agent profiles |
| Contract ABIs | `packages/sdk/abis/*.json` | ABI files to instantiate ethers.js Contract objects |
| Agent Interface Standard | `AgentRegistry.sol` | The on-chain spec any agent must follow: register → stake → bid → earn reputation |
| HCS Message Schemas | Documented in Prompt 6 Topic definitions | JSON schemas for Discovery, AuditLog, and AgentComms topics |
| Open Registration Flow | `AgentRegistry.registerAgent()` | How external agents join: stake GUARD → start COMMODITY → earn promotion |

## Day 2

| Spec Element | Contract | Function(s) |
|---|---|---|
| "LLM Agent initiates sub-auction: dependency analysis, 3 GUARD, 15-min SLA" | SubAuction | `createSubAuction()` |
| "Dependency Agent #8 wins micro-job, performs analysis, receives payment" | SubAuction | `submitSubBid()` → `selectSubContractor()` → `deliverResult()` → `acceptResult()` |
| "Sub-contracts managed via nested smart contracts with escrow" | SubAuction | Payment escrowed on create, released on accept |
| "Main Agent bids 40, sub-contracts 5+2, nets 33 profit" | SubAuction | `createSubAuction(paymentAmount=5)`, agent keeps the rest |
| "Static Analysis offers findings for 0.5 GUARD" | DataMarketplace | `createListing(price=0.5 GUARD, category=SCAN_REPORT)` |
| "Fuzzer purchases data to optimize fuzzing" | DataMarketplace | `purchaseData()` |
| "LLM Agent subscribes to Vuln DB feed (1 GUARD/day)" | DataMarketplace | `createListing(type=SUBSCRIPTION, period=86400)` → `purchaseData()` → `renewSubscription()` |
| "Scanner sells hot leads (0.1 GUARD per lead)" | DataMarketplace | `createListing(category=HOT_LEAD, price=0.1)` |
| "Pricing dynamic based on freshness, uniqueness, demand" | DataMarketplace | `updatePrice()` |
| "Report Agent charges 0.1 GUARD fee, high-rep discount" | PaymentSettlement | `reportFeeBase`, `reportFeeDiscounted`, `reportFeeDiscountThreshold` |
| "All settlements atomic via HTS" | PaymentSettlement | `settleJob()` — single atomic batch |
| "15 GUARD + 2 GUARD bonus for speed" | PaymentSettlement | `PaymentItem{basePayment=15, bonus=2, type=BONUS_SPEED}` |
| "35 GUARD + 8 GUARD bonus for unique findings" | PaymentSettlement | `PaymentItem{basePayment=35, bonus=8, type=BONUS_UNIQUE_FINDING}` |
| "Dependency Agent receives 3 GUARD sub-contract payment" | PaymentSettlement | `PaymentItem{basePayment=3, type=SUB_CONTRACT}` |
| "5% platform fee on successful audit payments" | PaymentSettlement | `platformFeePercent = 5` |
| "Logged to HCS" | All events | Agent Scripts teammate publishes events to HCS AuditLog topic after catching them |

## Day 3

| Spec Element | Contract | Function(s) |
|---|---|---|
| "Developers deposit GUARD into vault tied to their contract" | AuditVault | `deposit()` — multi-depositor, anyone can fund |
| "Vault balance is public, influencing agent bidding behavior" | AuditVault / VaultFactory | `getBalance()`, `getVaultsByPriority()` |
| "If Alice wants priority, she increases vault balance" | VaultFactory | `getVaultsByPriority()` — higher balance = higher priority |
| "Vaults can have rules: 10 GUARD/week monitoring, 50 GUARD bounties" | AuditVault | `VaultConfig.weeklyMonitoringBudget`, `criticalBountyAllocation` |
| "Monitoring Agent places standing bid: 5 GUARD/week" | AuditVault | `applyForMonitoring()`, `claimMonitoringPayment()` |
| "Budget accepts this bid autonomously" | AuditVault | Acceptance logic in `applyForMonitoring()` — cheaper rate auto-wins |
| "Auto-trigger new auctions when thresholds met (TVL 10x)" | AuditVault / VaultFactory | `checkAndTriggerReaudit()`, deposit threshold in `deposit()`, `AutoAuditTriggered` event |
| "Dynamic pricing for re-audits based on code change velocity, time" | AuditVault | `config.reauditIntervalSeconds`, `isReauditDue()` |
| "Stake 100–1000 GUARD depending on tier" | StakingManager | `stake()`, `minStakeForActive` |
| "Slashed for false positives (5%), false negatives (10%), malicious (100%)" | StakingManager | `slashRates` mapping, `initiateSlash()` |
| "High-reputation agents bid on premium jobs" | StakingManager | `isStakeSufficient()` — Orchestrator checks before accepting |
| "Agent iNFT stores staked collateral, historical accuracy metrics" | StakingManager | `getStakeInfo()`, `getStakeHistory()`, `getAgentSlashHistory()` |
| "Agents vote on slashing/penalty parameters" | StakingManager | `setSlashRate()` — governance-gated |
| "5% platform fee distributed to UCP validators and treasury" | Treasury | `receiveFee()`, `distribute()`, `distributionConfig` |
| "Agents vote on Orchestrator Agent fee structures" | Treasury | `setDistributionConfig()` — governance-gated |
| "High-stake, high-reputation agents get fee reductions" | Treasury | `calculateAgentFeeDiscount()`, `getDiscountEligibility()` |

---

## Architecture After Day 3 (Complete Contract Map)

```
                    ┌─────────────────┐
                    │  GUARD Token    │
                    │  (HTS Native)   │
                    └────────┬────────┘
                             │ used by all ↓
    ┌────────────────────────┼────────────────────────┐
    │                        │                        │
┌───┴──────────┐    ┌───────┴────────┐    ┌──────────┴───┐
│ Agent        │    │ Staking        │    │ Treasury     │
│ Registry     │◄───│ Manager        │───►│ (Fee Dist.)  │
│ (Identity)   │    │ (Economics)    │    │              │
└───┬──────────┘    └───────┬────────┘    └──────┬───────┘
    │                       │                    ▲
    │ queries               │ locks/unlocks      │ fees from ↓
    ▼                       ▼                    │
┌────────────────────────────────────────────────┴───────┐
│                    Audit Auction                        │
│            (Job Posting → Bidding → Winners)            │
└──────┬───────────────────────────────┬─────────────────┘
       │                               │
       ▼                               ▼
┌──────────────┐              ┌────────────────┐
│ Sub-Auction  │              │ Payment        │
│ (Nested      │              │ Settlement     │
│  Contracting)│              │ (Atomic Batch) │
└──────────────┘              └───────┬────────┘
                                      │ draws from ↓
┌─────────────────────────────────────┴──────────────────┐
│                    Vault Factory                        │
│                         │                              │
│    ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│    │ Vault:     │ │ Vault:     │ │ Vault:     │       │
│    │ Lending    │ │ DEX v3     │ │ Staking    │       │
│    │ Protocol   │ │            │ │ Pool       │       │
│    └────────────┘ └────────────┘ └────────────┘       │
└────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────┴──────────────────────────┐
│                  Data Marketplace                       │
│          (Scan Reports, Exploit DBs, Hot Leads)        │
└────────────────────────────────────────────────────────┘