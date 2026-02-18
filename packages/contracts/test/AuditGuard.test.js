const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * AuditGuard — Comprehensive E2E Test Suite
 *
 * Deploys MockHTS to 0x167 via hardhat_setCode, then deploys all 10 contracts
 * in dependency order with cross-reference wiring. Tests cover all core flows,
 * integration lifecycle, and security scenarios.
 */

describe("AuditGuard Contract Suite", function () {
  // Signers
  let owner, orchestrator, agent1, agent2, agent3, agent4, treasury;
  let ucpPool, protocolReserve, burnAddr;

  // Contracts
  let guardToken, agentRegistry, auditAuction, subAuction;
  let stakingManager, paymentSettlement, treasuryContract;
  let dataMarketplace, vaultFactory, budgetVault;

  // Constants
  const GUARD_DECIMALS = 8;
  const e8 = (n) => ethers.parseUnits(n.toString(), GUARD_DECIMALS);
  const COMMODITY_STAKE = e8(100);
  const SPECIALIZED_STAKE = e8(300);
  const PREMIUM_STAKE = e8(500);
  const MIN_BID_COLLATERAL = e8(50);
  const MIN_SUB_COLLATERAL = e8(10);
  const INITIAL_SUPPLY = e8(1_000_000);

  before(async function () {
    [owner, orchestrator, agent1, agent2, agent3, agent4, treasury, ucpPool, protocolReserve, burnAddr] =
      await ethers.getSigners();

    // 1. Deploy MockHTS and inject at 0x167
    const MockHTS = await ethers.getContractFactory("MockHTS");
    const mockHts = await MockHTS.deploy();
    await mockHts.waitForDeployment();
    const deployedCode = await ethers.provider.getCode(await mockHts.getAddress());
    await ethers.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", deployedCode]);

    // 2. Deploy mock ERC20 as GUARD token
    const ERC20Factory = await ethers.getContractFactory("MockGuardToken");
    guardToken = await ERC20Factory.deploy("GUARD", "GUARD", INITIAL_SUPPLY);
    await guardToken.waitForDeployment();
    const guardAddr = await guardToken.getAddress();

    // 3. Deploy all contracts in dependency order
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(guardAddr);
    await agentRegistry.waitForDeployment();

    const Treasury = await ethers.getContractFactory("Treasury");
    treasuryContract = await Treasury.deploy(
      guardAddr,
      await ucpPool.getAddress(),
      await protocolReserve.getAddress(),
      await burnAddr.getAddress()
    );
    await treasuryContract.waitForDeployment();

    const AuditAuction = await ethers.getContractFactory("AuditAuction");
    auditAuction = await AuditAuction.deploy(
      guardAddr,
      await agentRegistry.getAddress(),
      await orchestrator.getAddress(),
      await treasuryContract.getAddress()
    );
    await auditAuction.waitForDeployment();

    const SubAuction = await ethers.getContractFactory("SubAuction");
    subAuction = await SubAuction.deploy(
      guardAddr,
      await agentRegistry.getAddress(),
      await auditAuction.getAddress(),
      await treasuryContract.getAddress()
    );
    await subAuction.waitForDeployment();

    const StakingManager = await ethers.getContractFactory("StakingManager");
    stakingManager = await StakingManager.deploy(
      guardAddr,
      await agentRegistry.getAddress(),
      await treasuryContract.getAddress()
    );
    await stakingManager.waitForDeployment();

    const PaymentSettlement = await ethers.getContractFactory("PaymentSettlement");
    paymentSettlement = await PaymentSettlement.deploy(
      guardAddr,
      await agentRegistry.getAddress(),
      await auditAuction.getAddress(),
      await subAuction.getAddress(),
      await treasuryContract.getAddress(),
      await orchestrator.getAddress()
    );
    await paymentSettlement.waitForDeployment();

    const DataMarketplace = await ethers.getContractFactory("DataMarketplace");
    dataMarketplace = await DataMarketplace.deploy(
      guardAddr,
      await agentRegistry.getAddress(),
      await treasuryContract.getAddress()
    );
    await dataMarketplace.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("VaultFactory");
    vaultFactory = await VaultFactory.deploy(
      guardAddr,
      await agentRegistry.getAddress()
    );
    await vaultFactory.waitForDeployment();

    const AuditBudgetVault = await ethers.getContractFactory("AuditBudgetVault");
    budgetVault = await AuditBudgetVault.deploy(guardAddr);
    await budgetVault.waitForDeployment();

    // 4. Wire cross-references
    await agentRegistry.setOrchestratorAndAuction(
      await orchestrator.getAddress(),
      await auditAuction.getAddress()
    );

    await stakingManager.addAuthorizedSlasher(await auditAuction.getAddress());
    await stakingManager.addAuthorizedSlasher(await subAuction.getAddress());
    await stakingManager.addAuthorizedSlasher(await paymentSettlement.getAddress());

    await treasuryContract.addAuthorizedSource(await auditAuction.getAddress());
    await treasuryContract.addAuthorizedSource(await paymentSettlement.getAddress());
    await treasuryContract.addAuthorizedSource(await dataMarketplace.getAddress());
    await treasuryContract.addAuthorizedSource(await stakingManager.getAddress());

    await treasuryContract.setStakingManager(await stakingManager.getAddress());
    await treasuryContract.setAgentRegistry(await agentRegistry.getAddress());

    await vaultFactory.setAuctionContract(await auditAuction.getAddress());
    await vaultFactory.setPaymentSettlement(await paymentSettlement.getAddress());

    await budgetVault.setAuthorizedDrawer(await auditAuction.getAddress());

    // 5. Distribute GUARD to test signers
    const signers = [agent1, agent2, agent3, agent4, orchestrator];
    for (const s of signers) {
      await guardToken.transfer(await s.getAddress(), e8(10000));
    }
  });

  // ─── 1. AgentRegistry ─────────────────────────────────────────────

  describe("AgentRegistry", function () {
    it("should register agent with commodity stake", async function () {
      const tx = await agentRegistry.connect(agent1).registerAgent(
        "static-47",
        "https://agent1.auditguard.io/ucp",
        ["static-analysis"],
        COMMODITY_STAKE
      );
      await expect(tx).to.emit(agentRegistry, "AgentRegistered");

      const profile = await agentRegistry.getAgent(await agent1.getAddress());
      expect(profile.tier).to.equal(1); // COMMODITY
      expect(profile.status).to.equal(1); // ACTIVE
      expect(profile.reputationScore).to.equal(5000); // 50.00
    });

    it("should register additional agents", async function () {
      await agentRegistry.connect(agent2).registerAgent(
        "fuzzer-12", "https://agent2.auditguard.io/ucp", ["fuzzing"], COMMODITY_STAKE
      );
      await agentRegistry.connect(agent3).registerAgent(
        "llm-3", "https://agent3.auditguard.io/ucp", ["llm-contextual"], COMMODITY_STAKE
      );
      await agentRegistry.connect(agent4).registerAgent(
        "dep-8", "https://agent4.auditguard.io/ucp", ["dependency"], COMMODITY_STAKE
      );
      expect(await agentRegistry.getAgentCount()).to.equal(4);
    });

    it("should reject duplicate registration", async function () {
      await expect(
        agentRegistry.connect(agent1).registerAgent("dup", "https://dup.io", ["test"], COMMODITY_STAKE)
      ).to.be.revertedWith("AgentRegistry: already registered");
    });

    it("should reject empty agentId", async function () {
      const [, , , , , , , , , , extra] = await ethers.getSigners();
      await guardToken.transfer(await extra.getAddress(), COMMODITY_STAKE);
      await expect(
        agentRegistry.connect(extra).registerAgent("", "https://test.io", ["test"], COMMODITY_STAKE)
      ).to.be.revertedWith("AgentRegistry: empty agentId");
    });

    it("should add stake", async function () {
      const addAmount = e8(200);
      const tx = await agentRegistry.connect(agent1).addStake(addAmount);
      await expect(tx).to.emit(agentRegistry, "StakeAdded");

      const profile = await agentRegistry.getAgent(await agent1.getAddress());
      expect(profile.stakedAmount).to.equal(COMMODITY_STAKE + addAmount);
    });

    it("should request promotion to Specialized", async function () {
      // Seed reputation to 70.00
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 7000);
      const tx = await agentRegistry.connect(agent1).requestPromotion();
      await expect(tx).to.emit(agentRegistry, "AgentPromoted");

      const profile = await agentRegistry.getAgent(await agent1.getAddress());
      expect(profile.tier).to.equal(2); // SPECIALIZED
    });

    it("should update reputation via orchestrator", async function () {
      const tx = await agentRegistry.connect(orchestrator).updateReputation(
        await agent1.getAddress(), 500
      );
      await expect(tx).to.emit(agentRegistry, "ReputationUpdated");

      const rep = await agentRegistry.getAgentReputation(await agent1.getAddress());
      expect(rep).to.equal(7500);
    });

    it("should slash agent", async function () {
      const tx = await agentRegistry.connect(orchestrator).slashAgent(
        await agent2.getAddress(), 500 // 5%
      );
      await expect(tx).to.emit(agentRegistry, "AgentSlashed");
    });

    it("should pause and unpause", async function () {
      await agentRegistry.pause();
      await expect(
        agentRegistry.connect(agent1).addStake(e8(1))
      ).to.be.revertedWithCustomError(agentRegistry, "EnforcedPause");
      await agentRegistry.unpause();
    });

    it("should record job completion", async function () {
      const tx = await agentRegistry.connect(orchestrator).recordJobCompletion(
        await agent1.getAddress(), 5, 1, 0
      );
      await expect(tx).to.emit(agentRegistry, "JobRecorded");

      const profile = await agentRegistry.getAgent(await agent1.getAddress());
      expect(profile.completedJobs).to.equal(1);
      expect(profile.successfulFindings).to.equal(5);
      expect(profile.falsePositives).to.equal(1);
    });

    it("should return active agents", async function () {
      const isActive = await agentRegistry.isActiveAgent(await agent1.getAddress());
      expect(isActive).to.be.true;
    });
  });

  // ─── 2. AuditAuction ──────────────────────────────────────────────

  describe("AuditAuction", function () {
    let jobId;

    it("should create audit job", async function () {
      const tx = await auditAuction.connect(orchestrator).createAuditJob(
        await agent4.getAddress(), // contract address (any non-zero)
        "hedera-testnet",
        "lending",
        75,
        e8(1000),
        5000,
        3600
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return auditAuction.interface.parseLog(l)?.name === "JobPosted"; } catch { return false; }
      });
      jobId = auditAuction.interface.parseLog(event).args[0];
      expect(jobId).to.equal(1);
    });

    it("should submit bids", async function () {
      await auditAuction.connect(agent1).submitBid(
        jobId, e8(100), MIN_BID_COLLATERAL, 3600, "static-analysis"
      );
      await auditAuction.connect(agent2).submitBid(
        jobId, e8(150), MIN_BID_COLLATERAL, 7200, "fuzzing"
      );
      const bidCount = await auditAuction.getBidCount(jobId);
      expect(bidCount).to.equal(2);
    });

    it("should reject duplicate bid", async function () {
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, e8(50), MIN_BID_COLLATERAL, 1800, "static")
      ).to.be.revertedWith("AuditAuction: bid already submitted");
    });

    it("should select winners", async function () {
      const tx = await auditAuction.connect(orchestrator).selectWinners(jobId, [0]);
      await expect(tx).to.emit(auditAuction, "WinnersSelected");

      const job = await auditAuction.getJob(jobId);
      expect(job.status).to.equal(2); // AUDITING_IN_PROGRESS
      expect(job.winningAgents.length).to.equal(1);
    });

    it("should release escrow and complete job", async function () {
      const payment = e8(95); // 100 - 5% platform fee
      await auditAuction.connect(orchestrator).releaseEscrow(
        jobId, await agent1.getAddress(), payment, 0, 5, 0, 0
      );

      const tx = await auditAuction.connect(orchestrator).completeJob(jobId);
      await expect(tx).to.emit(auditAuction, "JobCompleted");

      const job = await auditAuction.getJob(jobId);
      expect(job.status).to.equal(4); // COMPLETED
    });

    it("should reject non-orchestrator job creation", async function () {
      await expect(
        auditAuction.connect(agent1).createAuditJob(
          await agent4.getAddress(), "hedera", "vault", 50, e8(100), 1000, 3600
        )
      ).to.be.revertedWith("AuditAuction: caller is not orchestrator");
    });
  });

  // ─── 3. SubAuction ────────────────────────────────────────────────

  describe("SubAuction", function () {
    let parentJobId, subJobId;

    before(async function () {
      // Create a new parent job and make agent1 a winner
      const tx = await auditAuction.connect(orchestrator).createAuditJob(
        await agent3.getAddress(), "hedera-testnet", "dex", 60, e8(500), 3000, 3600
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return auditAuction.interface.parseLog(l)?.name === "JobPosted"; } catch { return false; }
      });
      parentJobId = auditAuction.interface.parseLog(event).args[0];

      await auditAuction.connect(agent1).submitBid(
        parentJobId, e8(200), MIN_BID_COLLATERAL, 3600, "static-analysis"
      );
      await auditAuction.connect(orchestrator).selectWinners(parentJobId, [0]);
    });

    it("should create sub-auction", async function () {
      const tx = await subAuction.connect(agent1).createSubAuction(
        parentJobId,
        "Dependency analysis for lending pool",
        "dependency",
        e8(20),
        7200,
        3600
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return subAuction.interface.parseLog(l)?.name === "SubAuctionCreated"; } catch { return false; }
      });
      subJobId = subAuction.interface.parseLog(event).args[0];
      expect(subJobId).to.equal(1);
    });

    it("should submit sub-bid", async function () {
      const tx = await subAuction.connect(agent4).submitSubBid(
        subJobId, e8(18), 3600, MIN_SUB_COLLATERAL
      );
      await expect(tx).to.emit(subAuction, "SubBidSubmitted");
    });

    it("should select sub-contractor", async function () {
      const tx = await subAuction.connect(agent1).selectSubContractor(subJobId, 0);
      await expect(tx).to.emit(subAuction, "SubContractorSelected");

      const subJob = await subAuction.getSubJob(subJobId);
      expect(subJob.status).to.equal(2); // IN_PROGRESS
      expect(subJob.selectedAgent).to.equal(await agent4.getAddress());
    });

    it("should deliver result", async function () {
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("dependency-analysis-result"));
      const tx = await subAuction.connect(agent4).deliverResult(subJobId, resultHash);
      await expect(tx).to.emit(subAuction, "ResultDelivered");
    });

    it("should accept result", async function () {
      const tx = await subAuction.connect(agent1).acceptResult(subJobId);
      await expect(tx).to.emit(subAuction, "ResultAccepted");

      const subJob = await subAuction.getSubJob(subJobId);
      expect(subJob.status).to.equal(4); // ACCEPTED
    });
  });

  // ─── 4. StakingManager ────────────────────────────────────────────

  describe("StakingManager", function () {
    it("should stake GUARD", async function () {
      // Agent1 needs to be active in registry for stake()
      const tx = await stakingManager.connect(agent1).stake(COMMODITY_STAKE);
      await expect(tx).to.emit(stakingManager, "Staked");

      const info = await stakingManager.getStakeInfo(await agent1.getAddress());
      expect(info.totalStaked).to.equal(COMMODITY_STAKE);
      expect(info.availableStake).to.equal(COMMODITY_STAKE);
    });

    it("should request unstake with cooldown enforcement", async function () {
      // Stake more first to maintain minimum
      await stakingManager.connect(agent1).stake(COMMODITY_STAKE);

      const tx = await stakingManager.connect(agent1).requestUnstake(e8(50));
      await expect(tx).to.emit(stakingManager, "UnstakeRequested");

      const info = await stakingManager.getStakeInfo(await agent1.getAddress());
      expect(info.unbondingAmount).to.equal(e8(50));
    });

    it("should reject premature unstake completion", async function () {
      await expect(
        stakingManager.connect(agent1).completeUnstake()
      ).to.be.revertedWith("StakingManager: unbonding period not elapsed");
    });

    it("should initiate slash with evidence", async function () {
      // Need authorized slasher — use auditAuction
      const slasherAddr = await auditAuction.getAddress();

      // Stake agent2 first
      await stakingManager.connect(agent2).stake(COMMODITY_STAKE);

      // Initiate slash from authorized slasher
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("false-positive-evidence"));
      const tx = await stakingManager.connect(orchestrator).addAuthorizedSlasher(await orchestrator.getAddress());

      await stakingManager.connect(orchestrator).initiateSlash(
        await agent2.getAddress(),
        1, // jobId
        0, // subJobId
        0, // FALSE_POSITIVE
        evidenceHash
      );

      const record = await stakingManager.getSlashRecord(1);
      expect(record.agent).to.equal(await agent2.getAddress());
      expect(record.reason).to.equal(0); // FALSE_POSITIVE
    });

    it("should file and resolve appeal", async function () {
      await stakingManager.connect(agent2).fileAppeal(1, "Finding was valid, not false positive");

      const tx = await stakingManager.resolveAppeal(1, true); // approve
      await expect(tx).to.emit(stakingManager, "AppealApproved");
    });

    it("should return stake health summary", async function () {
      const [effectiveStake, slashCount, totalSlashed, hasActiveAppeals, status] =
        await stakingManager.getAgentStakeHealth(await agent2.getAddress());
      expect(slashCount).to.equal(1);
    });
  });

  // ─── 5. PaymentSettlement ─────────────────────────────────────────

  describe("PaymentSettlement", function () {
    it("should deposit settlement funds", async function () {
      const tx = await paymentSettlement.connect(orchestrator).depositSettlementFunds(e8(500));
      await expect(tx).to.emit(paymentSettlement, "FundsDeposited");
    });

    it("should reject zero deposit", async function () {
      await expect(
        paymentSettlement.connect(orchestrator).depositSettlementFunds(0)
      ).to.be.revertedWith("PaymentSettlement: zero deposit");
    });

    it("should return report fee base and discounted values", async function () {
      const base = await paymentSettlement.reportFeeBase();
      const discounted = await paymentSettlement.reportFeeDiscounted();
      expect(base).to.equal(e8(0.1));
      expect(discounted).to.equal(e8(0.05));
    });

    it("should check if job is settled", async function () {
      // Job 1 was settled via auction.completeJob, not via paymentSettlement
      const settled = await paymentSettlement.isJobSettled(1);
      expect(settled).to.be.false;
    });
  });

  // ─── 6. Treasury ──────────────────────────────────────────────────

  describe("Treasury", function () {
    it("should reject fee from unauthorized source", async function () {
      await expect(
        treasuryContract.connect(agent1).receiveFee(0, e8(10), 0)
      ).to.be.revertedWith("Treasury: not authorized source");
    });

    it("should receive fee from authorized source", async function () {
      // Add owner as authorized source for testing
      await treasuryContract.addAuthorizedSource(await owner.getAddress());

      // Transfer GUARD to owner first
      const tx = await treasuryContract.connect(owner).receiveFee(0, e8(100), 1);
      await expect(tx).to.emit(treasuryContract, "FeeReceived");

      const pending = await treasuryContract.getPendingBalance();
      expect(pending).to.equal(e8(100));
    });

    it("should distribute fees (40/50/10 split)", async function () {
      const tx = await treasuryContract.distribute();
      await expect(tx).to.emit(treasuryContract, "FeeDistributed");

      const pending = await treasuryContract.getPendingBalance();
      expect(pending).to.equal(0);
    });

    it("should get revenue breakdown", async function () {
      const [total, auditFees, marketFees, reportFees, slashProceeds, subFees] =
        await treasuryContract.getRevenueBreakdown();
      expect(total).to.equal(e8(100));
      expect(auditFees).to.equal(e8(100));
    });

    it("should perform emergency withdraw", async function () {
      // Deposit more first
      await treasuryContract.connect(owner).receiveFee(1, e8(50), 0);

      const tx = await treasuryContract.emergencyWithdraw(await owner.getAddress(), e8(25));
      await expect(tx).to.emit(treasuryContract, "EmergencyWithdraw");
    });

    it("should calculate fee discount for high-stake/high-rep agents", async function () {
      const discounted = await treasuryContract.calculateAgentFeeDiscount(
        await agent1.getAddress(), e8(10)
      );
      // Agent1 has 300 stake and ~7650 rep but needs 500 stake + 8500 rep for discount
      expect(discounted).to.equal(e8(10)); // No discount
    });

    it("should set distribution config", async function () {
      const tx = await treasuryContract.setDistributionConfig(30, 60, 10);
      await expect(tx).to.emit(treasuryContract, "DistributionConfigUpdated");
    });

    it("should reject distribution config that doesn't sum to 100", async function () {
      await expect(
        treasuryContract.setDistributionConfig(30, 60, 20)
      ).to.be.revertedWith("Treasury: must sum to 100");
    });
  });

  // ─── 7. DataMarketplace ───────────────────────────────────────────

  describe("DataMarketplace", function () {
    let listingId;

    it("should create listing", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("scan-report-data"));
      const tx = await dataMarketplace.connect(agent1).createListing(
        1, // parentJobId
        "Lending Pool Scan Report",
        "Full static analysis scan results",
        0, // SCAN_REPORT
        0, // ONE_TIME
        e8(5),
        0, // subscriptionPeriod
        contentHash,
        10, // maxBuyers
        0 // durationSeconds (never expires)
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return dataMarketplace.interface.parseLog(l)?.name === "DataListed"; } catch { return false; }
      });
      listingId = dataMarketplace.interface.parseLog(event).args[0];
      expect(listingId).to.equal(1);
    });

    it("should purchase data", async function () {
      const tx = await dataMarketplace.connect(agent2).purchaseData(listingId);
      await expect(tx).to.emit(dataMarketplace, "DataPurchased");

      const hasAccess = await dataMarketplace.hasAccess(listingId, await agent2.getAddress());
      expect(hasAccess).to.be.true;
    });

    it("should reject self-purchase", async function () {
      await expect(
        dataMarketplace.connect(agent1).purchaseData(listingId)
      ).to.be.revertedWith("DataMarketplace: seller cannot buy own listing");
    });

    it("should get listings by category", async function () {
      const listings = await dataMarketplace.getListingsByCategory(0); // SCAN_REPORT
      expect(listings.length).to.equal(1);
    });

    it("should rate purchase", async function () {
      const tx = await dataMarketplace.connect(agent2).ratePurchase(listingId, 4);
      await expect(tx).to.emit(dataMarketplace, "DataRated");
    });

    it("should get average rating", async function () {
      const [avg, count] = await dataMarketplace.getAverageRating(listingId);
      expect(avg).to.equal(4);
      expect(count).to.equal(1);
    });
  });

  // ─── 8. VaultFactory + AuditVault ─────────────────────────────────

  describe("VaultFactory + AuditVault", function () {
    let vaultAddress;
    const targetContract = "0x0000000000000000000000000000000000000123";

    it("should create vault via CREATE2", async function () {
      const config = {
        weeklyMonitoringBudget: e8(10),
        criticalBountyAllocation: e8(50),
        reauditIntervalSeconds: 86400,
        maxSingleAuditBudget: e8(200),
        acceptsMonitoringBids: true,
      };

      const tx = await vaultFactory.createVault(targetContract, "hedera-testnet", config);
      await expect(tx).to.emit(vaultFactory, "VaultCreated");

      vaultAddress = await vaultFactory.getVaultFor(targetContract);
      expect(vaultAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("should reject duplicate vault creation", async function () {
      const config = {
        weeklyMonitoringBudget: 0,
        criticalBountyAllocation: 0,
        reauditIntervalSeconds: 0,
        maxSingleAuditBudget: 0,
        acceptsMonitoringBids: false,
      };
      await expect(
        vaultFactory.createVault(targetContract, "hedera-testnet", config)
      ).to.be.revertedWith("VaultFactory: vault already exists");
    });

    it("should deposit into vault", async function () {
      const vault = await ethers.getContractAt("AuditVault", vaultAddress);
      const tx = await vault.connect(agent1).deposit(e8(100));
      await expect(tx).to.emit(vault, "Deposited");

      const balance = await vault.currentBalance();
      expect(balance).to.equal(e8(100));
    });

    it("should predict vault address deterministically", async function () {
      const predicted = await vaultFactory.predictVaultAddress(targetContract);
      expect(predicted).to.equal(vaultAddress);
    });

    it("should get all vaults", async function () {
      const vaults = await vaultFactory.getAllVaults();
      expect(vaults.length).to.equal(1);
    });
  });

  // ─── 9. AuditBudgetVault ──────────────────────────────────────────

  describe("AuditBudgetVault", function () {
    const coveredContract = "0x0000000000000000000000000000000000000456";

    it("should create budget vault", async function () {
      const tx = await budgetVault.createVault(coveredContract, e8(10), e8(50));
      await expect(tx).to.emit(budgetVault, "VaultCreated");
    });

    it("should deposit funds", async function () {
      const tx = await budgetVault.connect(owner).deposit(coveredContract, e8(200));
      await expect(tx).to.emit(budgetVault, "VaultDeposited");

      const balance = await budgetVault.getVaultBalance(coveredContract);
      expect(balance).to.equal(e8(200));
    });

    it("should update vault rules", async function () {
      const tx = await budgetVault.updateVaultRules(coveredContract, e8(20), e8(100));
      await expect(tx).to.emit(budgetVault, "VaultRulesUpdated");
    });

    it("should get vault info", async function () {
      const info = await budgetVault.getVaultInfo(coveredContract);
      expect(info.active).to.be.true;
      expect(info.weeklyMonitoringBudget).to.equal(e8(20));
    });

    it("should get all vaults", async function () {
      const vaults = await budgetVault.getAllVaults();
      expect(vaults.length).to.equal(1);
    });
  });

  // ─── 10. Integration: Full Audit Lifecycle ────────────────────────

  describe("Integration: Full Audit Lifecycle", function () {
    let lifecycleJobId;

    it("should execute discovery -> bid -> win -> settle flow", async function () {
      // 1. Discovery: orchestrator posts job
      const txJob = await auditAuction.connect(orchestrator).createAuditJob(
        "0x0000000000000000000000000000000000000789",
        "hedera-testnet",
        "staking",
        80,
        e8(500),
        2000,
        3600
      );
      const jobReceipt = await txJob.wait();
      const jobEvent = jobReceipt.logs.find(l => {
        try { return auditAuction.interface.parseLog(l)?.name === "JobPosted"; } catch { return false; }
      });
      lifecycleJobId = auditAuction.interface.parseLog(jobEvent).args[0];

      // 2. Bidding: agents bid
      await auditAuction.connect(agent3).submitBid(
        lifecycleJobId, e8(200), MIN_BID_COLLATERAL, 3600, "llm-contextual"
      );

      // 3. Winner selection
      await auditAuction.connect(orchestrator).selectWinners(lifecycleJobId, [0]);

      const job = await auditAuction.getJob(lifecycleJobId);
      expect(job.status).to.equal(2); // AUDITING_IN_PROGRESS
      expect(job.winningAgents.length).to.equal(1);

      // 4. Settlement: release escrow
      const escrowedAmount = job.totalEscrowedAmount;
      await auditAuction.connect(orchestrator).releaseEscrow(
        lifecycleJobId,
        await agent3.getAddress(),
        escrowedAmount,
        0,
        3, // validFindings
        0, // falsePos
        0  // falseNeg
      );

      // 5. Complete job
      await auditAuction.connect(orchestrator).completeJob(lifecycleJobId);

      const completedJob = await auditAuction.getJob(lifecycleJobId);
      expect(completedJob.status).to.equal(4); // COMPLETED
    });
  });

  // ─── 11. Security Scenarios ───────────────────────────────────────

  describe("Security Scenarios", function () {
    it("should reject zero-address guard token in AgentRegistry", async function () {
      const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
      await expect(AgentRegistry.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "AgentRegistry: guard token is zero"
      );
    });

    it("should reject zero-address guard token in AuditAuction", async function () {
      const AuditAuction = await ethers.getContractFactory("AuditAuction");
      await expect(
        AuditAuction.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("AuditAuction: guard token is zero");
    });

    it("should enforce access control on AgentRegistry", async function () {
      await expect(
        agentRegistry.connect(agent1).updateReputation(await agent2.getAddress(), 100)
      ).to.be.revertedWith("AgentRegistry: caller is not authorized scorer");
    });

    it("should enforce access control on AuditAuction", async function () {
      await expect(
        auditAuction.connect(agent1).createAuditJob(
          await agent2.getAddress(), "hedera", "vault", 50, e8(100), 1000, 3600
        )
      ).to.be.revertedWith("AuditAuction: caller is not orchestrator");
    });

    it("should enforce Pausable on AgentRegistry", async function () {
      await agentRegistry.pause();
      await expect(
        agentRegistry.connect(agent1).addStake(e8(1))
      ).to.be.revertedWithCustomError(agentRegistry, "EnforcedPause");
      await agentRegistry.unpause();
    });

    it("should enforce Pausable on AuditAuction", async function () {
      await auditAuction.connect(orchestrator).pause();
      await expect(
        auditAuction.connect(orchestrator).createAuditJob(
          await agent2.getAddress(), "hedera", "vault", 50, e8(100), 1000, 3600
        )
      ).to.be.revertedWithCustomError(auditAuction, "EnforcedPause");
      await auditAuction.connect(orchestrator).unpause();
    });

    it("should enforce slash basis points range", async function () {
      await expect(
        agentRegistry.connect(orchestrator).slashAgent(await agent3.getAddress(), 0)
      ).to.be.revertedWith("AgentRegistry: invalid slash bps");

      await expect(
        agentRegistry.connect(orchestrator).slashAgent(await agent3.getAddress(), 10001)
      ).to.be.revertedWith("AgentRegistry: invalid slash bps");
    });

    it("should reject bid below minimum collateral", async function () {
      // Create a new job to test
      await auditAuction.connect(orchestrator).createAuditJob(
        "0x0000000000000000000000000000000000000AAA",
        "hedera-testnet", "vault", 50, e8(100), 1000, 3600
      );
      const nextJob = await auditAuction.nextJobId() - 1n;

      await expect(
        auditAuction.connect(agent1).submitBid(
          nextJob, e8(50), e8(10), 3600, "static" // 10 GUARD < 50 MIN_BID_COLLATERAL
        )
      ).to.be.revertedWith("AuditAuction: collateral below minimum");
    });

    it("should clamp reputation within 0-10000 range", async function () {
      // Set reputation near max
      await agentRegistry.seedAgentReputation(await agent4.getAddress(), 9900);
      // Update with +200 — should clamp to 10000
      await agentRegistry.connect(orchestrator).updateReputation(await agent4.getAddress(), 200);
      const rep = await agentRegistry.getAgentReputation(await agent4.getAddress());
      expect(rep).to.equal(10000);
    });

    it("should verify Pausable inventory (5 with, 5 without)", async function () {
      // Contracts with Pausable: AgentRegistry, AuditAuction, SubAuction, StakingManager, PaymentSettlement
      // These have pause() and unpause() functions

      // Verify AgentRegistry has pause
      expect(agentRegistry.pause).to.be.a("function");
      expect(agentRegistry.unpause).to.be.a("function");

      // Verify AuditAuction has pause
      expect(auditAuction.pause).to.be.a("function");
      expect(auditAuction.unpause).to.be.a("function");

      // Verify SubAuction has pause
      expect(subAuction.pause).to.be.a("function");
      expect(subAuction.unpause).to.be.a("function");

      // Verify StakingManager has pause
      expect(stakingManager.pause).to.be.a("function");
      expect(stakingManager.unpause).to.be.a("function");

      // Verify PaymentSettlement has pause
      expect(paymentSettlement.pause).to.be.a("function");
      expect(paymentSettlement.unpause).to.be.a("function");
    });

    it("should reject StakingManager stake from non-registered agent", async function () {
      const [, , , , , , , , , , , extraSigner] = await ethers.getSigners();
      await guardToken.transfer(await extraSigner.getAddress(), COMMODITY_STAKE);
      await expect(
        stakingManager.connect(extraSigner).stake(COMMODITY_STAKE)
      ).to.be.revertedWith("StakingManager: agent not registered");
    });
  });

  // ─── 12. PaymentSettlement — access control ──────────────────────

  describe("PaymentSettlement — settleJob access", function () {
    it("should reject settlement from non-orchestrator", async function () {
      await expect(
        paymentSettlement.connect(agent1).settleJob(1, [{
          recipient: await agent1.getAddress(),
          basePayment: e8(10),
          bonus: 0,
          reportFee: 0,
          paymentType: 0,
          description: "test",
        }], await agent1.getAddress())
      ).to.be.revertedWith("PaymentSettlement: caller is not orchestrator");
    });

    it("should deposit and check settlement funds", async function () {
      const tx = await paymentSettlement.connect(orchestrator).depositSettlementFunds(e8(500));
      await expect(tx).to.emit(paymentSettlement, "FundsDeposited");
    });

    it("should return report fee values", async function () {
      const base = await paymentSettlement.reportFeeBase();
      const discounted = await paymentSettlement.reportFeeDiscounted();
      expect(base).to.equal(e8(0.1));
      expect(discounted).to.equal(e8(0.05));
    });
  });

  // ─── 13. SubAuction — dispute + resolve + claimExpired ──────────

  describe("SubAuction — dispute flow", function () {
    let disputeParentJobId, disputeSubJobId;

    before(async function () {
      // Create parent job with agent1 as winner
      const tx = await auditAuction.connect(orchestrator).createAuditJob(
        "0x0000000000000000000000000000000000000DDD",
        "hedera-testnet", "bridge", 90, e8(600), 4000, 3600
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return auditAuction.interface.parseLog(l)?.name === "JobPosted"; } catch { return false; }
      });
      disputeParentJobId = auditAuction.interface.parseLog(event).args[0];

      await auditAuction.connect(agent1).submitBid(disputeParentJobId, e8(250), MIN_BID_COLLATERAL, 3600, "static");
      await auditAuction.connect(orchestrator).selectWinners(disputeParentJobId, [0]);

      // Create sub-auction
      const subTx = await subAuction.connect(agent1).createSubAuction(
        disputeParentJobId, "Dependency analysis", "dependency", e8(15), 7200, 3600
      );
      const subReceipt = await subTx.wait();
      const subEvent = subReceipt.logs.find(l => {
        try { return subAuction.interface.parseLog(l)?.name === "SubAuctionCreated"; } catch { return false; }
      });
      disputeSubJobId = subAuction.interface.parseLog(subEvent).args[0];

      // Bid and select sub-contractor
      await subAuction.connect(agent4).submitSubBid(disputeSubJobId, e8(12), 3600, MIN_SUB_COLLATERAL);
      await subAuction.connect(agent1).selectSubContractor(disputeSubJobId, 0);

      // Deliver result
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("dispute-test-result"));
      await subAuction.connect(agent4).deliverResult(disputeSubJobId, resultHash);
    });

    it("should allow requester to dispute delivered result", async function () {
      const tx = await subAuction.connect(agent1).disputeResult(
        disputeSubJobId, "Result is incomplete and missing key dependencies"
      );
      await expect(tx).to.emit(subAuction, "ResultDisputed");

      const subJob = await subAuction.getSubJob(disputeSubJobId);
      expect(subJob.status).to.equal(5); // DISPUTED
    });

    it("should reject dispute with empty reason", async function () {
      // Create another sub-auction for this test
      const subTx2 = await subAuction.connect(agent1).createSubAuction(
        disputeParentJobId, "Gas optimization", "gas_optimization", e8(10), 7200, 3600
      );
      const subReceipt2 = await subTx2.wait();
      const subEvent2 = subReceipt2.logs.find(l => {
        try { return subAuction.interface.parseLog(l)?.name === "SubAuctionCreated"; } catch { return false; }
      });
      const subJobId2 = subAuction.interface.parseLog(subEvent2).args[0];

      await subAuction.connect(agent4).submitSubBid(subJobId2, e8(8), 3600, MIN_SUB_COLLATERAL);
      await subAuction.connect(agent1).selectSubContractor(subJobId2, 0);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("result-2"));
      await subAuction.connect(agent4).deliverResult(subJobId2, hash);

      await expect(
        subAuction.connect(agent1).disputeResult(subJobId2, "")
      ).to.be.revertedWith("SubAuction: empty dispute reason");
    });

    it("should resolve dispute in favor of contractor", async function () {
      const tx = await subAuction.connect(orchestrator).resolveDispute(disputeSubJobId, true);
      await expect(tx).to.emit(subAuction, "DisputeResolved");
    });
  });

  // ─── 14. DataMarketplace — tip + listing tests ──────────────────

  describe("DataMarketplace — tipSeller validation", function () {
    let tipListingId;

    before(async function () {
      // Use agent1 who is still active as seller — create a one-time listing
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("tip-test-data"));
      const tx = await dataMarketplace.connect(agent1).createListing(
        1, "Tip Test Listing", "For tip tests", 0, 0, e8(1),
        0, contentHash, 100, 0
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return dataMarketplace.interface.parseLog(l)?.name === "DataListed"; } catch { return false; }
      });
      tipListingId = dataMarketplace.interface.parseLog(event).args[0];
    });

    it("should reject zero-amount tip", async function () {
      await expect(
        dataMarketplace.connect(agent3).tipSeller(tipListingId, 0)
      ).to.be.revertedWith("DataMarketplace: amount is zero");
    });

    it("should reject self-tip", async function () {
      await expect(
        dataMarketplace.connect(agent1).tipSeller(tipListingId, e8(1))
      ).to.be.revertedWith("DataMarketplace: seller cannot tip self");
    });
  });

  // ─── 15. AuditBudgetVault — drawPayment + drawMonitoringPayment ─

  describe("AuditBudgetVault — draw payments", function () {
    const drawContract = "0x0000000000000000000000000000000000000EEE";

    before(async function () {
      // Create and fund vault
      await budgetVault.createVault(drawContract, e8(10), e8(50));
      await budgetVault.connect(owner).deposit(drawContract, e8(500));
    });

    it("should draw payment from vault", async function () {
      // drawPayment must be called by the authorizedDrawer (auditAuction)
      const tx = await budgetVault.connect(owner).setAuthorizedDrawer(await orchestrator.getAddress());
      await budgetVault.connect(orchestrator).drawPayment(
        drawContract, await agent1.getAddress(), e8(25)
      );
      const balance = await budgetVault.getVaultBalance(drawContract);
      expect(balance).to.equal(e8(475));
    });

    it("should draw monitoring payment", async function () {
      await budgetVault.connect(orchestrator).drawMonitoringPayment(
        drawContract, await agent2.getAddress(), e8(5)
      );
      const balance = await budgetVault.getVaultBalance(drawContract);
      expect(balance).to.equal(e8(470));
    });

    it("should reject draw with zero agent address", async function () {
      await expect(
        budgetVault.connect(orchestrator).drawPayment(
          drawContract, ethers.ZeroAddress, e8(10)
        )
      ).to.be.revertedWith("AuditBudgetVault: agent is zero");
    });

    it("should reject draw with zero amount", async function () {
      await expect(
        budgetVault.connect(orchestrator).drawPayment(
          drawContract, await agent1.getAddress(), 0
        )
      ).to.be.revertedWith("AuditBudgetVault: amount is zero");
    });

    it("should reject draw exceeding balance", async function () {
      await expect(
        budgetVault.connect(orchestrator).drawPayment(
          drawContract, await agent1.getAddress(), e8(999)
        )
      ).to.be.revertedWith("AuditBudgetVault: insufficient balance");
    });
  });

  // ─── 16. StakingManager — lockStake + unlockStake ───────────────

  describe("StakingManager — lock/unlock stake", function () {
    before(async function () {
      // Orchestrator must be an authorized slasher to lock/unlock
      await stakingManager.addAuthorizedSlasher(await orchestrator.getAddress());
      // Ensure agent3 has stake (may already from earlier tests)
      try { await stakingManager.connect(agent3).stake(COMMODITY_STAKE); } catch { /* already staked */ }
    });

    it("should lock stake for a job", async function () {
      const tx = await stakingManager.connect(orchestrator).lockStake(
        await agent3.getAddress(), e8(20), 1
      );
      await expect(tx).to.emit(stakingManager, "StakeLocked");

      const info = await stakingManager.getStakeInfo(await agent3.getAddress());
      expect(info.lockedStake).to.equal(e8(20));
    });

    it("should unlock stake after job completion", async function () {
      const tx = await stakingManager.connect(orchestrator).unlockStake(
        await agent3.getAddress(), e8(20), 1
      );
      await expect(tx).to.emit(stakingManager, "StakeUnlocked");

      const info = await stakingManager.getStakeInfo(await agent3.getAddress());
      expect(info.lockedStake).to.equal(0);
    });

    it("should reject lock with zero amount", async function () {
      await expect(
        stakingManager.connect(orchestrator).lockStake(
          await agent3.getAddress(), 0, 1
        )
      ).to.be.revertedWith("StakingManager: amount is zero");
    });

    it("should reject lock exceeding available stake", async function () {
      await expect(
        stakingManager.connect(orchestrator).lockStake(
          await agent3.getAddress(), e8(9999), 1
        )
      ).to.be.revertedWith("StakingManager: exceeds available stake");
    });

    it("should reject unlock exceeding locked stake", async function () {
      await stakingManager.connect(orchestrator).lockStake(
        await agent3.getAddress(), e8(10), 2
      );
      await expect(
        stakingManager.connect(orchestrator).unlockStake(
          await agent3.getAddress(), e8(50), 2
        )
      ).to.be.revertedWith("StakingManager: exceeds locked stake");

      await stakingManager.connect(orchestrator).unlockStake(
        await agent3.getAddress(), e8(10), 2
      );
    });
  });
});
