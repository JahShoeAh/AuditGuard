# AuditGuard — Test Suite Documentation

> Last updated: 2026-04-05
> Framework: Hardhat + Chai + ethers.js v6 (contracts), Vitest (agents)

All tests in `packages/contracts/test/` use `loadFixture` for clean isolated state per test.
MockHTS is injected at `0x167` via `hardhat_setCode` before every fixture.
MockHSS is injected at `0x16b` for AuditScheduler tests.

---

## Setup: Shared Fixture (`deployAll`)

Runs before every test group. Deploys in dependency order:

1. MockHTS → `hardhat_setCode` at `0x167`
2. MockGuardToken (ERC20) — 1,000,000 GUARD (8 decimals)
3. AgentRegistry(guardToken)
4. Treasury(guardToken, ucpPool, protocolReserve, burnAddr)
5. AuditAuction(guardToken, agentRegistry, orchestrator, treasury)
6. SubAuction(guardToken, agentRegistry, auditAuction, treasury)
7. StakingManager(guardToken, agentRegistry, treasury)
8. PaymentSettlement(guardToken, agentRegistry, auditAuction, subAuction, treasury, orchestrator)
9. DataMarketplace(guardToken, agentRegistry, treasury)
10. VaultFactory(guardToken, agentRegistry)
11. AuditBudgetVault(guardToken)
12. TimeLockVault()

Wire-up calls after deployment:
- `agentRegistry.setOrchestratorAndAuction(orchestrator, auditAuction)`
- `stakingManager.addAuthorizedSlasher(auditAuction, subAuction, paymentSettlement)`
- `treasuryContract.addAuthorizedSource(auditAuction, paymentSettlement, dataMarketplace, stakingManager)`
- `treasuryContract.setStakingManager(stakingManager)`
- `treasuryContract.setAgentRegistry(agentRegistry)`
- `vaultFactory.setAuctionContract(auditAuction)`
- `vaultFactory.setPaymentSettlement(paymentSettlement)`
- `budgetVault.setAuthorizedDrawer(auditAuction)`

Distribute 10,000 GUARD to: agent1, agent2, agent3, agent4, orchestrator

---

## File: `packages/contracts/test/AuditGuard.test.js`

---

