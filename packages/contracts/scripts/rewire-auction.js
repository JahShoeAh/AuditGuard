#!/usr/bin/env node
/**
 * rewire-auction.js
 *
 * Deploys new SubAuction and PaymentSettlement contracts wired to the already-deployed
 * new AuditAuction (0xbCe2fde4cf1F6d9fde62ed33Cc3E4B1e7C1F4F87).
 *
 * Background: The original SubAuction and PaymentSettlement were deployed by a
 * different Hedera account (0xDC126e...885a) which doesn't match the current
 * OPERATOR_PRIVATE_KEY (0xC1E5d5...859). This means:
 *   - settleJob() on old PS reverts (wrong onlyOrchestrator)
 *   - setMainAuction() on old PS/SubAuction reverts (wrong onlyOwner)
 *
 * This script deploys fresh PS + SubAuction owned+orchestrated by the current key.
 *
 * Run:
 *   npx hardhat run packages/contracts/scripts/rewire-auction.js \
 *     --config packages/contracts/hardhat.config.js --network hedera_testnet
 *
 * After running:
 *   npm run activate:live-agents   # ensure agents are active
 *   Restart orchestrator + agents
 */

const hre = require("hardhat");
const path = require("path");
const fs = require("fs");

const SDK_DIR = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR = path.join(SDK_DIR, "abis");

const GAS_LIMIT = 5_000_000;
const NEW_AUCTION_ADDRESS = "0x9e47bBa152F1506F80Ad1168F37A47C66DEE0F5d";

async function resolveHederaId(evmAddress) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(
        `https://testnet.mirrornode.hedera.com/api/v1/contracts/${evmAddress.toLowerCase()}`
      );
      const data = await res.json();
      if (data.contract_id) return data.contract_id;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "unknown";
}

async function sendTx(fn, label) {
  console.log(`  → ${label}...`);
  const tx = await fn();
  const receipt = await tx.wait();
  if (receipt.status === 0) throw new Error(`${label}: tx reverted (hash=${receipt.hash})`);
  console.log(`    ✓ ${label} (${receipt.hash})`);
  return receipt;
}

function exportAbi(contractName, outName) {
  const artifactPath = path.join(
    __dirname,
    `../artifacts/contracts/${contractName}.sol/${contractName}.json`
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiOut = {
    contractName: artifact.contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  };
  fs.writeFileSync(path.join(ABI_DIR, `${outName}.json`), JSON.stringify(abiOut, null, 2));
  console.log(`  ABI exported → packages/sdk/abis/${outName}.json`);
}

async function main() {
  await hre.run("compile", { quiet: true });

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer (current key):", deployer.address);
  console.log();
  console.log("Fixed addresses:");
  console.log("  Guard token:    ", config.guardTokenEvmAddress);
  console.log("  AgentRegistry:  ", config.contracts.agentRegistry.evmAddress);
  console.log("  Treasury:       ", config.contracts.treasury.evmAddress);
  console.log("  AuditAuction:   ", NEW_AUCTION_ADDRESS, "(already deployed)");
  console.log();

  // ── 1. Update config.json with new AuditAuction (already deployed) ─────────
  const oldAuctionAddr = config.contracts.auctionContract?.evmAddress ?? "none";
  if (oldAuctionAddr.toLowerCase() !== NEW_AUCTION_ADDRESS.toLowerCase()) {
    const hederaId = await resolveHederaId(NEW_AUCTION_ADDRESS);
    config.contracts.auctionContract = { id: hederaId, evmAddress: NEW_AUCTION_ADDRESS };
    console.log(`config.json: auctionContract ${oldAuctionAddr} → ${NEW_AUCTION_ADDRESS}`);
  } else {
    console.log("config.json: auctionContract already up to date");
  }

  // Export AuditAuction ABI
  exportAbi("AuditAuction", "AuditAuction");

  // ── 2. Deploy SubAuction ────────────────────────────────────────────────────
  console.log("\nDeploying SubAuction...");
  const saFactory = await hre.ethers.getContractFactory("SubAuction", deployer);
  const subAuction = await saFactory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    NEW_AUCTION_ADDRESS,
    config.contracts.treasury.evmAddress,
    { gasLimit: GAS_LIMIT }
  );
  await subAuction.waitForDeployment();
  const subAuctionAddr = await subAuction.getAddress();
  console.log("SubAuction EVM address:", subAuctionAddr);

  // Associate GUARD on HTS
  try {
    await sendTx(
      () => subAuction.associateGuardToken({ gasLimit: 300_000 }),
      "SubAuction.associateGuardToken()"
    );
  } catch (e) {
    console.warn("  ⚠  SubAuction associateGuardToken failed (may be expected):", e.message.slice(0, 80));
  }

  // ── 3. Deploy PaymentSettlement ─────────────────────────────────────────────
  console.log("\nDeploying PaymentSettlement...");
  const psFactory = await hre.ethers.getContractFactory("PaymentSettlement", deployer);
  const ps = await psFactory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    NEW_AUCTION_ADDRESS,
    subAuctionAddr,
    config.contracts.treasury.evmAddress,
    deployer.address,   // orchestrator = current operator key
    { gasLimit: GAS_LIMIT }
  );
  await ps.waitForDeployment();
  const psAddr = await ps.getAddress();
  console.log("PaymentSettlement EVM address:", psAddr);

  // Associate GUARD on HTS
  try {
    await sendTx(
      () => ps.associateGuardToken({ gasLimit: 300_000 }),
      "PaymentSettlement.associateGuardToken()"
    );
  } catch (e) {
    console.warn("  ⚠  PaymentSettlement associateGuardToken failed (may be expected):", e.message.slice(0, 80));
  }

  // ── 4. Resolve Hedera IDs ────────────────────────────────────────────────────
  console.log("\nResolving Hedera IDs (up to ~48s)...");
  const [subHederaId, psHederaId] = await Promise.all([
    resolveHederaId(subAuctionAddr),
    resolveHederaId(psAddr),
  ]);
  console.log("SubAuction Hedera ID:", subHederaId);
  console.log("PaymentSettlement Hedera ID:", psHederaId);

  // ── 5. Update config.json ────────────────────────────────────────────────────
  config.contracts.subAuction = { id: subHederaId, evmAddress: subAuctionAddr };
  config.contracts.paymentSettlement = { id: psHederaId, evmAddress: psAddr };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log("\nconfig.json updated:");
  console.log(`  subAuction:       → ${subAuctionAddr}`);
  console.log(`  paymentSettlement → ${psAddr}`);

  // ── 6. Export ABIs ───────────────────────────────────────────────────────────
  console.log("\nExporting ABIs...");
  exportAbi("SubAuction", "SubAuction");
  exportAbi("PaymentSettlement", "PaymentSettlement");

  console.log(`
Done. All three contracts are now wired to the current operator key (${deployer.address}).

IMPORTANT — Manual steps required before restarting:
  1. The new PaymentSettlement needs GUARD to settle jobs.
     The orchestrator will call depositSettlementFunds() per-job, but ensure
     the operator wallet has sufficient GUARD balance.

  2. npm run activate:live-agents   # ensures agents are registered + active
  3. Restart orchestrator + agents  # picks up new contract addresses from config.json

  Summary:
    AuditAuction:      ${NEW_AUCTION_ADDRESS}
    SubAuction:        ${subAuctionAddr}
    PaymentSettlement: ${psAddr}
`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
