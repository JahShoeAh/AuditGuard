/**
 * AuditGuard Gas Report
 *
 * Deploys all 10 contracts with the same fixture as the test suite,
 * runs 15 key operations, captures gasUsed, prints a formatted table,
 * and writes gas-report.json.
 *
 * Usage:
 *   npx hardhat run scripts/gas-report.js
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const e8 = (n) => ethers.parseUnits(n.toString(), 8);

async function deployFixture() {
  const [owner, orchestrator, agent1, agent2, ucpPool, protocolReserve, burnAddr] =
    await ethers.getSigners();

  // Deploy MockHTS at 0x167
  const MockHTS = await ethers.getContractFactory("MockHTS");
  const mockHts = await MockHTS.deploy();
  await mockHts.waitForDeployment();
  const code = await ethers.provider.getCode(await mockHts.getAddress());
  await ethers.provider.send("hardhat_setCode", [
    "0x0000000000000000000000000000000000000167",
    code,
  ]);

  // Deploy GUARD token
  const Guard = await ethers.getContractFactory("MockGuardToken");
  const guard = await Guard.deploy("GUARD", "GUARD", e8(10_000_000));
  await guard.waitForDeployment();
  const guardAddr = await guard.getAddress();

  // Deploy contracts
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(guardAddr);

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    guardAddr,
    await ucpPool.getAddress(),
    await protocolReserve.getAddress(),
    await burnAddr.getAddress()
  );

  const AuditAuction = await ethers.getContractFactory("AuditAuction");
  const auditAuction = await AuditAuction.deploy(
    guardAddr,
    await agentRegistry.getAddress(),
    await orchestrator.getAddress(),
    await treasury.getAddress()
  );

  const SubAuction = await ethers.getContractFactory("SubAuction");
  const subAuction = await SubAuction.deploy(
    guardAddr,
    await agentRegistry.getAddress(),
    await auditAuction.getAddress(),
    await treasury.getAddress()
  );

  const StakingManager = await ethers.getContractFactory("StakingManager");
  const stakingManager = await StakingManager.deploy(
    guardAddr,
    await agentRegistry.getAddress(),
    await treasury.getAddress()
  );

  const PaymentSettlement = await ethers.getContractFactory("PaymentSettlement");
  const paymentSettlement = await PaymentSettlement.deploy(
    guardAddr,
    await agentRegistry.getAddress(),
    await auditAuction.getAddress(),
    await subAuction.getAddress(),
    await treasury.getAddress(),
    await orchestrator.getAddress()
  );

  const DataMarketplace = await ethers.getContractFactory("DataMarketplace");
  const dataMarketplace = await DataMarketplace.deploy(
    guardAddr,
    await agentRegistry.getAddress(),
    await treasury.getAddress()
  );

  const VaultFactory = await ethers.getContractFactory("VaultFactory");
  const vaultFactory = await VaultFactory.deploy(guardAddr, await agentRegistry.getAddress());

  const BudgetVault = await ethers.getContractFactory("AuditBudgetVault");
  const budgetVault = await BudgetVault.deploy(guardAddr);

  // Wire cross-references
  await agentRegistry.setOrchestratorAndAuction(
    await orchestrator.getAddress(),
    await auditAuction.getAddress()
  );
  await treasury.addAuthorizedSource(await auditAuction.getAddress());
  await treasury.addAuthorizedSource(await owner.getAddress());
  await vaultFactory.setAuctionContract(await auditAuction.getAddress());
  await vaultFactory.setPaymentSettlement(await paymentSettlement.getAddress());
  await budgetVault.setAuthorizedDrawer(await auditAuction.getAddress());
  await stakingManager.addAuthorizedSlasher(await orchestrator.getAddress());

  // Fund agents
  for (const signer of [agent1, agent2, orchestrator]) {
    await guard.transfer(await signer.getAddress(), e8(50_000));
  }

  return {
    owner, orchestrator, agent1, agent2,
    guard, agentRegistry, auditAuction, subAuction,
    stakingManager, paymentSettlement, treasury,
    dataMarketplace, vaultFactory, budgetVault,
  };
}

async function measure(label, contract, method, args, signer) {
  const fn = signer ? contract.connect(signer)[method] : contract[method];
  const tx = await fn(...args);
  const receipt = await tx.wait();
  return { label, gas: Number(receipt.gasUsed) };
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║           AuditGuard Gas Report                      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log("Deploying fixture...");

  const ctx = await deployFixture();
  const { orchestrator, agent1, agent2 } = ctx;
  const results = [];

  // ── 1. AgentRegistry.registerAgent ──────────────────────────────
  results.push(await measure(
    "AgentRegistry.registerAgent",
    ctx.agentRegistry, "registerAgent",
    ["static-47", "https://agent.io/ucp", ["static-analysis"], e8(100)],
    agent1
  ));

  // ── 2. AgentRegistry.addStake ────────────────────────────────────
  results.push(await measure(
    "AgentRegistry.addStake",
    ctx.agentRegistry, "addStake",
    [e8(200)],
    agent1
  ));

  // ── 3. AgentRegistry.updateReputation ────────────────────────────
  results.push(await measure(
    "AgentRegistry.updateReputation",
    ctx.agentRegistry, "updateReputation",
    [await agent1.getAddress(), 500],
    orchestrator
  ));

  // ── 4. AgentRegistry.slashAgent ──────────────────────────────────
  // Register agent2 first
  await ctx.agentRegistry.connect(agent2).registerAgent(
    "fuzzer-12", "https://fuzzer.io/ucp", ["fuzzing"], e8(100)
  );
  results.push(await measure(
    "AgentRegistry.slashAgent",
    ctx.agentRegistry, "slashAgent",
    [await agent2.getAddress(), 500],
    orchestrator
  ));

  // ── 5. AuditAuction.createAuditJob ───────────────────────────────
  results.push(await measure(
    "AuditAuction.createAuditJob",
    ctx.auditAuction, "createAuditJob",
    [
      "0x0000000000000000000000000000000000000123",
      "hedera-testnet", "lending", 75, e8(1000), 5000, 3600,
    ],
    orchestrator
  ));

  // ── 6. AuditAuction.submitBid ────────────────────────────────────
  results.push(await measure(
    "AuditAuction.submitBid",
    ctx.auditAuction, "submitBid",
    [1, e8(100), e8(50), 3600, "static-analysis"],
    agent1
  ));

  // ── 7. AuditAuction.selectWinners ────────────────────────────────
  results.push(await measure(
    "AuditAuction.selectWinners",
    ctx.auditAuction, "selectWinners",
    [1, [0]],
    orchestrator
  ));

  // ── 8. AuditAuction.releaseEscrow ────────────────────────────────
  const job = await ctx.auditAuction.getJob(1);
  results.push(await measure(
    "AuditAuction.releaseEscrow",
    ctx.auditAuction, "releaseEscrow",
    [1, await agent1.getAddress(), job.totalEscrowedAmount, 0, 5, 0, 0],
    orchestrator
  ));

  // ── 9. AuditAuction.completeJob ──────────────────────────────────
  results.push(await measure(
    "AuditAuction.completeJob",
    ctx.auditAuction, "completeJob",
    [1],
    orchestrator
  ));

  // ── 10. SubAuction.createSubAuction ──────────────────────────────
  // Create a new job for sub-auction test
  await ctx.auditAuction.connect(orchestrator).createAuditJob(
    "0x0000000000000000000000000000000000000456",
    "hedera-testnet", "dex", 60, e8(500), 3000, 3600
  );
  await ctx.auditAuction.connect(agent1).submitBid(2, e8(200), e8(50), 3600, "static");
  await ctx.auditAuction.connect(orchestrator).selectWinners(2, [0]);

  results.push(await measure(
    "SubAuction.createSubAuction",
    ctx.subAuction, "createSubAuction",
    [2, "Dependency check", "dependency", e8(20), 7200, 3600],
    agent1
  ));

  // ── 11. SubAuction.submitSubBid ──────────────────────────────────
  results.push(await measure(
    "SubAuction.submitSubBid",
    ctx.subAuction, "submitSubBid",
    [1, e8(18), 3600, e8(10)],
    agent2
  ));

  // ── 12. DataMarketplace.createListing ────────────────────────────
  const hash = ethers.keccak256(ethers.toUtf8Bytes("content"));
  results.push(await measure(
    "DataMarketplace.createListing",
    ctx.dataMarketplace, "createListing",
    [1, "Scan Report", "Full scan results", 0, 0, e8(5), 0, hash, 10, 0],
    agent1
  ));

  // ── 13. DataMarketplace.purchaseData ─────────────────────────────
  results.push(await measure(
    "DataMarketplace.purchaseData",
    ctx.dataMarketplace, "purchaseData",
    [1],
    agent2
  ));

  // ── 14. VaultFactory.createVault ─────────────────────────────────
  const config = {
    weeklyMonitoringBudget: e8(10),
    criticalBountyAllocation: e8(50),
    reauditIntervalSeconds: 86400,
    maxSingleAuditBudget: e8(200),
    acceptsMonitoringBids: true,
  };
  results.push(await measure(
    "VaultFactory.createVault",
    ctx.vaultFactory, "createVault",
    ["0x0000000000000000000000000000000000000789", "hedera-testnet", config],
    agent1
  ));

  // ── 15. AuditBudgetVault.deposit ─────────────────────────────────
  await ctx.budgetVault.connect(agent1).createVault(
    "0x0000000000000000000000000000000000000ABC", e8(10), e8(50)
  );
  results.push(await measure(
    "AuditBudgetVault.deposit",
    ctx.budgetVault, "deposit",
    ["0x0000000000000000000000000000000000000ABC", e8(100)],
    agent1
  ));

  // ── Print table ────────────────────────────────────────────────────
  console.log("\n┌─────────────────────────────────────────────┬───────────┐");
  console.log("│ Operation                                   │  Gas Used │");
  console.log("├─────────────────────────────────────────────┼───────────┤");

  for (const r of results) {
    const label = r.label.padEnd(43);
    const gas = r.gas.toLocaleString().padStart(9);
    console.log(`│ ${label} │ ${gas} │`);
  }

  const totalGas = results.reduce((s, r) => s + r.gas, 0);
  const avgGas = Math.round(totalGas / results.length);
  console.log("├─────────────────────────────────────────────┼───────────┤");
  console.log(`│ ${"TOTAL".padEnd(43)} │ ${totalGas.toLocaleString().padStart(9)} │`);
  console.log(`│ ${"AVERAGE".padEnd(43)} │ ${avgGas.toLocaleString().padStart(9)} │`);
  console.log("└─────────────────────────────────────────────┴───────────┘\n");

  // ── Write JSON ────────────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    network: "hardhat-local",
    operations: results,
    summary: {
      totalOperations: results.length,
      totalGasUsed: totalGas,
      averageGasPerOperation: avgGas,
      minGas: Math.min(...results.map((r) => r.gas)),
      maxGas: Math.max(...results.map((r) => r.gas)),
    },
  };

  const outPath = path.join(__dirname, "..", "gas-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Gas report written to: ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