### Suite 1 — AgentRegistry

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 1.1 | `registerAgent — emits AgentRegistered and sets COMMODITY tier` | `registerAgent(agentId, endpoint, specs, COMMODITY_STAKE)` succeeds, emits `AgentRegistered`, profile has tier=COMMODITY, status=ACTIVE, reputation=5000 |
| 1.2 | `registerAgent — rejects stake below COMMODITY_MIN_STAKE (100 GUARD)` | Calling with 99 GUARD reverts with "insufficient commodity stake" |
| 1.3 | `registerAgent — rejects empty agentId` | Empty string agentId reverts with "empty agentId" |
| 1.4 | `registerAgent — rejects empty endpoint` | Empty ucpEndpoint reverts with "empty endpoint" |
| 1.5 | `registerAgent — rejects duplicate registration` | Second call by same address reverts with "already registered" |
| 1.6 | `addStake — increases stakedAmount` | `addStake(200 GUARD)` emits `StakeAdded`, profile.stakedAmount = 300 GUARD |
| 1.7 | `addStake — rejects zero amount` | `addStake(0)` reverts with "amount is zero" |
| 1.8 | `requestPromotion — COMMODITY → SPECIALIZED when stake ≥ 300 and rep ≥ 7000` | After seeding rep=7000 and staking 300 GUARD, `requestPromotion()` emits `AgentPromoted`, tier=SPECIALIZED |
| 1.9 | `requestPromotion — SPECIALIZED → PREMIUM when stake ≥ 500 and rep ≥ 8500` | After seeding rep=8500 and staking 500 GUARD, second `requestPromotion()` emits `AgentPromoted`, tier=PREMIUM |
| 1.10 | `requestPromotion — rejects when reputation below threshold` | Rep=6999 with 300 GUARD staked reverts with "specialized requirements unmet" |
| 1.11 | `updateReputation — orchestrator applies positive delta` | `updateReputation(agent, +500)` changes rep from 5000 to 5500, emits `ReputationUpdated` |
| 1.12 | `updateReputation — clamps reputation at 0 minimum` | Apply delta of -6000 to agent with rep=5000 → rep becomes 0, not negative |
| 1.13 | `updateReputation — clamps reputation at 10000 maximum` | Apply delta of +6000 to agent with rep=5000 → rep becomes 10000, not 11000 |
| 1.14 | `updateReputation — rejects non-orchestrator caller` | Stranger calling `updateReputation` reverts with "caller is not authorized scorer" |
| 1.15 | `recordJobCompletion — updates metrics and adjusts reputation` | `recordJobCompletion(agent, 5 valid, 1 false+, 0 false-)` increments completedJobs=1, applies delta=(5×50)-(1×100)=150, emits `JobRecorded` |
| 1.16 | `slashAgent — reduces stakedAmount by basis points` | Slash 500 bps (5%) on 100 GUARD stake → stakedAmount=95 GUARD, emits `AgentSlashed` |
| 1.17 | `slashAgent — sets status=SUSPENDED when below COMMODITY minimum after slash` | 5% slash on exactly 100 GUARD stake → 95 GUARD < 100 minimum → status=SUSPENDED |
| 1.18 | `slashAgent — sets status=SLASHED on 100% slash (10000 bps)` | Full slash → stakedAmount=0, status=SLASHED |
| 1.19 | `slashAgent — rejects invalid slash bps (0 or > 10000)` | `slashAgent(agent, 0)` and `slashAgent(agent, 10001)` both revert with "invalid slash bps" |
| 1.20 | `withdrawStake — excess withdrawal succeeds for active agent` | Agent with 200 GUARD staked at COMMODITY tier can withdraw 100 GUARD (keeping 100 minimum) |
| 1.21 | `withdrawStake — rejects withdrawal that drops below tier minimum` | Active COMMODITY agent with exactly 100 GUARD staked cannot withdraw any amount |
| 1.22 | `deregisterAgent — returns all stake and sets status=INACTIVE` | `deregisterAgent()` emits `AgentDeregistered`, profile.stakedAmount=0, status=INACTIVE |
| 1.23 | `seedAgentReputation — owner sets rep, fails on agent with jobs` | Owner seeds rep=8000 for fresh agent; fails if agent has ≥1 completed job |
| 1.24 | `pause / unpause — blocks and restores mutations` | After `pause()`, `addStake()` reverts with `EnforcedPause`; after `unpause()`, it succeeds |
| 1.25 | `isEligibleForTier — returns false for INACTIVE agent` | After deregistering, `isEligibleForTier(agent, COMMODITY)` returns false |

---

