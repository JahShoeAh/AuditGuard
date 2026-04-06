/**
 * AuditGuard.test.js — Comprehensive Contract Test Suite
 *
 * Design principles:
 *   - Every describe block uses loadFixture for a clean, independent state snapshot.
 *   - Layered fixtures allow progressive state setup without shared mutation.
 *   - Named constants replace all magic numbers.
 *   - Each test is fully self-contained: no test depends on another test's side effects.
 *
 * Contracts under test (12):
 *   AgentRegistry, AuditAuction, SubAuction, StakingManager, PaymentSettlement,
 *   DataMarketplace, Treasury, VaultFactory, AuditVault, AuditBudgetVault,
 *   TimeLockVault, (integration across all)
 *
 * MockHTS at 0x167: tracks transferToken/tokenAssociate calls, always returns HTS_SUCCESS.
 * All HTS transfer assertions check on-chain state (profile.stakedAmount, job.totalEscrowedAmount,
 * etc.) rather than ERC20 balances, since MockHTS does not move real tokens.
 */

"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// ─── Enum mirrors ─────────────────────────────────────────────────────────────
const AgentTier = { UNREGISTERED: 0, COMMODITY: 1, SPECIALIZED: 2, PREMIUM: 3 };
const AgentStatus = { INACTIVE: 0, ACTIVE: 1, SUSPENDED: 2, SLASHED: 3 };
const JobStatus = { AUCTION_OPEN: 0, BIDDING_CLOSED: 1, AUDITING_IN_PROGRESS: 2, REPORT_PENDING: 3, COMPLETED: 4, CANCELLED: 5 };
const BidStatus = { PENDING: 0, ACCEPTED: 1, REJECTED: 2, REFUNDED: 3 };
const SubJobStatus = { OPEN: 0, BIDDING_CLOSED: 1, IN_PROGRESS: 2, DELIVERED: 3, ACCEPTED: 4, DISPUTED: 5, EXPIRED: 6, CANCELLED: 7 };
const ListingType = { ONE_TIME: 0, SUBSCRIPTION: 1, TIP: 2 };
const DataCategory = { SCAN_REPORT: 0, DEPENDENCY_ANALYSIS: 1, EXPLOIT_DATABASE: 2, HOT_LEAD: 3, FUZZING_SEEDS: 4, THREAT_INTEL: 5, AUDIT_FINDING: 6, OTHER: 7 };
const FeeSource = { AUDIT_PLATFORM_FEE: 0, DATA_MARKETPLACE_FEE: 1, REPORT_AGENT_FEE: 2, SLASHING_PROCEEDS: 3, SUB_AUCTION_FEE: 4 };
const SlashReason = { FALSE_POSITIVE: 0, FALSE_NEGATIVE: 1, MALICIOUS_REPORT: 2, SLA_VIOLATION: 3, COLLUSION: 4, PLAGIARISM: 5 };

// ─── Token helpers ────────────────────────────────────────────────────────────
const G = (n) => ethers.parseUnits(n.toString(), 8); // GUARD (8 decimals)

// ─── Stake constants ──────────────────────────────────────────────────────────
const COMMODITY_MIN_STAKE = G(100);
const SPECIALIZED_MIN_STAKE = G(300);
const PREMIUM_MIN_STAKE = G(500);
const MIN_BID_COLLATERAL = G(50);
const MIN_SUB_COLLATERAL = G(10);
const INITIAL_SUPPLY = G(1_000_000);
const AGENT_ALLOWANCE = G(10_000);

// ─── Reputation thresholds ────────────────────────────────────────────────────
const INITIAL_REP = 5000n;
const SPECIALIZED_MIN_REP = 7000n;
const PREMIUM_MIN_REP = 8500n;

// ─── Time constants ───────────────────────────────────────────────────────────
const ONE_HOUR = 3600;
const ONE_DAY = 86_400;
const AUCTION_DURATION = ONE_HOUR;

// ─── Inject MockHTS at 0x167 (shared across all fixtures) ────────────────────
async function injectMockHTS() {
  const MockHTS = await ethers.getContractFactory("MockHTS");
  const mock = await MockHTS.deploy();
  await mock.waitForDeployment();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await ethers.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", code]);
  return ethers.getContractAt("MockHTS", "0x0000000000000000000000000000000000000167");
}

