/**
 * deploy-audit-scheduler.js
 * Deploys the AuditScheduler contract to Hedera Testnet and registers it with AuditAuction.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-audit-scheduler.js --network hedera_testnet
 *   or from repo root:
 *   npm run deploy:audit-scheduler
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const SDK_CONFIG_PATH = path.resolve(__dirname, "../packages/sdk/config.json");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying AuditScheduler with account:", deployer.address);

  // ── Read existing SDK config ───────────────────────────────────────────────
  let config = {};
  if (fs.existsSync(SDK_CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(SDK_CONFIG_PATH, "utf8"));
  }

  const guardToken = config?.contracts?.guardToken?.evmAddress;
  const auctionAddress = config?.contracts?.auctionContract?.evmAddress;
  const budgetVaultAddress = config?.contracts?.budgetVault?.evmAddress;

  if (!guardToken)    throw new Error("guardToken not found in config.json — deploy it first");
  if (!auctionAddress) throw new Error("auctionContract not found in config.json — deploy it first");

  console.log("guardToken:     ", guardToken);
  console.log("auctionContract:", auctionAddress);
  console.log("budgetVault:    ", budgetVaultAddress ?? "(not set, scheduler will not budget-check)");

  // ── Deploy ─────────────────────────────────────────────────────────────────
  const minAuditBudget = ethers.parseUnits("5", 8); // 5 GUARD (8 decimals)

  const AuditScheduler = await ethers.getContractFactory("AuditScheduler");
  const scheduler = await AuditScheduler.deploy(
    guardToken,
    auctionAddress,
    deployer.address, // initial orchestrator = deployer; update after orchestrator is deployed
    minAuditBudget
  );
  await scheduler.waitForDeployment();
  const schedulerAddress = await scheduler.getAddress();
  console.log("AuditScheduler deployed at:", schedulerAddress);

  // EVM address from Hedera mirror node (account mirror lookup)
  // For Hedera, the EVM address is the contract address directly
  const evmAddress = schedulerAddress.toLowerCase();

  // ── Wire AuditAuction ──────────────────────────────────────────────────────
  console.log("Registering AuditScheduler with AuditAuction...");
  const AuditAuction = await ethers.getContractFactory("AuditAuction");
  const auction = AuditAuction.attach(auctionAddress);

  try {
    const tx = await auction.setAuditScheduler(schedulerAddress);
    await tx.wait();
    console.log("  ✓ AuditAuction.setAuditScheduler() called");
  } catch (err) {
    console.warn("  ⚠ Could not call setAuditScheduler (may need to be owner):", err.message);
  }

  // ── Update SDK config ──────────────────────────────────────────────────────
  config.contracts = config.contracts || {};
  config.contracts.auditScheduler = {
    address: schedulerAddress,
    evmAddress,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SDK_CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log("Updated packages/sdk/config.json with auditScheduler address");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n=== AuditScheduler Deployment Summary ===");
  console.log("Address:       ", schedulerAddress);
  console.log("EVM Address:   ", evmAddress);
  console.log("Guard Token:   ", guardToken);
  console.log("Auction:       ", auctionAddress);
  console.log("Min Budget:    ", minAuditBudget.toString(), "GUARD units");
  console.log("\nNext steps:");
  console.log("  1. Update .env: AUDIT_SCHEDULER_ADDRESS=" + schedulerAddress);
  console.log("  2. Call scheduler.setOrchestrator(ORCHESTRATOR_ADDRESS) after orchestrator deploy");
  console.log("  3. Vault owners can now call scheduleAudit(contractAddress, interval, mode)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