### Suite 2 — AuditAuction

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 2.1 | `createAuditJob — emits JobPosted with all fields` | `createAuditJob(addr, "hedera", "lending", 75, 1000 GUARD, 5000 loc, 3600s)` emits `JobPosted` with jobId=1, all params correct |
| 2.2 | `createAuditJob — auto-increments jobId (1, 2, 3)` | Three consecutive jobs get jobIds 1, 2, 3 |
| 2.3 | `createAuditJob — rejects zero budget` | budget=0 reverts with "budget is zero" |
| 2.4 | `createAuditJob — rejects risk score > 100` | initialRiskScore=101 reverts with "risk score out of range" |
| 2.5 | `createAuditJob — rejects zero address contract` | contractAddress=0x0 reverts with "contract address is zero" |
| 2.6 | `createAuditJob — rejects non-orchestrator caller` | agent1 calling reverts with "caller is not orchestrator" |
| 2.7 | `submitBid — emits BidSubmitted and escrows collateral` | Agent submits bid with MIN_BID_COLLATERAL, emits `BidSubmitted`, collateral balance increases |
| 2.8 | `submitBid — rejects collateral below minimum (50 GUARD)` | collateralAmount=49 GUARD reverts with "collateral below minimum" |
| 2.9 | `submitBid — rejects bid amount exceeding job budget` | bidAmount > budgetAvailable reverts with "bid exceeds budget" |
| 2.10 | `submitBid — rejects duplicate bid from same agent` | Second call from same agent reverts with "bid already submitted" |
| 2.11 | `submitBid — rejects inactive agent` | Deregistered agent cannot bid — "inactive agent" |
| 2.12 | `submitBid — rejects after auction deadline` | `time.increase(3601)` then bid reverts with "auction expired" |
| 2.13 | `calculateBidScore — higher reputation agent scores higher` | Two bids with same price/speed but different reputations: higher rep = higher score |
| 2.14 | `calculateBidScore — lower price improves score (price component)` | Same agent, lower bid amount = higher price component |
| 2.15 | `calculateBidScore — faster ETA improves score (speed component)` | Same price/rep, lower estimatedCompletionTime = higher score |
| 2.16 | `rankBids — returns indices sorted by descending score` | Three bids; `rankBids(jobId)[0]` is the index of the highest-scoring bid |
| 2.17 | `selectWinners — transitions job to AUDITING_IN_PROGRESS` | `selectWinners(jobId, [0])` emits `WinnersSelected`, job.status=AUDITING_IN_PROGRESS |
| 2.18 | `selectWinners — refunds losing bid collateral` | After selecting winner[0], bidder[1]'s collateral is returned via `BidRefunded` event |
| 2.19 | `selectWinners — deducts platform fee (5%) and transfers to treasury` | Platform fee = 5% of total winning bid amount is sent to treasury |
| 2.20 | `selectWinners — rejects duplicate winning indices` | Passing [0, 0] reverts with "duplicate winning index" |
| 2.21 | `selectWinners — rejects when total winning bids exceed budget` | Two winning bids summing > budget reverts with "total exceeds budget" |
| 2.22 | `releaseEscrow — pays agent, returns collateral, calls recordJobCompletion` | `releaseEscrow(jobId, agent, payment, bonus, 5, 0, 0)` emits `EscrowReleased`, agent receives payment+collateral, registry updates |
| 2.23 | `releaseEscrow — rejects double payment for same agent` | Second `releaseEscrow` for same agent reverts with "winner already paid" |
| 2.24 | `releaseEscrow — rejects payout exceeding escrowed amount` | payment > totalEscrowedAmount reverts with "insufficient escrow" |
| 2.25 | `completeJob — transitions to COMPLETED after all winners paid` | After `releaseEscrow` for all winners, `completeJob` emits `JobCompleted`, status=COMPLETED |
| 2.26 | `completeJob — rejects when unpaid winners remain` | `completeJob` before all `releaseEscrow` calls reverts with "unpaid winners remain" |
| 2.27 | `slashAgentBid — slashes collateral and forwards to treasury` | `slashAgentBid(jobId, agent, 1000)` emits `AgentSlashed`, 10% of collateral sent to treasury |
| 2.28 | `slashAgentBid — rejects invalid slash bps (not 500/1000/10000)` | slashBasisPoints=300 reverts with "invalid slash bps" |
| 2.29 | `cancelJob — refunds all pending bid collateral` | `cancelJob(jobId)` emits `JobCancelled`, all pending bids get `BidRefunded` events |
| 2.30 | `cancelJob — rejects cancellation of non-open job` | Cancelling a AUDITING_IN_PROGRESS job reverts with "only open jobs cancellable" |

---

### Suite 3 — SubAuction

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 3.1 | `createSubAuction — emits SubAuctionCreated with parentJobId` | Winner of parent job creates sub-auction; event has correct parentJobId and requester |
| 3.2 | `createSubAuction — rejects non-winner caller` | Non-winner trying to create sub-auction reverts with "not a winner" |
| 3.3 | `createSubAuction — rejects payment below minimum` | paymentAmount < MIN_PAYMENT reverts with "payment too low" |
| 3.4 | `submitSubBid — emits SubBidSubmitted and locks collateral` | Active agent submits sub-bid; `SubBidSubmitted` emitted, collateral escrowed |
| 3.5 | `submitSubBid — rejects collateral below MIN_SUB_COLLATERAL (10 GUARD)` | 9 GUARD collateral reverts with "collateral below minimum" |
| 3.6 | `submitSubBid — rejects duplicate sub-bid` | Same agent bids twice on same subJobId → "already bid" |
| 3.7 | `selectSubContractor — transitions to IN_PROGRESS, sets selectedAgent` | Requester selects winning sub-bid; `SubContractorSelected` emitted, status=IN_PROGRESS |
| 3.8 | `selectSubContractor — rejects non-requester caller` | Stranger calling `selectSubContractor` reverts |
| 3.9 | `deliverResult — emits ResultDelivered with result hash` | Selected contractor delivers; `ResultDelivered` emitted, status=DELIVERED |
| 3.10 | `deliverResult — rejects non-contractor caller` | Non-selected agent cannot deliver result |
| 3.11 | `acceptResult — known limitation: SubAuction is not authorized scorer in AgentRegistry` | `acceptResult` reverts because AgentRegistry rejects SubAuction as scorer; documents design gap |
| 3.12 | `getSubJob — returns correct sub-job data` | `getSubJob(subJobId)` returns correct parentJobId, requester, payment, status |