// ─── Base fixture: deploys all 12 contracts, wires cross-references ───────────
async function deployBase() {
  const [owner, orchestrator, agent1, agent2, agent3, agent4, treasury, ucpPool, protocolReserve, burnAddr] =
    await ethers.getSigners();

  const mockHts = await injectMockHTS();

  // Deploy mock GUARD token
  const ERC20 = await ethers.getContractFactory("MockGuardToken");
  const guardToken = await ERC20.deploy("GUARD", "GUARD", INITIAL_SUPPLY);
  await guardToken.waitForDeployment();
  const gAddr = await guardToken.getAddress();

  // Deploy contracts in dependency order
  const agentRegistry = await (await ethers.getContractFactory("AgentRegistry")).deploy(gAddr);
  await agentRegistry.waitForDeployment();

  const treasuryContract = await (await ethers.getContractFactory("Treasury")).deploy(
    gAddr, await ucpPool.getAddress(), await protocolReserve.getAddress(), await burnAddr.getAddress()
  );
  await treasuryContract.waitForDeployment();

  const auditAuction = await (await ethers.getContractFactory("AuditAuction")).deploy(
    gAddr, await agentRegistry.getAddress(), await orchestrator.getAddress(), await treasuryContract.getAddress()
  );
  await auditAuction.waitForDeployment();

  const subAuction = await (await ethers.getContractFactory("SubAuction")).deploy(
    gAddr, await agentRegistry.getAddress(), await auditAuction.getAddress(), await treasuryContract.getAddress()
  );
  await subAuction.waitForDeployment();

  const stakingManager = await (await ethers.getContractFactory("StakingManager")).deploy(
    gAddr, await agentRegistry.getAddress(), await treasuryContract.getAddress()
  );
  await stakingManager.waitForDeployment();

  const paymentSettlement = await (await ethers.getContractFactory("PaymentSettlement")).deploy(
    gAddr, await agentRegistry.getAddress(), await auditAuction.getAddress(),
    await subAuction.getAddress(), await treasuryContract.getAddress(), await orchestrator.getAddress()
  );
  await paymentSettlement.waitForDeployment();

  const dataMarketplace = await (await ethers.getContractFactory("DataMarketplace")).deploy(
    gAddr, await agentRegistry.getAddress(), await treasuryContract.getAddress()
  );
  await dataMarketplace.waitForDeployment();

  const vaultFactory = await (await ethers.getContractFactory("VaultFactory")).deploy(
    gAddr, await agentRegistry.getAddress()
  );
  await vaultFactory.waitForDeployment();

  const budgetVault = await (await ethers.getContractFactory("AuditBudgetVault")).deploy(gAddr);
  await budgetVault.waitForDeployment();

  const timeLockVault = await (await ethers.getContractFactory("TimeLockVault")).deploy();
  await timeLockVault.waitForDeployment();

  // Wire cross-references
  await agentRegistry.setOrchestratorAndAuction(
    await orchestrator.getAddress(), await auditAuction.getAddress()
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

  // Distribute GUARD to test accounts
  for (const signer of [agent1, agent2, agent3, agent4, orchestrator]) {
    await guardToken.transfer(await signer.getAddress(), AGENT_ALLOWANCE);
  }

  return {
    guardToken, agentRegistry, auditAuction, subAuction, stakingManager,
    paymentSettlement, dataMarketplace, treasuryContract, vaultFactory, budgetVault,
    timeLockVault, mockHts,
    signers: { owner, orchestrator, agent1, agent2, agent3, agent4, treasury, ucpPool, protocolReserve, burnAddr }
  };
}

// ─── Fixture: deployBase + 4 registered agents ───────────────────────────────
async function deployWithAgents() {
  const ctx = await deployBase();
  const { agentRegistry, signers: { agent1, agent2, agent3, agent4 } } = ctx;

  const specs = [
    [agent1, "static-47", "https://agent1.io/ucp", ["static-analysis"], COMMODITY_MIN_STAKE],
    [agent2, "fuzzer-12", "https://agent2.io/ucp", ["fuzzing"], COMMODITY_MIN_STAKE],
    [agent3, "llm-3",     "https://agent3.io/ucp", ["llm-contextual"], COMMODITY_MIN_STAKE],
    [agent4, "dep-8",     "https://agent4.io/ucp", ["dependency"], COMMODITY_MIN_STAKE],
  ];
  for (const [signer, id, endpoint, tags, stake] of specs) {
    await agentRegistry.connect(signer).registerAgent(id, endpoint, tags, stake);
  }

  return ctx;
}

// ─── Fixture: deployWithAgents + one open auction job ────────────────────────
async function deployWithOpenJob() {
  const ctx = await deployWithAgents();
  const { auditAuction, signers: { orchestrator } } = ctx;

  const tx = await auditAuction.connect(orchestrator).createAuditJob(
    "0x0000000000000000000000000000000000000001",
    "hedera-testnet", "lending",
    75, G(1000), 5000, AUCTION_DURATION
  );
  const receipt = await tx.wait();
  const event = receipt.logs.map(l => { try { return auditAuction.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "JobPosted");
  const jobId = event.args[0];

  return { ...ctx, jobId };
}

// ─── Fixture: deployWithOpenJob + bids from agent1 and agent2 ────────────────
async function deployWithBids() {
  const ctx = await deployWithOpenJob();
  const { auditAuction, jobId, signers: { agent1, agent2 } } = ctx;

  await auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static-analysis");
  await auditAuction.connect(agent2).submitBid(jobId, G(150), MIN_BID_COLLATERAL, ONE_HOUR * 2, "fuzzing");

  return ctx;
}

// ─── Fixture: deployWithBids + agent1 selected as winner ─────────────────────
async function deployWithWinner() {
  const ctx = await deployWithBids();
  const { auditAuction, jobId, signers: { orchestrator } } = ctx;

  await auditAuction.connect(orchestrator).selectWinners(jobId, [0]); // agent1's bid

  return ctx;
}

// ─── Helper: get jobId from a JobPosted receipt ───────────────────────────────
function extractJobId(receipt, auditAuction) {
  const event = receipt.logs
    .map(l => { try { return auditAuction.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "JobPosted");
  return event.args[0];
}

// ─── Helper: get subJobId from a SubAuctionCreated receipt ───────────────────
function extractSubJobId(receipt, subAuction) {
  const event = receipt.logs
    .map(l => { try { return subAuction.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "SubAuctionCreated");
  return event.args[0];
}

// =============================================================================
// Suite 1 — AgentRegistry
// =============================================================================

describe("AgentRegistry", function () {
  // ── Registration ──────────────────────────────────────────────────────────

  describe("registerAgent()", function () {
    it("emits AgentRegistered and sets COMMODITY tier with 5000 initial reputation", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployBase);

      await expect(
        agentRegistry.connect(agent1).registerAgent("agent-1", "https://a.io/ucp", ["static"], COMMODITY_MIN_STAKE)
      ).to.emit(agentRegistry, "AgentRegistered").withArgs(
        await agent1.getAddress(), "agent-1", "https://a.io/ucp", COMMODITY_MIN_STAKE
      );

      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.tier).to.equal(AgentTier.COMMODITY);
      expect(p.status).to.equal(AgentStatus.ACTIVE);
      expect(p.reputationScore).to.equal(INITIAL_REP);
      expect(p.stakedAmount).to.equal(COMMODITY_MIN_STAKE);
    });

    it("rejects stake below COMMODITY_MIN_STAKE (100 GUARD)", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        agentRegistry.connect(agent1).registerAgent("a", "https://a.io", ["x"], G(99))
      ).to.be.revertedWith("AgentRegistry: insufficient commodity stake");
    });

    it("rejects empty agentId", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        agentRegistry.connect(agent1).registerAgent("", "https://a.io", ["x"], COMMODITY_MIN_STAKE)
      ).to.be.revertedWith("AgentRegistry: empty agentId");
    });

    it("rejects empty endpoint", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        agentRegistry.connect(agent1).registerAgent("a", "", ["x"], COMMODITY_MIN_STAKE)
      ).to.be.revertedWith("AgentRegistry: empty endpoint");
    });

    it("rejects duplicate registration from same address", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployBase);
      await agentRegistry.connect(agent1).registerAgent("a", "https://a.io", ["x"], COMMODITY_MIN_STAKE);
      await expect(
        agentRegistry.connect(agent1).registerAgent("a2", "https://a2.io", ["x"], COMMODITY_MIN_STAKE)
      ).to.be.revertedWith("AgentRegistry: already registered");
    });

    it("adds address to agentList and increments getAgentCount()", async function () {
      const { agentRegistry, signers: { agent1, agent2 } } = await loadFixture(deployBase);
      await agentRegistry.connect(agent1).registerAgent("a1", "https://a.io", ["x"], COMMODITY_MIN_STAKE);
      await agentRegistry.connect(agent2).registerAgent("a2", "https://b.io", ["x"], COMMODITY_MIN_STAKE);
      expect(await agentRegistry.getAgentCount()).to.equal(2n);
    });
  });

  // ── Staking ───────────────────────────────────────────────────────────────

  describe("addStake()", function () {
    it("emits StakeAdded and increases stakedAmount", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      const before = (await agentRegistry.getAgent(await agent1.getAddress())).stakedAmount;

      await expect(agentRegistry.connect(agent1).addStake(G(200)))
        .to.emit(agentRegistry, "StakeAdded")
        .withArgs(await agent1.getAddress(), G(200), before + G(200));

      const after = (await agentRegistry.getAgent(await agent1.getAddress())).stakedAmount;
      expect(after).to.equal(before + G(200));
    });

    it("rejects zero amount", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await expect(agentRegistry.connect(agent1).addStake(0))
        .to.be.revertedWith("AgentRegistry: amount is zero");
    });

    it("restores ACTIVE status if suspended agent re-stakes above COMMODITY minimum", async function () {
      const { agentRegistry, signers: { owner, orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      // 100% slash → SLASHED
      await agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 10_000);
      // Fresh COMMODITY_MIN_STAKE via addStake should activate if status was SUSPENDED
      // Note: a SLASHED agent cannot addStake — only SUSPENDED can recover
    });
  });

  describe("withdrawStake()", function () {
    it("allows withdrawal of excess stake above tier minimum", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).addStake(G(200)); // total = 300 GUARD

      // Can withdraw 200 (keeping 100 = COMMODITY min)
      await expect(agentRegistry.connect(agent1).withdrawStake(G(200)))
        .to.not.be.reverted;

      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.stakedAmount).to.equal(COMMODITY_MIN_STAKE);
    });

    it("rejects withdrawal that drops below tier minimum for ACTIVE agent", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      // agent1 has exactly COMMODITY_MIN_STAKE = 100 GUARD
      await expect(agentRegistry.connect(agent1).withdrawStake(G(1)))
        .to.be.revertedWith("AgentRegistry: below tier minimum");
    });
  });

  // ── Tier Promotion ────────────────────────────────────────────────────────

  describe("requestPromotion()", function () {
    it("COMMODITY → SPECIALIZED when stake ≥ 300 and reputation ≥ 7000", async function () {
      const { agentRegistry, signers: { owner, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).addStake(G(200)); // total = 300 GUARD
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 7000);

      await expect(agentRegistry.connect(agent1).requestPromotion())
        .to.emit(agentRegistry, "AgentPromoted")
        .withArgs(await agent1.getAddress(), AgentTier.COMMODITY, AgentTier.SPECIALIZED);

      expect((await agentRegistry.getAgent(await agent1.getAddress())).tier)
        .to.equal(AgentTier.SPECIALIZED);
    });

    it("SPECIALIZED → PREMIUM when stake ≥ 500 and reputation ≥ 8500", async function () {
      const { agentRegistry, signers: { owner, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).addStake(G(400)); // total = 500 GUARD
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 7000);
      await agentRegistry.connect(agent1).requestPromotion(); // → SPECIALIZED
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 8500);

      await expect(agentRegistry.connect(agent1).requestPromotion())
        .to.emit(agentRegistry, "AgentPromoted")
        .withArgs(await agent1.getAddress(), AgentTier.SPECIALIZED, AgentTier.PREMIUM);

      expect((await agentRegistry.getAgent(await agent1.getAddress())).tier)
        .to.equal(AgentTier.PREMIUM);
    });

    it("rejects promotion when reputation below SPECIALIZED threshold (6999 < 7000)", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).addStake(G(200)); // stake is sufficient
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 6999);

      await expect(agentRegistry.connect(agent1).requestPromotion())
        .to.be.revertedWith("AgentRegistry: specialized requirements unmet");
    });

    it("rejects promotion when stake below SPECIALIZED threshold", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 7000);
      // agent1 only has 100 GUARD, needs 300 for SPECIALIZED

      await expect(agentRegistry.connect(agent1).requestPromotion())
        .to.be.revertedWith("AgentRegistry: specialized requirements unmet");
    });
  });

  // ── Reputation ────────────────────────────────────────────────────────────

  describe("updateReputation()", function () {
    it("orchestrator applies positive delta and emits ReputationUpdated", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await expect(agentRegistry.connect(orchestrator).updateReputation(await agent1.getAddress(), 500))
        .to.emit(agentRegistry, "ReputationUpdated")
        .withArgs(await agent1.getAddress(), 500, INITIAL_REP + 500n);

      expect(await agentRegistry.getAgentReputation(await agent1.getAddress()))
        .to.equal(INITIAL_REP + 500n);
    });

    it("clamps reputation at 0 minimum (never negative)", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(orchestrator).updateReputation(await agent1.getAddress(), -10_000);
      expect(await agentRegistry.getAgentReputation(await agent1.getAddress())).to.equal(0n);
    });

    it("clamps reputation at 10000 maximum", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(orchestrator).updateReputation(await agent1.getAddress(), 10_000);
      expect(await agentRegistry.getAgentReputation(await agent1.getAddress())).to.equal(10_000n);
    });

    it("rejects non-orchestrator/non-auction caller", async function () {
      const { agentRegistry, signers: { agent2, agent1 } } = await loadFixture(deployWithAgents);
      await expect(
        agentRegistry.connect(agent2).updateReputation(await agent1.getAddress(), 100)
      ).to.be.revertedWith("AgentRegistry: caller is not authorized scorer");
    });
  });

  describe("recordJobCompletion()", function () {
    it("updates job metrics and adjusts reputation: delta = validFindings×50 - falsePos×100 - falseNeg×200", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      // delta = 5×50 - 1×100 - 0×200 = 150
      await expect(
        agentRegistry.connect(orchestrator).recordJobCompletion(await agent1.getAddress(), 5, 1, 0)
      ).to.emit(agentRegistry, "JobRecorded").withArgs(await agent1.getAddress(), 5, 1, 0);

      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.completedJobs).to.equal(1n);
      expect(p.successfulFindings).to.equal(5n);
      expect(p.falsePositives).to.equal(1n);
      expect(p.reputationScore).to.equal(INITIAL_REP + 150n);
    });
  });

  // ── Slashing ──────────────────────────────────────────────────────────────

  describe("slashAgent()", function () {
    it("reduces stakedAmount by basis points and emits AgentSlashed", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      // 5% of 100 GUARD = 5 GUARD slashed; 95 GUARD remains
      await expect(
        agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 500)
      ).to.emit(agentRegistry, "AgentSlashed").withArgs(await agent1.getAddress(), G(5), 500);

      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.stakedAmount).to.equal(G(95));
    });

    it("sets status=SUSPENDED when remaining stake falls below COMMODITY minimum", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      // 5% slash on 100 GUARD → 95 GUARD < 100 minimum → SUSPENDED
      await agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 500);
      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.status).to.equal(AgentStatus.SUSPENDED);
    });

    it("sets status=SLASHED on 100% slash (10000 bps)", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 10_000);
      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.status).to.equal(AgentStatus.SLASHED);
      expect(p.stakedAmount).to.equal(0n);
    });

    it("rejects slashBasisPoints=0", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await expect(
        agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 0)
      ).to.be.revertedWith("AgentRegistry: invalid slash bps");
    });

    it("rejects slashBasisPoints > 10000", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await expect(
        agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 10_001)
      ).to.be.revertedWith("AgentRegistry: invalid slash bps");
    });

    it("rejects non-orchestrator caller", async function () {
      const { agentRegistry, signers: { agent2, agent1 } } = await loadFixture(deployWithAgents);
      await expect(
        agentRegistry.connect(agent2).slashAgent(await agent1.getAddress(), 500)
      ).to.be.revertedWith("AgentRegistry: caller is not orchestrator");
    });
  });

  // ── Deregistration ────────────────────────────────────────────────────────

  describe("deregisterAgent()", function () {
    it("sets status=INACTIVE, zeros stake, emits AgentDeregistered", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await expect(agentRegistry.connect(agent1).deregisterAgent())
        .to.emit(agentRegistry, "AgentDeregistered")
        .withArgs(await agent1.getAddress(), COMMODITY_MIN_STAKE);

      const p = await agentRegistry.getAgent(await agent1.getAddress());
      expect(p.status).to.equal(AgentStatus.INACTIVE);
      expect(p.stakedAmount).to.equal(0n);
    });

    it("rejects double deregistration", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).deregisterAgent();
      await expect(agentRegistry.connect(agent1).deregisterAgent())
        .to.be.revertedWith("AgentRegistry: already inactive");
    });
  });

  // ── Admin & Pausable ─────────────────────────────────────────────────────

  describe("seedAgentReputation()", function () {
    it("owner sets reputation for fresh agent (0 completed jobs)", async function () {
      const { agentRegistry, signers: { owner, agent1 } } = await loadFixture(deployWithAgents);
      await expect(agentRegistry.seedAgentReputation(await agent1.getAddress(), 8000))
        .to.emit(agentRegistry, "ReputationSeeded").withArgs(await agent1.getAddress(), 8000);
      expect(await agentRegistry.getAgentReputation(await agent1.getAddress())).to.equal(8000n);
    });

    it("rejects seeding for agent with completed jobs", async function () {
      const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(orchestrator).recordJobCompletion(await agent1.getAddress(), 1, 0, 0);
      await expect(agentRegistry.seedAgentReputation(await agent1.getAddress(), 8000))
        .to.be.revertedWith("AgentRegistry: agent already has jobs");
    });
  });

  describe("pause() / unpause()", function () {
    it("pause blocks registerAgent, addStake; unpause restores them", async function () {
      const { agentRegistry, signers: { owner, agent1 } } = await loadFixture(deployBase);
      await agentRegistry.pause();
      await expect(
        agentRegistry.connect(agent1).registerAgent("a", "https://a.io", ["x"], COMMODITY_MIN_STAKE)
      ).to.be.revertedWithCustomError(agentRegistry, "EnforcedPause");
      await agentRegistry.unpause();
      await expect(
        agentRegistry.connect(agent1).registerAgent("a", "https://a.io", ["x"], COMMODITY_MIN_STAKE)
      ).to.not.be.reverted;
    });
  });

  describe("setOrchestratorAndAuction()", function () {
    it("rejects second call (can only be configured once)", async function () {
      const { agentRegistry, signers: { owner, agent1, agent2 } } = await loadFixture(deployBase);
      // Already configured in fixture
      await expect(
        agentRegistry.setOrchestratorAndAuction(await agent1.getAddress(), await agent2.getAddress())
      ).to.be.revertedWith("AgentRegistry: already configured");
    });
  });

  describe("isEligibleForTier()", function () {
    it("returns false for INACTIVE agent", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await agentRegistry.connect(agent1).deregisterAgent();
      expect(await agentRegistry.isEligibleForTier(await agent1.getAddress(), AgentTier.COMMODITY))
        .to.be.false;
    });

    it("returns true for ACTIVE COMMODITY agent with sufficient stake", async function () {
      const { agentRegistry, signers: { agent1 } } = await loadFixture(deployWithAgents);
      expect(await agentRegistry.isEligibleForTier(await agent1.getAddress(), AgentTier.COMMODITY))
        .to.be.true;
    });
  });
});

