/**
 * Day 3 iNFT Integration Test
 * Tests all new Day 3 service methods against live data from prior demo runs.
 * Usage: node packages/inft/scripts/test-day3-integration.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env"), override: true });

const { INFTService } = require("../src/inft-service");

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           AuditGuard Day 3 Integration Tests                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const svc = new INFTService({
    operatorId: process.env.HEDERA_ACCOUNT_ID,
    operatorKey: process.env.HEDERA_PRIVATE_KEY,
    keyType: process.env.HEDERA_PRIVATE_KEY_TYPE,
  });

  const agentSerial = svc.findSerial("agentProfile", "agentId", "SecuritySentinel-9000");
  const healthSerial = svc.findSerial("contractHealth", "contract.contractAddress", "0x" + "c3".repeat(20));

  if (!agentSerial || !healthSerial) {
    console.log("Run demo-day3.js first to create test data");
    svc.close();
    process.exit(1);
  }

  console.log(`Testing on agent #${agentSerial}, health #${healthSerial}\n`);
  let pass = 0;
  let fail = 0;

  function check(label, result) {
    if (result) { console.log(`  ✓ ${label}`); pass++; }
    else { console.error(`  ✗ ${label}`); fail++; }
  }

  // --- Test updateAgentStakingDetails ---
  console.log("Test 1: updateAgentStakingDetails");
  await svc.updateAgentStakingDetails(agentSerial, {
    totalStaked: 450, lockedStake: 100, availableStake: 350,
    unbondingAmount: 0, status: "ACTIVE", _action: "test_update",
  });
  const a1 = await svc.getINFT("agentProfile", agentSerial);
  check("staking.totalStaked === 450", a1.staking.totalStaked === 450);
  check("staking.lockedStake === 100", a1.staking.lockedStake === 100);
  check("staking.status === ACTIVE", a1.staking.status === "ACTIVE");
  check("staking.history populated", a1.staking.history.length > 0);
  check("economics.stakedAmount synced", a1.economics.stakedAmount === 450);
  console.log("");

  // --- Test recordSlashOnAgent ---
  console.log("Test 2: recordSlashOnAgent");
  await svc.recordSlashOnAgent(agentSerial, {
    slashId: 9901, jobId: 101, subJobId: 0,
    reason: "FALSE_POSITIVE", slashBasisPoints: 500,
    slashedAmount: 22.5, evidenceHash: "0x" + "ef".repeat(32),
    slashedBy: "StakingManager",
  });
  const a2 = await svc.getINFT("agentProfile", agentSerial);
  const slashEntry = (a2.slashHistory || []).find(s => s.slashId === 9901);
  check("slashHistory entry created", !!slashEntry);
  check("evidenceHash stored", !!slashEntry?.evidenceHash);
  check("appealStatus = PENDING", slashEntry?.appealStatus === "PENDING");
  check("economics.totalSlashed updated", a2.economics.totalSlashed > 0);
  console.log("");

  // --- Test updateSlashAppeal ---
  console.log("Test 3: updateSlashAppeal (deny)");
  await svc.updateSlashAppeal(agentSerial, 9901, "DENIED");
  const a3 = await svc.getINFT("agentProfile", agentSerial);
  const slash3 = (a3.slashHistory || []).find(s => s.slashId === 9901);
  check("appealStatus = DENIED", slash3?.appealStatus === "DENIED");
  console.log("");

  // --- Test updateSlashAppeal (approve + restore) ---
  console.log("Test 4: updateSlashAppeal (approve with restoration)");
  // Record a second slash to approve
  await svc.recordSlashOnAgent(agentSerial, {
    slashId: 9902, jobId: 102, subJobId: 0,
    reason: "SLA_VIOLATION", slashBasisPoints: 2500,
    slashedAmount: 50, evidenceHash: "0x" + "ab".repeat(32),
    slashedBy: "StakingManager",
  });
  const priorStake = (await svc.getINFT("agentProfile", agentSerial)).economics.stakedAmount;
  await svc.updateSlashAppeal(agentSerial, 9902, "APPROVED", null, 50);
  const a4 = await svc.getINFT("agentProfile", agentSerial);
  const slash4 = (a4.slashHistory || []).find(s => s.slashId === 9902);
  check("appealStatus = APPROVED", slash4?.appealStatus === "APPROVED");
  check("stake restored after appeal", a4.economics.stakedAmount === priorStake + 50);
  console.log("");

  // --- Test updateContractVaultInfo ---
  console.log("Test 5: updateContractVaultInfo");
  await svc.updateContractVaultInfo(healthSerial, {
    vaultAddress: "0x1212121212121212121212121212121212121212",
    creator: "0xdeployer",
    currentBalance: 300,
    weeklyMonitoringBudget: 10,
    criticalBountyAllocation: 50,
    reauditIntervalSeconds: 300,
  });
  const h1 = await svc.getINFT("contractHealth", healthSerial);
  check("vault.vaultAddress set", !!h1.vault?.vaultAddress);
  check("vault.currentBalance = 300", h1.vault?.currentBalance === 300);
  check("vault.weeklyMonitoringBudget = 10", h1.vault?.weeklyMonitoringBudget === 10);
  console.log("");

  // --- Test updateContractMonitoring ---
  console.log("Test 6: updateContractMonitoring");
  await svc.updateContractMonitoring(healthSerial, {
    isActive: true, agentAddress: "0xmonitor",
    weeklyRate: 5, startedAt: new Date().toISOString(),
  });
  const h2 = await svc.getINFT("contractHealth", healthSerial);
  check("monitoring.isActive = true", h2.monitoring?.isActive === true);
  check("monitoring.weeklyRate = 5", h2.monitoring?.weeklyRate === 5);
  check("monitoring.agentAddress set", !!h2.monitoring?.agentAddress);
  console.log("");

  // --- Test recordTreasuryFee + recordTreasuryDistribution ---
  console.log("Test 7: Treasury fee + distribution tracking");
  await svc.recordTreasuryFee({ source: "AUDIT_PLATFORM_FEE", amount: 50, jobId: 101, fromContract: "0xauction" });
  await svc.recordTreasuryFee({ source: "SLASHING_PROCEEDS", amount: 22.5, jobId: 101, fromContract: "0xstaking" });
  const metrics = await svc.storage.load("_ecosystem", "treasury");
  check("treasury.totalRevenue >= 72.5", metrics?.totalRevenue >= 72.5);
  check("AUDIT_PLATFORM_FEE tracked", (metrics?.revenueBySource?.AUDIT_PLATFORM_FEE || 0) >= 50);
  check("SLASHING_PROCEEDS tracked", (metrics?.revenueBySource?.SLASHING_PROCEEDS || 0) >= 22.5);
  check("feeHistory has entries", (metrics?.feeHistory?.length || 0) > 0);

  await svc.recordTreasuryDistribution({ distributionId: 1, totalDistributed: 72.5, ucpAmount: 29, reserveAmount: 36.25, burnAmount: 7.25 });
  const metrics2 = await svc.storage.load("_ecosystem", "treasury");
  check("distribution recorded", (metrics2?.distributions?.length || 0) > 0);
  console.log("");

  // --- Test uploadSlashEvidence (0g blob upload) ---
  console.log("Test 8: uploadSlashEvidence (0g DA)");
  const hash = await svc.uploadSlashEvidence({
    description: "Agent submitted fabricated vulnerability report",
    jobId: 101,
    agentAddress: "0x" + "ae".repeat(20),
    findings: [{ type: "false_positive", count: 3 }],
  });
  check("evidence uploaded, hash returned", typeof hash === "string" && hash.startsWith("0x"));
  console.log(`  Evidence hash: ${hash}`);
  console.log("");

  // --- Event Listener contract map check ---
  console.log("Test 9: Event listener contract map");
  const config = JSON.parse(require("fs").readFileSync(
    require("path").join(__dirname, "../../sdk/config.json"), "utf8"
  ));
  const day3Contracts = ["stakingManager", "treasury", "vaultFactory"];
  for (const c of day3Contracts) {
    check(`config.contracts.${c} exists`, !!config.contracts?.[c]?.evmAddress);
  }
  console.log("");

  console.log("─".repeat(64));
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("\n  All Day 3 integration tests passed! ✓");
  } else {
    console.log("\n  Some tests failed. See above for details.");
    process.exitCode = 1;
  }

  svc.close();
}

main().catch(e => {
  console.error("\n  [FATAL]", e.message);
  console.error(e.stack);
  process.exit(1);
});