---

### Suite 4 — StakingManager

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 4.1 | `stake — emits Staked and updates stakeInfo` | `stake(100 GUARD)` emits `Staked`, info.totalStaked=100, info.availableStake=100 |
| 4.2 | `stake — rejects zero amount` | `stake(0)` reverts with "amount is zero" |
| 4.3 | `requestUnstake — emits UnstakeRequested and reduces availableStake` | `requestUnstake(50 GUARD)` emits `UnstakeRequested`, availableStake drops, unbondingAmount=50 |
| 4.4 | `requestUnstake — rejects amount exceeding available stake` | Unbonding more than available reverts with "insufficient available stake" |
| 4.5 | `completeUnstake — rejects before cooldown period elapses` | Immediately calling `completeUnstake()` reverts with "unbonding period not elapsed" |
| 4.6 | `completeUnstake — succeeds after cooldown, emits Unstaked` | After `time.increase(cooldown)`, `completeUnstake()` emits `Unstaked`, tokens returned |
| 4.7 | `slashStake — authorized slasher reduces stake and emits StakeSlashed` | AuditAuction (authorized) calls `slashStake(agent, 500bps)`, 5% slashed, emits `StakeSlashed` |
| 4.8 | `slashStake — rejects unauthorized caller` | Stranger calling `slashStake` reverts with "not authorized slasher" |
| 4.9 | `addAuthorizedSlasher — owner can add, non-owner cannot` | Owner adds new slasher; stranger calling reverts |
| 4.10 | `freezeStake — owner can freeze, emits StakeFrozen` | `freezeStake(agent)` emits `StakeFrozen`, status=FROZEN |
| 4.11 | `getEffectiveStake — returns total staked for agent` | After staking 200 GUARD, `getEffectiveStake(agent)` returns 200 GUARD |

---

### Suite 5 — PaymentSettlement

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 5.1 | `depositSettlementFunds — orchestrator can deposit GUARD` | `depositSettlementFunds(1000 GUARD)` emits `FundsDeposited`, contract balance increases |
| 5.2 | `settleAuditJob — distributes payments per manifest` | `settleAuditJob(manifest)` emits `JobSettled`, each recipient gets correct payment+bonus |
| 5.3 | `settleAuditJob — rejects non-orchestrator caller` | Stranger calling reverts with "caller is not orchestrator" |
| 5.4 | `settleAuditJob — rejects if total payout exceeds deposited funds` | Manifest with totalPayout > contract balance reverts |
| 5.5 | `settleAuditJob — records settlement history` | After settlement, `getSettlementRecord(settlementId)` returns correct data |
| 5.6 | `getSettlementCount — returns correct count after multiple settlements` | Three settlements → count=3 |

---

### Suite 6 — DataMarketplace

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 6.1 | `listData — emits DataListed with correct metadata` | Seller lists AUDIT_FINDING at 10 GUARD; `DataListed` emitted, listingId=1 |
| 6.2 | `listData — rejects zero price` | price=0 reverts with "price must be positive" |
| 6.3 | `listData — rejects empty title` | Empty title string reverts |
| 6.4 | `purchaseData — buyer pays, seller receives 97%, treasury gets 3%` | Buyer purchases listing; `DataPurchased` emitted, seller gets price×0.97, treasury gets price×0.03 |
| 6.5 | `purchaseData — grants access and records purchase` | After purchase, `hasPurchased(listingId, buyer)` returns true |
| 6.6 | `purchaseData — rejects self-purchase` | Seller cannot buy own listing — reverts with "cannot buy own listing" |
| 6.7 | `purchaseData — rejects double purchase for ONE_TIME listing` | Buyer purchases twice → second call reverts |
| 6.8 | `purchaseData — high-reputation seller (≥ 8500) gets 1% fee instead of 3%` | Seed seller rep=8500; platform fee is 1% instead of 3% |
| 6.9 | `rateData — buyer rates listing 1-5` | After purchase, `rateData(listingId, 4)` emits `DataRated` |
| 6.10 | `rateData — rejects non-buyer rating` | Non-buyer cannot rate — reverts |
| 6.11 | `rateData — rejects rating out of range (0 or 6)` | rating=0 or rating=6 reverts with "invalid rating" |
| 6.12 | `delistData — seller can delist active listing` | Seller calls `delistData(listingId)`; status=DELISTED |
| 6.13 | `getListingsByCategory — returns filtered listings` | Two listings: one AUDIT_FINDING, one EXPLOIT_DATABASE; filter by AUDIT_FINDING returns only first |