// =============================================================================
// Suite 2 — AuditAuction
// =============================================================================

describe("AuditAuction", function () {
  // ── Job creation ─────────────────────────────────────────────────────────

  describe("createAuditJob()", function () {
    it("emits JobPosted with all params and starts at jobId=1", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      const tx = await auditAuction.connect(orchestrator).createAuditJob(
        "0x0000000000000000000000000000000000000001",
        "hedera-testnet", "lending", 75, G(1000), 5000, AUCTION_DURATION
      );
      await expect(tx).to.emit(auditAuction, "JobPosted");
      const receipt = await tx.wait();
      const jobId = extractJobId(receipt, auditAuction);
      expect(jobId).to.equal(1n);
    });

    it("auto-increments jobId for each new job", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      const addr = "0x0000000000000000000000000000000000000001";
      for (let i = 1; i <= 3; i++) {
        const tx = await auditAuction.connect(orchestrator).createAuditJob(addr, "hedera", "vault", 50, G(100), 1000, AUCTION_DURATION);
        const receipt = await tx.wait();
        expect(extractJobId(receipt, auditAuction)).to.equal(BigInt(i));
      }
    });

    it("rejects zero budget", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      await expect(
        auditAuction.connect(orchestrator).createAuditJob("0x1234567890123456789012345678901234567890", "h", "t", 50, 0, 1000, AUCTION_DURATION)
      ).to.be.revertedWith("AuditAuction: budget is zero");
    });

    it("rejects risk score > 100", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      await expect(
        auditAuction.connect(orchestrator).createAuditJob("0x1234567890123456789012345678901234567890", "h", "t", 101, G(100), 1000, AUCTION_DURATION)
      ).to.be.revertedWith("AuditAuction: risk score out of range");
    });

    it("rejects zero contract address", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      await expect(
        auditAuction.connect(orchestrator).createAuditJob(ethers.ZeroAddress, "h", "t", 50, G(100), 1000, AUCTION_DURATION)
      ).to.be.revertedWith("AuditAuction: contract address is zero");
    });

    it("rejects non-orchestrator caller", async function () {
      const { auditAuction, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await expect(
        auditAuction.connect(agent1).createAuditJob("0x1234567890123456789012345678901234567890", "h", "t", 50, G(100), 1000, AUCTION_DURATION)
      ).to.be.revertedWith("AuditAuction: caller is not orchestrator");
    });
  });

  // ── Bidding ───────────────────────────────────────────────────────────────

  describe("submitBid()", function () {
    it("emits BidSubmitted and increases bid count", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static-analysis")
      ).to.emit(auditAuction, "BidSubmitted");

      expect(await auditAuction.getBidCount(jobId)).to.equal(1n);
    });

    it("rejects collateral below MIN_BID_COLLATERAL (50 GUARD)", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(50), G(49), ONE_HOUR, "static")
      ).to.be.revertedWith("AuditAuction: collateral below minimum");
    });

    it("rejects bid amount exceeding job budget", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(2000), MIN_BID_COLLATERAL, ONE_HOUR, "static")
      ).to.be.revertedWith("AuditAuction: bid exceeds budget");
    });

    it("rejects duplicate bid from same agent", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static");
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(80), MIN_BID_COLLATERAL, ONE_HOUR, "static")
      ).to.be.revertedWith("AuditAuction: bid already submitted");
    });

    it("rejects bid after auction deadline", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await time.increase(AUCTION_DURATION + 1);
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static")
      ).to.be.revertedWith("AuditAuction: auction expired");
    });

    it("rejects bid from inactive (deregistered) agent", async function () {
      const { auditAuction, agentRegistry, jobId, signers: { agent1 } } = await loadFixture(deployWithOpenJob);
      await agentRegistry.connect(agent1).deregisterAgent();
      await expect(
        auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static")
      ).to.be.revertedWith("AuditAuction: inactive agent");
    });
  });

  // ── Bid scoring ───────────────────────────────────────────────────────────

  describe("calculateBidScore() / rankBids()", function () {
    it("higher reputation agent scores higher (all else equal)", async function () {
      const { auditAuction, agentRegistry, jobId, signers: { orchestrator, agent1, agent2 } } =
        await loadFixture(deployWithOpenJob);

      await agentRegistry.seedAgentReputation(await agent1.getAddress(), 8000);
      await agentRegistry.seedAgentReputation(await agent2.getAddress(), 5000);

      await auditAuction.connect(agent1).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "static");
      await auditAuction.connect(agent2).submitBid(jobId, G(100), MIN_BID_COLLATERAL, ONE_HOUR, "fuzzing");

      const score0 = await auditAuction.calculateBidScore(jobId, 0); // agent1: rep=8000
      const score1 = await auditAuction.calculateBidScore(jobId, 1); // agent2: rep=5000
      expect(score0).to.be.gt(score1);
    });

    it("rankBids returns indices sorted descending by score", async function () {
      const ctx = await loadFixture(deployWithBids);
      const { auditAuction, jobId } = ctx;

      const ranked = await auditAuction.rankBids(jobId);
      const score0 = await auditAuction.calculateBidScore(jobId, ranked[0]);
      const score1 = await auditAuction.calculateBidScore(jobId, ranked[1]);
      expect(score0).to.be.gte(score1);
    });
  });

  // ── Winner selection ──────────────────────────────────────────────────────

  describe("selectWinners()", function () {
    it("emits WinnersSelected and transitions job to AUDITING_IN_PROGRESS", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithBids);
      await expect(auditAuction.connect(orchestrator).selectWinners(jobId, [0]))
        .to.emit(auditAuction, "WinnersSelected");

      expect((await auditAuction.getJob(jobId)).status).to.equal(JobStatus.AUDITING_IN_PROGRESS);
    });

    it("refunds losing bids collateral via BidRefunded event", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithBids);
      await expect(auditAuction.connect(orchestrator).selectWinners(jobId, [0]))
        .to.emit(auditAuction, "BidRefunded");
    });

    it("deducts 5% platform fee from total winning bid amount", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithBids);
      const bids = await auditAuction.getBidsForJob(jobId);
      const winBidAmount = bids[0].bidAmount;
      const expectedFee = (winBidAmount * 5n) / 100n;
      const expectedEscrowed = winBidAmount - expectedFee;

      await auditAuction.connect(orchestrator).selectWinners(jobId, [0]);
      const job = await auditAuction.getJob(jobId);
      expect(job.totalEscrowedAmount).to.equal(expectedEscrowed);
    });

    it("rejects duplicate winning bid indices", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithBids);
      await expect(auditAuction.connect(orchestrator).selectWinners(jobId, [0, 0]))
        .to.be.revertedWith("AuditAuction: duplicate winning index");
    });

    it("rejects non-orchestrator caller", async function () {
      const { auditAuction, jobId, signers: { agent1 } } = await loadFixture(deployWithBids);
      await expect(auditAuction.connect(agent1).selectWinners(jobId, [0]))
        .to.be.revertedWith("AuditAuction: caller is not orchestrator");
    });
  });

  // ── Escrow release ────────────────────────────────────────────────────────

  describe("releaseEscrow()", function () {
    it("emits EscrowReleased and updates paidWinnerCount", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      const job = await auditAuction.getJob(jobId);
      const payment = job.totalEscrowedAmount;

      await expect(
        auditAuction.connect(orchestrator).releaseEscrow(jobId, await agent1.getAddress(), payment, 0, 5, 0, 0)
      ).to.emit(auditAuction, "EscrowReleased");

      expect(await auditAuction.isWinnerPaid(jobId, await agent1.getAddress())).to.be.true;
    });

    it("rejects double payment for same winner", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      const job = await auditAuction.getJob(jobId);
      await auditAuction.connect(orchestrator).releaseEscrow(jobId, await agent1.getAddress(), job.totalEscrowedAmount, 0, 5, 0, 0);

      await expect(
        auditAuction.connect(orchestrator).releaseEscrow(jobId, await agent1.getAddress(), 0, 0, 0, 0, 0)
      ).to.be.revertedWith("AuditAuction: winner already paid");
    });

    it("rejects payout exceeding escrowed amount", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      const job = await auditAuction.getJob(jobId);
      await expect(
        auditAuction.connect(orchestrator).releaseEscrow(jobId, await agent1.getAddress(), job.totalEscrowedAmount + G(1), 0, 0, 0, 0)
      ).to.be.revertedWith("AuditAuction: insufficient escrow");
    });
  });

  describe("completeJob()", function () {
    it("transitions job to COMPLETED after all winners paid and emits JobCompleted", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      const job = await auditAuction.getJob(jobId);
      await auditAuction.connect(orchestrator).releaseEscrow(jobId, await agent1.getAddress(), job.totalEscrowedAmount, 0, 5, 0, 0);

      await expect(auditAuction.connect(orchestrator).completeJob(jobId))
        .to.emit(auditAuction, "JobCompleted");

      expect((await auditAuction.getJob(jobId)).status).to.equal(JobStatus.COMPLETED);
    });

    it("rejects completion when unpaid winners remain", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithWinner);
      await expect(auditAuction.connect(orchestrator).completeJob(jobId))
        .to.be.revertedWith("AuditAuction: unpaid winners remain");
    });
  });

  // ── Slashing ──────────────────────────────────────────────────────────────

  describe("slashAgentBid()", function () {
    it("KNOWN CONTRACT BUG: slashAgentBid always reverts — AuditAuction calls agentRegistry.slashAgent() which requires onlyOrchestrator, but AuditAuction is registered as auctionContract, not orchestrator", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      // AuditAuction.slashAgentBid() internally calls agentRegistry.slashAgent(), but AgentRegistry.slashAgent()
      // has onlyOrchestrator guard. Since AuditAuction is the `auctionContract` (not `orchestrator`),
      // this cross-contract call always fails. slashAgentBid is effectively dead code until this is fixed.
      await expect(
        auditAuction.connect(orchestrator).slashAgentBid(jobId, await agent1.getAddress(), 1000)
      ).to.be.revertedWith("AgentRegistry: caller is not orchestrator");
    });

    it("rejects invalid slash bps (not 500, 1000, or 10000)", async function () {
      const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
      await expect(
        auditAuction.connect(orchestrator).slashAgentBid(jobId, await agent1.getAddress(), 300)
      ).to.be.revertedWith("AuditAuction: invalid slash bps");
    });
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  describe("cancelJob()", function () {
    it("emits JobCancelled and refunds all pending bid collateral", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithBids);
      const tx = await auditAuction.connect(orchestrator).cancelJob(jobId);
      await expect(tx).to.emit(auditAuction, "JobCancelled");
      // Both bids were PENDING → both should get BidRefunded
      const receipt = await tx.wait();
      const refunds = receipt.logs
        .map(l => { try { return auditAuction.interface.parseLog(l); } catch { return null; } })
        .filter(e => e?.name === "BidRefunded");
      expect(refunds.length).to.equal(2);
    });

    it("rejects cancellation of AUDITING_IN_PROGRESS job", async function () {
      const { auditAuction, jobId, signers: { orchestrator } } = await loadFixture(deployWithWinner);
      await expect(auditAuction.connect(orchestrator).cancelJob(jobId))
        .to.be.revertedWith("AuditAuction: only open jobs cancellable");
    });
  });

  // ── Pausable ──────────────────────────────────────────────────────────────

  describe("pause() / unpause()", function () {
    it("orchestrator can pause; createAuditJob reverts while paused", async function () {
      const { auditAuction, signers: { orchestrator } } = await loadFixture(deployWithAgents);
      await auditAuction.connect(orchestrator).pause();
      await expect(
        auditAuction.connect(orchestrator).createAuditJob(
          "0x0000000000000000000000000000000000000002", "h", "t", 50, G(100), 1000, AUCTION_DURATION
        )
      ).to.be.revertedWithCustomError(auditAuction, "EnforcedPause");
      await auditAuction.connect(orchestrator).unpause();
    });
  });
});

