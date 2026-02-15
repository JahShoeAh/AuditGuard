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