---

### Suite 7 — Treasury

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 7.1 | `receiveFee — authorized source can deposit, emits FeeReceived` | AuditAuction calls `receiveFee(AUDIT_PLATFORM_FEE, 100 GUARD, jobId)`, emits `FeeReceived` |
| 7.2 | `receiveFee — rejects unauthorized source` | Non-authorized contract calling reverts with "not authorized source" |
| 7.3 | `distributeRevenue — splits 40/50/10 across UCP/reserve/burn` | `distributeRevenue(1000 GUARD)` → ucpPool gets 400, reserve gets 500, burn gets 100 |
| 7.4 | `distributeRevenue — emits RevenueDistributed with correct amounts` | Event includes ucpAmount=400, reserveAmount=500, burnAmount=100 |
| 7.5 | `setDistributionConfig — owner can update split percentages` | Owner updates to 50/40/10; next distribution uses new ratios |
| 7.6 | `setDistributionConfig — rejects config that doesn't sum to 100` | Percentages summing to 99 or 101 reverts |
| 7.7 | `setDistributionConfig — rejects non-owner caller` | Stranger calling reverts |
| 7.8 | `emergencyWithdraw — owner can rescue stuck funds` | `emergencyWithdraw(500 GUARD, owner)` transfers funds to owner |
| 7.9 | `emergencyWithdraw — rejects non-owner caller` | Stranger calling reverts |
| 7.10 | `getFeeDiscountForAgent — returns 0 for low-rep, non-zero for high-rep` | Agent with rep=9000 gets fee discount vs rep=5000 |

---

### Suite 8 — AuditVault + VaultFactory

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 8.1 | `createVault — VaultFactory deploys AuditVault and emits VaultCreated` | `vaultFactory.createVault(contractAddr, "hedera")` emits `VaultCreated`, vault address non-zero |
| 8.2 | `createVault — vaultFor(contractAddr) returns new vault address` | `vaultFactory.vaultFor(contractAddr)` returns the created vault |
| 8.3 | `createVault — deterministic CREATE2 address` | Pre-compute address using `computeVaultAddress(contractAddr)`, matches actual deployed address |
| 8.4 | `createVault — rejects duplicate vault for same contract` | Second call for same contractAddr reverts with "vault exists" |
| 8.5 | `depositGuard — emits AutoAuditTriggered when balance threshold met` | After depositing above threshold, `AutoAuditTriggered` event emitted |
| 8.6 | `getVaultCount — returns correct count after multiple vaults` | Three vaults created; `getAllVaults().length` = 3 |
| 8.7 | `isVault — returns true for factory-created vault, false for random` | Factory vault returns true; random address returns false |

---

### Suite 9 — AuditBudgetVault

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 9.1 | `createVault — emits VaultCreated with depositor and budget config` | `createVault(contractAddr, 50 GUARD/week, 100 GUARD critical)` emits `VaultCreated` |
| 9.2 | `depositFunds — increases vault balance, emits VaultDeposited` | `depositFunds(contractAddr, 500 GUARD)` emits `VaultDeposited`, currentBalance=500 |
| 9.3 | `drawPayment — authorized drawer can withdraw up to available balance` | AuditAuction (authorized) draws 50 GUARD, emits `PaymentDrawn` |
| 9.4 | `drawPayment — rejects unauthorized caller` | Stranger calling `drawPayment` reverts with "not authorized" |
| 9.5 | `drawMonitoringPayment — enforces weekly budget limit` | Two monitoring draws; first succeeds, second reverts when weekly budget would be exceeded |
| 9.6 | `drawMonitoringPayment — resets weekly budget after 7 days` | After `time.increase(7 days)`, weekly budget resets and draw succeeds again |
| 9.7 | `drawBounty — enforces criticalBountyAllocation cap` | Bounty draw exceeding criticalBountyAllocation reverts |
| 9.8 | `withdrawFunds — depositor can withdraw remaining balance` | Depositor calls `withdrawFunds(contractAddr, amount)`, emits `VaultWithdrawal` |
| 9.9 | `withdrawFunds — rejects non-depositor caller` | Stranger calling `withdrawFunds` reverts |
| 9.10 | `updateVaultRules — depositor can update budgets, emits VaultRulesUpdated` | Depositor updates weekly budget and critical allocation; emits `VaultRulesUpdated` |