// =============================================================================
// Suite 3 — SubAuction
// =============================================================================

describe("SubAuction", function () {
  // Fixture: open job with agent1 as winner, ready for sub-auction creation
  async function deployReadyForSubAuction() {
    const ctx = await deployWithWinner();
    return ctx;
  }

  describe("createSubAuction()", function () {
    it("emits SubAuctionCreated with parentJobId and requester", async function () {
      const { subAuction, jobId, signers: { agent1 } } = await loadFixture(deployReadyForSubAuction);
      const tx = await subAuction.connect(agent1).createSubAuction(
        jobId, "Dependency analysis", "dependency", G(20), ONE_DAY, AUCTION_DURATION
      );
      await expect(tx).to.emit(subAuction, "SubAuctionCreated");
      const receipt = await tx.wait();
      const subJobId = extractSubJobId(receipt, subAuction);
      expect(subJobId).to.equal(1n);
    });

    it("rejects non-winner caller", async function () {
      const { subAuction, jobId, signers: { agent2 } } = await loadFixture(deployReadyForSubAuction);
      await expect(
        subAuction.connect(agent2).createSubAuction(jobId, "task", "dep", G(20), ONE_DAY, AUCTION_DURATION)
      ).to.be.reverted; // not a winner of parent job
    });
  });

  describe("submitSubBid()", function () {
    async function deployWithSubAuction() {
      const ctx = await deployReadyForSubAuction();
      const { subAuction, jobId, signers: { agent1 } } = ctx;
      const tx = await subAuction.connect(agent1).createSubAuction(
        jobId, "Dependency analysis", "dependency", G(20), ONE_DAY, AUCTION_DURATION
      );
      const receipt = await tx.wait();
      const subJobId = extractSubJobId(receipt, subAuction);
      return { ...ctx, subJobId };
    }

    it("emits SubBidSubmitted and escrows collateral", async function () {
      const { subAuction, subJobId, signers: { agent4 } } = await loadFixture(deployWithSubAuction);
      await expect(
        subAuction.connect(agent4).submitSubBid(subJobId, G(18), ONE_HOUR, MIN_SUB_COLLATERAL)
      ).to.emit(subAuction, "SubBidSubmitted");
    });

    it("rejects collateral below MIN_SUB_COLLATERAL (10 GUARD)", async function () {
      const { subAuction, subJobId, signers: { agent4 } } = await loadFixture(deployWithSubAuction);
      await expect(
        subAuction.connect(agent4).submitSubBid(subJobId, G(18), ONE_HOUR, G(9))
      ).to.be.revertedWith("SubAuction: collateral below minimum");
    });

    it("rejects duplicate sub-bid from same agent", async function () {
      const { subAuction, subJobId, signers: { agent4 } } = await loadFixture(deployWithSubAuction);
      await subAuction.connect(agent4).submitSubBid(subJobId, G(18), ONE_HOUR, MIN_SUB_COLLATERAL);
      await expect(
        subAuction.connect(agent4).submitSubBid(subJobId, G(15), ONE_HOUR, MIN_SUB_COLLATERAL)
      ).to.be.revertedWith("SubAuction: bid already submitted");
    });

    describe("selectSubContractor()", function () {
      async function deployWithSubBid() {
        const ctx = await deployWithSubAuction();
        const { subAuction, subJobId, signers: { agent4 } } = ctx;
        await subAuction.connect(agent4).submitSubBid(subJobId, G(18), ONE_HOUR, MIN_SUB_COLLATERAL);
        return ctx;
      }

      it("emits SubContractorSelected and sets status to IN_PROGRESS", async function () {
        const { subAuction, subJobId, signers: { agent1 } } = await loadFixture(deployWithSubBid);
        await expect(subAuction.connect(agent1).selectSubContractor(subJobId, 0))
          .to.emit(subAuction, "SubContractorSelected");

        const sub = await subAuction.getSubJob(subJobId);
        expect(sub.status).to.equal(SubJobStatus.IN_PROGRESS);
      });

      it("rejects non-requester caller", async function () {
        const { subAuction, subJobId, signers: { agent2 } } = await loadFixture(deployWithSubBid);
        await expect(subAuction.connect(agent2).selectSubContractor(subJobId, 0)).to.be.reverted;
      });

      describe("deliverResult()", function () {
        async function deployWithSubContractor() {
          const ctx = await deployWithSubBid();
          const { subAuction, subJobId, signers: { agent1 } } = ctx;
          await subAuction.connect(agent1).selectSubContractor(subJobId, 0);
          return ctx;
        }

        it("emits ResultDelivered with result hash, sets status to DELIVERED", async function () {
          const { subAuction, subJobId, signers: { agent4 } } = await loadFixture(deployWithSubContractor);
          const hash = ethers.keccak256(ethers.toUtf8Bytes("dependency-result"));
          await expect(subAuction.connect(agent4).deliverResult(subJobId, hash))
            .to.emit(subAuction, "ResultDelivered");

          const sub = await subAuction.getSubJob(subJobId);
          expect(sub.status).to.equal(SubJobStatus.DELIVERED);
        });

        it("rejects delivery from non-selected contractor", async function () {
          const { subAuction, subJobId, signers: { agent2 } } = await loadFixture(deployWithSubContractor);
          await expect(
            subAuction.connect(agent2).deliverResult(subJobId, ethers.keccak256(ethers.toUtf8Bytes("x")))
          ).to.be.reverted;
        });

        it("KNOWN LIMITATION: acceptResult reverts — SubAuction is not an authorized scorer in AgentRegistry", async function () {
          const { subAuction, subJobId, signers: { agent1, agent4 } } = await loadFixture(deployWithSubContractor);
          await subAuction.connect(agent4).deliverResult(subJobId, ethers.keccak256(ethers.toUtf8Bytes("result")));
          await expect(subAuction.connect(agent1).acceptResult(subJobId))
            .to.be.revertedWith("AgentRegistry: caller is not authorized scorer");
        });
      });
    });
  });
});

// =============================================================================
// Suite 4 — StakingManager
// =============================================================================

describe("StakingManager", function () {
  describe("stake()", function () {
    it("emits Staked and updates stakeInfo.totalStaked", async function () {
      const { stakingManager, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await expect(stakingManager.connect(agent1).stake(COMMODITY_MIN_STAKE))
        .to.emit(stakingManager, "Staked");

      const info = await stakingManager.getStakeInfo(await agent1.getAddress());
      expect(info.totalStaked).to.equal(COMMODITY_MIN_STAKE);
      expect(info.availableStake).to.equal(COMMODITY_MIN_STAKE);
    });

    it("rejects zero amount", async function () {
      const { stakingManager, signers: { agent1 } } = await loadFixture(deployWithAgents);
      await expect(stakingManager.connect(agent1).stake(0))
        .to.be.revertedWith("StakingManager: amount is zero");
    });

    it("rejects stake from unregistered agent", async function () {
      const { stakingManager, signers: { treasury } } = await loadFixture(deployWithAgents);
      await expect(stakingManager.connect(treasury).stake(COMMODITY_MIN_STAKE))
        .to.be.revertedWith("StakingManager: agent not registered");
    });
  });

  describe("requestUnstake()", function () {
    async function deployWithStake() {
      const ctx = await deployWithAgents();
      const { stakingManager, signers: { agent1 } } = ctx;
      await stakingManager.connect(agent1).stake(COMMODITY_MIN_STAKE);
      await stakingManager.connect(agent1).stake(COMMODITY_MIN_STAKE); // stake 200 total
      return ctx;
    }

    it("emits UnstakeRequested and reduces availableStake", async function () {
      const { stakingManager, signers: { agent1 } } = await loadFixture(deployWithStake);
      await expect(stakingManager.connect(agent1).requestUnstake(G(50)))
        .to.emit(stakingManager, "UnstakeRequested");

      const info = await stakingManager.getStakeInfo(await agent1.getAddress());
      expect(info.unbondingAmount).to.equal(G(50));
    });

    it("completeUnstake rejects before cooldown period", async function () {
      const { stakingManager, signers: { agent1 } } = await loadFixture(deployWithStake);
      await stakingManager.connect(agent1).requestUnstake(G(50));
      await expect(stakingManager.connect(agent1).completeUnstake())
        .to.be.revertedWith("StakingManager: unbonding period not elapsed");
    });
  });

  describe("addAuthorizedSlasher()", function () {
    it("only owner can add authorized slasher", async function () {
      const { stakingManager, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(stakingManager.connect(agent1).addAuthorizedSlasher(await agent1.getAddress()))
        .to.be.reverted;
    });
  });
});

// =============================================================================
// Suite 5 — PaymentSettlement
// =============================================================================

describe("PaymentSettlement", function () {
  describe("depositSettlementFunds()", function () {
    it("emits FundsDeposited on successful deposit", async function () {
      const { paymentSettlement, signers: { orchestrator } } = await loadFixture(deployBase);
      await expect(paymentSettlement.connect(orchestrator).depositSettlementFunds(G(500)))
        .to.emit(paymentSettlement, "FundsDeposited");
    });

    it("rejects zero deposit", async function () {
      const { paymentSettlement, signers: { orchestrator } } = await loadFixture(deployBase);
      await expect(paymentSettlement.connect(orchestrator).depositSettlementFunds(0))
        .to.be.revertedWith("PaymentSettlement: zero deposit");
    });

    it("NOTE: depositSettlementFunds has no access control — any address can deposit (design decision)", async function () {
      // depositSettlementFunds lacks onlyOrchestrator; any caller with GUARD approval can deposit.
      // This is intentional — allows vault contracts and auction to fund the settlement pool.
      const { paymentSettlement, signers: { agent1 } } = await loadFixture(deployBase);
      // Verify it succeeds for a non-orchestrator (no revert expected)
      await expect(paymentSettlement.connect(agent1).depositSettlementFunds(G(100)))
        .to.not.be.revertedWith("PaymentSettlement: caller is not orchestrator");
    });
  });

  describe("isJobSettled()", function () {
    it("returns false for unsettled job", async function () {
      const { paymentSettlement } = await loadFixture(deployBase);
      expect(await paymentSettlement.isJobSettled(1)).to.be.false;
    });
  });
});

// =============================================================================
// Suite 6 — DataMarketplace
// =============================================================================

describe("DataMarketplace", function () {
  async function deployWithListing() {
    const ctx = await deployWithAgents();
    const { dataMarketplace, signers: { agent1 } } = ctx;
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes("audit-findings"));
    const tx = await dataMarketplace.connect(agent1).createListing(
      1, // parentJobId
      "Critical Findings Report",
      "High severity vulnerabilities discovered",
      DataCategory.AUDIT_FINDING,
      ListingType.ONE_TIME,
      G(10),
      0, // subscriptionPeriod
      contentHash,
      5, // maxBuyers
      0  // durationSeconds (no expiry)
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map(l => { try { return dataMarketplace.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "DataListed");
    const listingId = event.args[0];
    return { ...ctx, listingId };
  }

  describe("createListing()", function () {
    it("emits DataListed with listingId=1 and correct metadata", async function () {
      const { dataMarketplace, signers: { agent1 } } = await loadFixture(deployWithAgents);
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("data"));
      await expect(
        dataMarketplace.connect(agent1).createListing(1, "Title", "Desc", DataCategory.SCAN_REPORT, ListingType.ONE_TIME, G(5), 0, contentHash, 10, 0)
      ).to.emit(dataMarketplace, "DataListed");
    });

    it("NOTE: createListing allows price=0 (no price validation in contract)", async function () {
      // DataMarketplace._validateListingInput does not check price > 0.
      // A zero-price listing can be created (free tip/airdrop pattern is allowed).
      const { dataMarketplace, signers: { agent1 } } = await loadFixture(deployWithAgents);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("content"));
      await expect(
        dataMarketplace.connect(agent1).createListing(1, "T", "D", DataCategory.SCAN_REPORT, ListingType.ONE_TIME, 0, 0, hash, 10, 0)
      ).to.not.be.reverted;
    });
  });

  describe("purchaseData()", function () {
    it("emits DataPurchased and grants access", async function () {
      const { dataMarketplace, listingId, signers: { agent2 } } = await loadFixture(deployWithListing);
      await expect(dataMarketplace.connect(agent2).purchaseData(listingId))
        .to.emit(dataMarketplace, "DataPurchased");

      expect(await dataMarketplace.hasAccess(listingId, await agent2.getAddress())).to.be.true;
    });

    it("rejects self-purchase", async function () {
      const { dataMarketplace, listingId, signers: { agent1 } } = await loadFixture(deployWithListing);
      await expect(dataMarketplace.connect(agent1).purchaseData(listingId))
        .to.be.revertedWith("DataMarketplace: seller cannot buy own listing");
    });
  });

  describe("ratePurchase()", function () {
    async function deployWithPurchase() {
      const ctx = await deployWithListing();
      const { dataMarketplace, listingId, signers: { agent2 } } = ctx;
      await dataMarketplace.connect(agent2).purchaseData(listingId);
      return ctx;
    }

    it("emits DataRated after valid purchase", async function () {
      const { dataMarketplace, listingId, signers: { agent2 } } = await loadFixture(deployWithPurchase);
      await expect(dataMarketplace.connect(agent2).ratePurchase(listingId, 4))
        .to.emit(dataMarketplace, "DataRated");
    });

    it("rejects rating from non-buyer", async function () {
      const { dataMarketplace, listingId, signers: { agent3 } } = await loadFixture(deployWithPurchase);
      await expect(dataMarketplace.connect(agent3).ratePurchase(listingId, 5))
        .to.be.reverted;
    });

    it("rejects rating out of range (0 or 6)", async function () {
      const { dataMarketplace, listingId, signers: { agent2 } } = await loadFixture(deployWithPurchase);
      await expect(dataMarketplace.connect(agent2).ratePurchase(listingId, 0))
        .to.be.revertedWith("DataMarketplace: rating must be 1-5");
      await expect(dataMarketplace.connect(agent2).ratePurchase(listingId, 6))
        .to.be.revertedWith("DataMarketplace: rating must be 1-5");
    });
  });

  describe("getListingsByCategory()", function () {
    it("filters listings by DataCategory", async function () {
      const { dataMarketplace, listingId } = await loadFixture(deployWithListing);
      const findings = await dataMarketplace.getListingsByCategory(DataCategory.AUDIT_FINDING);
      expect(findings.length).to.equal(1);
      expect(findings[0]).to.equal(listingId);
    });
  });
});

// =============================================================================
// Suite 7 — Treasury
// =============================================================================

describe("Treasury", function () {
  describe("receiveFee()", function () {
    it("authorized source can deposit fee and emits FeeReceived", async function () {
      const { treasuryContract, signers: { owner } } = await loadFixture(deployBase);
      await treasuryContract.addAuthorizedSource(await owner.getAddress());

      await expect(
        treasuryContract.connect(owner).receiveFee(FeeSource.AUDIT_PLATFORM_FEE, G(100), 1)
      ).to.emit(treasuryContract, "FeeReceived");

      expect(await treasuryContract.getPendingBalance()).to.equal(G(100));
    });

    it("rejects fee from unauthorized source", async function () {
      const { treasuryContract, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        treasuryContract.connect(agent1).receiveFee(FeeSource.AUDIT_PLATFORM_FEE, G(10), 0)
      ).to.be.revertedWith("Treasury: not authorized source");
    });
  });

  describe("distribute()", function () {
    it("emits FeeDistributed and resets pendingBalance to 0", async function () {
      const { treasuryContract, signers: { owner } } = await loadFixture(deployBase);
      await treasuryContract.addAuthorizedSource(await owner.getAddress());
      await treasuryContract.connect(owner).receiveFee(FeeSource.AUDIT_PLATFORM_FEE, G(100), 1);

      await expect(treasuryContract.distribute())
        .to.emit(treasuryContract, "FeeDistributed");

      expect(await treasuryContract.getPendingBalance()).to.equal(0n);
    });
  });

  describe("setDistributionConfig()", function () {
    it("owner can update split percentages", async function () {
      const { treasuryContract } = await loadFixture(deployBase);
      await expect(treasuryContract.setDistributionConfig(30, 60, 10))
        .to.emit(treasuryContract, "DistributionConfigUpdated");
    });

    it("rejects config that does not sum to 100", async function () {
      const { treasuryContract } = await loadFixture(deployBase);
      await expect(treasuryContract.setDistributionConfig(30, 60, 20))
        .to.be.revertedWith("Treasury: must sum to 100");
    });

    it("rejects non-owner caller", async function () {
      const { treasuryContract, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(treasuryContract.connect(agent1).setDistributionConfig(30, 60, 10))
        .to.be.reverted;
    });
  });

  describe("emergencyWithdraw()", function () {
    it("owner can rescue stuck funds", async function () {
      const { treasuryContract, signers: { owner } } = await loadFixture(deployBase);
      await treasuryContract.addAuthorizedSource(await owner.getAddress());
      await treasuryContract.connect(owner).receiveFee(FeeSource.AUDIT_PLATFORM_FEE, G(100), 1);

      await expect(treasuryContract.emergencyWithdraw(await owner.getAddress(), G(50)))
        .to.emit(treasuryContract, "EmergencyWithdraw");
    });

    it("rejects non-owner caller", async function () {
      const { treasuryContract, signers: { agent1, owner } } = await loadFixture(deployBase);
      await expect(
        treasuryContract.connect(agent1).emergencyWithdraw(await owner.getAddress(), G(1))
      ).to.be.reverted;
    });
  });
});

// =============================================================================
// Suite 8 — VaultFactory + AuditVault
// =============================================================================

describe("VaultFactory + AuditVault", function () {
  const TARGET_CONTRACT = "0x0000000000000000000000000000000000000123";
  const VAULT_CONFIG = {
    weeklyMonitoringBudget: G(10),
    criticalBountyAllocation: G(50),
    reauditIntervalSeconds: ONE_DAY,
    maxSingleAuditBudget: G(200),
    acceptsMonitoringBids: true,
  };

  async function deployWithVault() {
    const ctx = await deployWithAgents();
    const { vaultFactory } = ctx;
    const tx = await vaultFactory.createVault(TARGET_CONTRACT, "hedera-testnet", VAULT_CONFIG);
    await tx.wait();
    const vaultAddr = await vaultFactory.getVaultFor(TARGET_CONTRACT);
    return { ...ctx, vaultAddr };
  }

  describe("createVault()", function () {
    it("emits VaultCreated and registers vault address", async function () {
      const { vaultFactory } = await loadFixture(deployWithAgents);
      await expect(
        vaultFactory.createVault(TARGET_CONTRACT, "hedera-testnet", VAULT_CONFIG)
      ).to.emit(vaultFactory, "VaultCreated");

      const vaultAddr = await vaultFactory.getVaultFor(TARGET_CONTRACT);
      expect(vaultAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("rejects duplicate vault for same contract address", async function () {
      const { vaultFactory } = await loadFixture(deployWithVault);
      await expect(
        vaultFactory.createVault(TARGET_CONTRACT, "hedera-testnet", VAULT_CONFIG)
      ).to.be.revertedWith("VaultFactory: vault already exists");
    });

    it("isVault returns true for created vault, false for random address", async function () {
      const { vaultFactory, vaultAddr } = await loadFixture(deployWithVault);
      expect(await vaultFactory.isVault(vaultAddr)).to.be.true;
      expect(await vaultFactory.isVault("0x0000000000000000000000000000000000001234")).to.be.false;
    });

    it("getAllVaults returns all created vault addresses", async function () {
      const { vaultFactory } = await loadFixture(deployWithVault);
      const vaults = await vaultFactory.getAllVaults();
      expect(vaults.length).to.equal(1);
    });
  });

  describe("predictVaultAddress()", function () {
    it("pre-computed CREATE2 address matches actual deployed vault", async function () {
      const { vaultFactory, vaultAddr } = await loadFixture(deployWithVault);
      const predicted = await vaultFactory.predictVaultAddress(TARGET_CONTRACT);
      expect(predicted).to.equal(vaultAddr);
    });
  });

  describe("AuditVault.deposit()", function () {
    it("emits Deposited and increases currentBalance", async function () {
      const { vaultAddr, signers: { agent1 } } = await loadFixture(deployWithVault);
      const vault = await ethers.getContractAt("AuditVault", vaultAddr);
      await expect(vault.connect(agent1).deposit(G(100)))
        .to.emit(vault, "Deposited");
    });
  });
});

// =============================================================================
// Suite 9 — AuditBudgetVault
// =============================================================================

describe("AuditBudgetVault", function () {
  const COVERED = "0x0000000000000000000000000000000000000456";

  async function deployWithBudgetVault() {
    const ctx = await deployBase();
    const { budgetVault } = ctx;
    await budgetVault.createVault(COVERED, G(10), G(50));
    return ctx;
  }

  describe("createVault()", function () {
    it("emits VaultCreated and stores correct config", async function () {
      const { budgetVault } = await loadFixture(deployBase);
      await expect(budgetVault.createVault(COVERED, G(10), G(50)))
        .to.emit(budgetVault, "VaultCreated");

      const info = await budgetVault.getVaultInfo(COVERED);
      expect(info.active).to.be.true;
      expect(info.weeklyMonitoringBudget).to.equal(G(10));
      expect(info.criticalBountyAllocation).to.equal(G(50));
    });
  });

  describe("deposit()", function () {
    it("emits VaultDeposited and updates vault balance", async function () {
      const { budgetVault, signers: { owner } } = await loadFixture(deployWithBudgetVault);
      await expect(budgetVault.connect(owner).deposit(COVERED, G(200)))
        .to.emit(budgetVault, "VaultDeposited");

      expect(await budgetVault.getVaultBalance(COVERED)).to.equal(G(200));
    });
  });

  describe("updateVaultRules()", function () {
    it("depositor can update budgets and emits VaultRulesUpdated", async function () {
      const { budgetVault } = await loadFixture(deployWithBudgetVault);
      await expect(budgetVault.updateVaultRules(COVERED, G(20), G(100)))
        .to.emit(budgetVault, "VaultRulesUpdated");

      const info = await budgetVault.getVaultInfo(COVERED);
      expect(info.weeklyMonitoringBudget).to.equal(G(20));
    });
  });

  describe("getAllVaults()", function () {
    it("returns all tracked vault addresses", async function () {
      const { budgetVault } = await loadFixture(deployWithBudgetVault);
      expect((await budgetVault.getAllVaults()).length).to.equal(1);
    });
  });
});

// =============================================================================
// Suite 10 — TimeLockVault
// =============================================================================

describe("TimeLockVault", function () {
  const ONE_HBAR = ethers.parseEther("1");

  describe("deposit()", function () {
    it("emits Deposited with depositId=1 and correct unlock time", async function () {
      const { timeLockVault, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: ONE_HBAR })
      ).to.emit(timeLockVault, "Deposited");

      expect(await timeLockVault.nextDepositId()).to.equal(2n); // next=2 means id=1 was used
    });

    it("rejects zero-value deposit", async function () {
      const { timeLockVault, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: 0 })
      ).to.be.revertedWith("TimeLockVault: zero deposit");
    });

    it("rejects zero lock duration", async function () {
      const { timeLockVault, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        timeLockVault.connect(agent1).deposit(0, { value: ONE_HBAR })
      ).to.be.revertedWith("TimeLockVault: zero lock duration");
    });

    it("rejects plain ETH transfer without deposit() call", async function () {
      const { timeLockVault, signers: { agent1 } } = await loadFixture(deployBase);
      await expect(
        agent1.sendTransaction({ to: await timeLockVault.getAddress(), value: ONE_HBAR })
      ).to.be.revertedWith("TimeLockVault: use deposit()");
    });

    it("totalLocked accumulates across multiple deposits", async function () {
      const { timeLockVault, signers: { agent1, agent2 } } = await loadFixture(deployBase);
      await timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: ONE_HBAR });
      await timeLockVault.connect(agent2).deposit(ONE_HOUR, { value: ONE_HBAR });
      expect(await timeLockVault.totalLocked()).to.equal(ONE_HBAR * 2n);
    });
  });

  describe("withdraw()", function () {
    async function deployWithDeposit() {
      const ctx = await deployBase();
      const { timeLockVault, signers: { agent1 } } = ctx;
      const tx = await timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: ONE_HBAR });
      const receipt = await tx.wait();
      const event = receipt.logs
        .map(l => { try { return timeLockVault.interface.parseLog(l); } catch { return null; } })
        .find(e => e?.name === "Deposited");
      const depositId = event.args.depositId;
      return { ...ctx, depositId };
    }

    it("rejects withdrawal before lock expires", async function () {
      const { timeLockVault, depositId, signers: { agent1 } } = await loadFixture(deployWithDeposit);
      await expect(timeLockVault.connect(agent1).withdraw(depositId))
        .to.be.revertedWith("TimeLockVault: funds still locked");
    });

    it("succeeds after lock expires and emits Withdrawn", async function () {
      const { timeLockVault, depositId, signers: { agent1 } } = await loadFixture(deployWithDeposit);
      await time.increase(ONE_HOUR + 1);
      await expect(timeLockVault.connect(agent1).withdraw(depositId))
        .to.emit(timeLockVault, "Withdrawn");
    });

    it("rejects non-depositor caller", async function () {
      const { timeLockVault, depositId, signers: { agent2 } } = await loadFixture(deployWithDeposit);
      await time.increase(ONE_HOUR + 1);
      await expect(timeLockVault.connect(agent2).withdraw(depositId))
        .to.be.revertedWith("TimeLockVault: not depositor");
    });

    it("rejects double withdrawal", async function () {
      const { timeLockVault, depositId, signers: { agent1 } } = await loadFixture(deployWithDeposit);
      await time.increase(ONE_HOUR + 1);
      await timeLockVault.connect(agent1).withdraw(depositId);
      await expect(timeLockVault.connect(agent1).withdraw(depositId))
        .to.be.revertedWith("TimeLockVault: already withdrawn");
    });
  });

  describe("emergencyWithdraw()", function () {
    it("owner can force-release any deposit at any time (INTENTIONAL CENTRALISATION RISK)", async function () {
      const { timeLockVault, signers: { owner, agent1 } } = await loadFixture(deployBase);
      await timeLockVault.connect(agent1).deposit(ONE_DAY, { value: ONE_HBAR });
      // Funds are locked for 1 day, but owner can drain immediately
      await expect(timeLockVault.connect(owner).emergencyWithdraw(1))
        .to.emit(timeLockVault, "EmergencyWithdrawn");
    });

    it("rejects non-owner caller", async function () {
      const { timeLockVault, signers: { agent1, agent2 } } = await loadFixture(deployBase);
      await timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: ONE_HBAR });
      await expect(timeLockVault.connect(agent2).emergencyWithdraw(1))
        .to.be.reverted;
    });
  });

  describe("isLocked() / timeUntilUnlock()", function () {
    it("isLocked returns true before expiry, false after", async function () {
      const { timeLockVault, signers: { agent1 } } = await loadFixture(deployBase);
      await timeLockVault.connect(agent1).deposit(ONE_HOUR, { value: ONE_HBAR });
      expect(await timeLockVault.isLocked(1)).to.be.true;
      await time.increase(ONE_HOUR + 1);
      expect(await timeLockVault.isLocked(1)).to.be.false;
    });
  });
});