---

### Suite 10 — TimeLockVault

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 10.1 | `deposit — emits Deposited with depositId, amount, unlockAt` | `deposit{value: 1 ether}(3600)` emits `Deposited`, depositId=1, unlockAt=now+3600 |
| 10.2 | `deposit — rejects zero-value deposit` | `deposit{value: 0}(3600)` reverts with "amount is zero" |
| 10.3 | `deposit — rejects zero unlock duration` | `deposit{value: 1 ether}(0)` reverts with "duration is zero" |
| 10.4 | `withdraw — rejects before unlockAt` | Immediately after deposit, `withdraw(depositId)` reverts with "still locked" |
| 10.5 | `withdraw — succeeds after unlockAt, emits Withdrawn` | `time.increase(3601)` then `withdraw(depositId)` emits `Withdrawn`, HBAR returned to depositor |
| 10.6 | `withdraw — rejects non-depositor caller` | Other address calling `withdraw(depositId)` reverts |
| 10.7 | `withdraw — rejects double withdrawal` | Second `withdraw(depositId)` after success reverts with "already withdrawn" |
| 10.8 | `emergencyWithdraw — owner can force-release any deposit` | `emergencyWithdraw(depositId)` emits `EmergencyWithdrawn`, funds sent to owner |
| 10.9 | `emergencyWithdraw — rejects non-owner caller` | Stranger calling `emergencyWithdraw` reverts |
| 10.10 | `totalLocked — reflects correct aggregate HBAR balance` | After two deposits of 1 ETH each, `totalLocked()` = 2 ETH |

---

### Suite 11 — Integration: Full Audit Lifecycle

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 11.1 | `Discovery → Job creation — orchestrator posts job from scanner data` | Scanner finds contract; orchestrator calls `createAuditJob`; job is AUCTION_OPEN |
| 11.2 | `Bidding phase — multiple agents bid with varying strategies` | 3 agents bid with different prices/ETAs; all bids escrowed; `getBidCount=3` |
| 11.3 | `Winner selection — highest-scoring bid wins` | `rankBids` returns correct order; `selectWinners` with top bid; others refunded |
| 11.4 | `Audit execution — winner completes audit, escrow released` | `releaseEscrow` releases payment to winner; reputation updated in registry |
| 11.5 | `Sub-auction — winner delegates dependency task` | Winner creates sub-auction; another agent wins; result delivered |
| 11.6 | `Data marketplace — winner sells findings` | Winner lists findings in DataMarketplace; third party purchases; fees flow to treasury |
| 11.7 | `Job completion — all winners paid, job marked COMPLETED` | After `releaseEscrow` for all winners + `completeJob`, status=COMPLETED, removed from activeJobs |
| 11.8 | `Slash flow — malicious agent slashed and stake seized` | Agent submits false report; `slashAgentBid(10000bps)` removes all collateral; `AgentSlashed` emitted |
| 11.9 | `Treasury distribution — accumulated fees distributed 40/50/10` | After lifecycle, `distributeRevenue()` splits to UCP/reserve/burn correctly |
| 11.10 | `Vault-triggered audit — AuditBudgetVault funds new job` | Vault funds are drawn when orchestrator creates job funded from vault |

---

### Suite 12 — Security & Edge Cases