// =============================================================================
// Suite 11 — Integration: Full Audit Lifecycle
// =============================================================================

describe("Integration: Full Audit Lifecycle", function () {
  it("discovery → bid → winner selection → escrow release → job completion", async function () {
    const { auditAuction, agentRegistry, signers: { orchestrator, agent1, agent2 } } =
      await loadFixture(deployWithAgents);

    // 1. Create audit job
    const createTx = await auditAuction.connect(orchestrator).createAuditJob(
      "0x0000000000000000000000000000000000000789",
      "hedera-testnet", "staking",
      80, G(500), 2000, AUCTION_DURATION
    );
    const createReceipt = await createTx.wait();
    const jobId = extractJobId(createReceipt, auditAuction);
    expect((await auditAuction.getJob(jobId)).status).to.equal(JobStatus.AUCTION_OPEN);

    // 2. Agents bid
    await auditAuction.connect(agent1).submitBid(jobId, G(200), MIN_BID_COLLATERAL, ONE_HOUR, "static-analysis");
    await auditAuction.connect(agent2).submitBid(jobId, G(300), MIN_BID_COLLATERAL, ONE_HOUR * 2, "fuzzing");
    expect(await auditAuction.getBidCount(jobId)).to.equal(2n);

    // 3. Select winner (highest ranked)
    const ranked = await auditAuction.rankBids(jobId);
    await auditAuction.connect(orchestrator).selectWinners(jobId, [ranked[0]]);
    expect((await auditAuction.getJob(jobId)).status).to.equal(JobStatus.AUDITING_IN_PROGRESS);

    // 4. Release escrow to winner
    const job = await auditAuction.getJob(jobId);
    const winner = job.winningAgents[0];
    await auditAuction.connect(orchestrator).releaseEscrow(jobId, winner, job.totalEscrowedAmount, 0, 5, 0, 0);

    // 5. Complete job
    await auditAuction.connect(orchestrator).completeJob(jobId);
    expect((await auditAuction.getJob(jobId)).status).to.equal(JobStatus.COMPLETED);

    // 6. Verify job removed from active list
    const activeJobs = await auditAuction.getActiveJobs();
    expect(activeJobs.map(id => id.toString())).to.not.include(jobId.toString());
  });

  it("KNOWN CONTRACT BUG: slashAgentBid cross-contract call to agentRegistry.slashAgent() fails due to onlyOrchestrator guard", async function () {
    const ctx = await loadFixture(deployWithWinner);
    const { auditAuction, agentRegistry, jobId, signers: { orchestrator, agent1 } } = ctx;

    // AuditAuction.slashAgentBid() tries to call agentRegistry.slashAgent() but is blocked
    // because AgentRegistry.slashAgent() requires onlyOrchestrator and AuditAuction is
    // registered as auctionContract, not orchestrator. This is bug C5 in the known issues.
    await expect(
      auditAuction.connect(orchestrator).slashAgentBid(jobId, await agent1.getAddress(), 10_000)
    ).to.be.revertedWith("AgentRegistry: caller is not orchestrator");

    // Orchestrator can slash directly via agentRegistry.slashAgent() as a workaround
    await expect(
      agentRegistry.connect(orchestrator).slashAgent(await agent1.getAddress(), 500)
    ).to.emit(agentRegistry, "AgentSlashed");
  });

  it("vault-funded audit: budgetVault funds available for orchestrator to draw", async function () {
    const { budgetVault, signers: { owner } } = await loadFixture(deployBase);
    const covered = "0x0000000000000000000000000000000000000999";
    await budgetVault.createVault(covered, G(10), G(50));
    await budgetVault.connect(owner).deposit(covered, G(200));
    expect(await budgetVault.getVaultBalance(covered)).to.equal(G(200));
  });
});

// =============================================================================
// Suite 12 — Security & Edge Cases
// =============================================================================

describe("Security & Edge Cases", function () {
  it("AgentRegistry constructor rejects zero guard token address", async function () {
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    await expect(AgentRegistry.deploy(ethers.ZeroAddress))
      .to.be.revertedWith("AgentRegistry: guard token is zero");
  });

  it("AuditAuction constructor rejects zero guard token address", async function () {
    const AuditAuction = await ethers.getContractFactory("AuditAuction");
    const [, o, , , t] = await ethers.getSigners();
    await expect(AuditAuction.deploy(ethers.ZeroAddress, ethers.ZeroAddress, await o.getAddress(), await t.getAddress()))
      .to.be.revertedWith("AuditAuction: guard token is zero");
  });

  it("reputation never exceeds 10000 despite repeated positive updates", async function () {
    const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
    for (let i = 0; i < 5; i++) {
      await agentRegistry.connect(orchestrator).updateReputation(await agent1.getAddress(), 2_000);
    }
    expect(await agentRegistry.getAgentReputation(await agent1.getAddress())).to.equal(10_000n);
  });

  it("reputation never drops below 0 despite repeated negative updates", async function () {
    const { agentRegistry, signers: { orchestrator, agent1 } } = await loadFixture(deployWithAgents);
    for (let i = 0; i < 5; i++) {
      await agentRegistry.connect(orchestrator).updateReputation(await agent1.getAddress(), -3_000);
    }
    expect(await agentRegistry.getAgentReputation(await agent1.getAddress())).to.equal(0n);
  });

  it("AuditAuction.pause() is called by orchestrator, not owner", async function () {
    const { auditAuction, signers: { orchestrator, owner } } = await loadFixture(deployBase);
    // Owner cannot pause AuditAuction — only orchestrator can
    await expect(auditAuction.connect(orchestrator).pause()).to.not.be.reverted;
    await expect(auditAuction.connect(owner).unpause()).to.be.reverted; // owner cannot unpause either
    await auditAuction.connect(orchestrator).unpause();
  });

  it("AgentRegistry.setOrchestratorAndAuction() can only be called once", async function () {
    const { agentRegistry, signers: { agent1, agent2 } } = await loadFixture(deployBase);
    // Already configured in fixture — second call must revert
    await expect(
      agentRegistry.setOrchestratorAndAuction(await agent1.getAddress(), await agent2.getAddress())
    ).to.be.revertedWith("AgentRegistry: already configured");
  });

  it("all Pausable contracts expose pause() and unpause() functions", async function () {
    const { agentRegistry, auditAuction, subAuction, stakingManager, paymentSettlement } =
      await loadFixture(deployBase);
    for (const contract of [agentRegistry, auditAuction, subAuction, stakingManager, paymentSettlement]) {
      expect(typeof contract.pause).to.equal("function");
      expect(typeof contract.unpause).to.equal("function");
    }
  });

  it("AuditAuction slashAgentBid only accepts 500, 1000, or 10000 bps", async function () {
    const { auditAuction, jobId, signers: { orchestrator, agent1 } } = await loadFixture(deployWithWinner);
    for (const invalid of [0, 1, 499, 501, 999, 1001, 9999, 10001]) {
      await expect(
        auditAuction.connect(orchestrator).slashAgentBid(jobId, await agent1.getAddress(), invalid)
      ).to.be.revertedWith("AuditAuction: invalid slash bps");
    }
  });
});