| # | Test Name | What It Checks |
|---|-----------|---------------|
| 12.1 | `Zero-address rejection — all constructors reject address(0) inputs` | AgentRegistry, AuditAuction, Treasury constructors all revert on zero guard token |
| 12.2 | `Reentrancy guard — releaseEscrow cannot be re-entered` | Malicious agent contract attempting re-entry is blocked by `nonReentrant` |
| 12.3 | `Pausable — all Pausable contracts block mutations when paused` | AgentRegistry, AuditAuction: `pause()` blocks `registerAgent`, `submitBid`, `createAuditJob` |
| 12.4 | `Reputation clamping — cannot exceed 0..10000 range` | Repeated positive/negative updates never breach 0 or 10000 |
| 12.5 | `Slash bounds — AgentRegistry rejects slash bps=0 and >10000` | boundary bps values revert |
| 12.6 | `AuditAuction pause — paused by orchestrator, not owner` | Orchestrator (not owner) can pause AuditAuction |
| 12.7 | `AgentRegistry setOrchestratorAndAuction — can only be called once` | Second call reverts with "already configured" |

---

## File: `packages/contracts/test/AuditScheduler.test.js`

| # | Test Name | What It Checks |
|---|-----------|---------------|
| S.1 | `scheduleAudit TIME_BASED — emits AuditScheduled with all params` | Event has contractAddress, owner, scheduleAddress!=0x0, nextAuditDue>0, mode=TIME_BASED, intervalSeconds=30days |
| S.2 | `scheduleAudit TIME_BASED — stores correct schedule struct` | `getSchedule(addr)` returns owner, mode=TIME_BASED, intervalSeconds, active=true, timesTriggered=0 |
| S.3 | `scheduleAudit TIME_BASED — rejects interval < 1 hour` | 3599s reverts with "interval too short" |
| S.4 | `scheduleAudit TIME_BASED — rejects interval > 365 days` | 365×86400+1 reverts with "interval too long" |
| S.5 | `scheduleAudit TIME_BASED — appears in getActiveSchedules()` | After scheduling, address appears in array |
| S.6 | `scheduleAudit REDEPLOY — stores mode=REDEPLOY, scheduleAddress=0x0` | Event emitted with scheduleAddress=0x0, nextAuditDue=0; schedule.mode=REDEPLOY |
| S.7 | `triggerAudit — orchestrator triggers, emits AuditTriggered` | `timesTriggered=1`, correct `firedSchedule` address, `triggeredAt=block.timestamp` |
| S.8 | `triggerAudit — advances nextAuditDue by intervalSeconds` | nextAuditDue increases by exactly 30 days |
| S.9 | `triggerAudit — increments timesTriggered on each call` | Two calls: timesTriggered=2 |
| S.10 | `triggerAudit — rejects unauthorized caller (stranger)` | Reverts with "unauthorized caller" |
| S.11 | `triggerAudit — rejects call on inactive schedule` | After cancel, trigger reverts with "no active schedule" |
| S.12 | `cancelSchedule — emits AuditScheduleCancelled with reason="manual_cancel"` | Event has contractAddress, owner, reason |
| S.13 | `cancelSchedule — marks schedule inactive, removes from getActiveSchedules()` | schedule.active=false; address not in getActiveSchedules() array |
| S.14 | `cancelSchedule — rejects unauthorized caller` | Stranger reverts with "unauthorized" |
| S.15 | `onRedeployDetected — arms immediate schedule for REDEPLOY mode contract` | After detect: currentScheduleAddr!=0x0, nextAuditDue>0; emits AuditScheduled |
| S.16 | `onRedeployDetected — is a no-op for TIME_BASED contracts` | scheduleAddress unchanged after call on TIME_BASED contract |
| S.17 | `onRedeployDetected — rejects non-orchestrator caller` | Stranger calling reverts with "caller is not orchestrator" |
| S.18 | `setOrchestrator — owner can update, non-owner cannot` | Owner updates; stranger reverts with `OwnableUnauthorizedAccount` |

---

## Test Count Summary

| File | Suites | Test Cases |
|------|--------|-----------|
| AuditGuard.test.js | 12 | 115 |
| AuditScheduler.test.js | 6 | 18 |
| **Total** | **18** | **133** |

---

## Running the Tests

```bash
# All contract tests
npm --prefix packages/contracts test

# Watch mode
npm --prefix packages/contracts run test:watch

# Single file
npx hardhat --config packages/contracts/hardhat.config.js test packages/contracts/test/AuditScheduler.test.js

# With gas reporting
REPORT_GAS=true npm --prefix packages/contracts test
```
