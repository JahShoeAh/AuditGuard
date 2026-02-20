#!/usr/bin/env node
/**
 * Deploy HbarPool + redeploy DelegatedStaking with HbarPool integration.
 *
 * Steps:
 *   1. Deploy HbarPool (fixed-rate HBAR/GUARD converter)
 *   2. Fund pool with GUARD tokens from operator
 *   3. Send HBAR to pool for initial backing
 *   4. Redeploy DelegatedStaking (with HbarPool support)
 *   5. Wire: ds.setHbarPool(pool), sm.setDelegatedStaking(ds)
 *   6. Update packages/sdk/config.json
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const REPO_ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts");

if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = "hedera_testnet";
}
process.env.HARDHAT_CONFIG = path.join(CONTRACTS_DIR, "hardhat.config.js");
process.chdir(CONTRACTS_DIR);

const hardhatRequire = createRequire(path.join(CONTRACTS_DIR, "package.json"));
const { ethers } = hardhatRequire("hardhat");

const CONFIG_PATH = path.join(REPO_ROOT, "packages", "sdk", "config.json");

// ── Config Helpers ──────────────────────────────────────────────

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function normalizePrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  }
  return value.startsWith("0x") ? value : `0x${value}`;
}

// ── Seed amounts ────────────────────────────────────────────────

const SEED_GUARD = 10000n * 10n ** 8n;  // 10,000 GUARD (8 decimals) = 100 HBAR worth
const SEED_HBAR  = 20n * 10n ** 8n;     // 20 HBAR in tinybars

async function main() {
  console.log("\n=== HbarPool + DelegatedStaking Deployment ===\n");

  const config = readConfig();
  const guardTokenAddress = config.guardTokenEvmAddress;
  const treasuryAddress = config.contracts.treasury.evmAddress;
  const stakingManagerAddress = config.contracts.stakingManager.evmAddress;

  if (!guardTokenAddress || !treasuryAddress) {
    throw new Error("Missing GUARD token or treasury address in config");
  }

  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`GUARD Token: ${guardTokenAddress}`);
  console.log(`Treasury: ${treasuryAddress}`);

  // ── 1. Deploy HbarPool ─────────────────────────────────────────

  console.log("\n[1/6] Deploying HbarPool...");
  const HbarPool = await ethers.getContractFactory("HbarPool", wallet);

  console.log("  Sending deployment transaction...");
  const pool = await HbarPool.deploy(guardTokenAddress, { gasLimit: 3_000_000 });
  console.log("  Waiting for deployment...");
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`  ✓ HbarPool deployed: ${poolAddress}`);

  // ── 2. Fund pool with GUARD ─────────────────────────────────────

  console.log("\n[2/6] Funding pool with GUARD...");
  const guardToken = new ethers.Contract(
    guardTokenAddress,
    ["function transfer(address to, uint256 amount) returns (bool)",
     "function balanceOf(address) view returns (uint256)",
     "function approve(address spender, uint256 amount) returns (bool)"],
    wallet
  );

  const operatorGuard = await guardToken.balanceOf(wallet.address);
  console.log(`  Operator GUARD balance: ${ethers.formatUnits(operatorGuard, 8)} GUARD`);

  if (operatorGuard < SEED_GUARD) {
    console.log(`  ⚠ Insufficient GUARD for seeding (need ${ethers.formatUnits(SEED_GUARD, 8)}). Skipping GUARD seed.`);
  } else {
    const tx1 = await guardToken.transfer(poolAddress, SEED_GUARD, { gasLimit: 200_000 });
    await tx1.wait();
    console.log(`  ✓ Transferred ${ethers.formatUnits(SEED_GUARD, 8)} GUARD to pool`);
  }

  // ── 3. Fund pool with HBAR ──────────────────────────────────────

  console.log("\n[3/6] Funding pool with HBAR...");
  // HBAR value in weibars for ethers.js: tinybars * 10^10
  const hbarWei = SEED_HBAR * 10n ** 10n;
  const tx2 = await wallet.sendTransaction({
    to: poolAddress,
    value: hbarWei,
    gasLimit: 50_000
  });
  await tx2.wait();
  console.log(`  ✓ Sent ${ethers.formatUnits(SEED_HBAR, 8)} HBAR to pool`);

  // ── 4. Deploy new DelegatedStaking ─────────────────────────────

  console.log("\n[4/6] Deploying new DelegatedStaking with 5M gas limit...");
  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", wallet);

  console.log("  Sending deployment transaction...");
  const ds = await DelegatedStaking.deploy(
    guardTokenAddress,
    treasuryAddress,
    { gasLimit: 5_000_000 }
  );
  console.log("  Waiting for deployment...");
  await ds.waitForDeployment();
  const dsAddress = await ds.getAddress();
  console.log(`  ✓ DelegatedStaking deployed: ${dsAddress}`);

  // ── 5. Wire contracts ───────────────────────────────────────────

  console.log("\n[5/6] Wiring contracts...");

  // Set HbarPool on DelegatedStaking
  try {
    const tx3 = await ds.setHbarPool(poolAddress, { gasLimit: 200_000 });
    await tx3.wait();
    console.log(`  ✓ DelegatedStaking.setHbarPool(${poolAddress})`);
  } catch (err) {
    console.log(`  ⚠ setHbarPool failed: ${err.message?.slice(0, 100)}`);
  }

  // Update StakingManager to point to new DelegatedStaking
  if (stakingManagerAddress) {
    try {
      const StakingManager = await ethers.getContractFactory("StakingManager", wallet);
      const sm = StakingManager.attach(stakingManagerAddress);
      const tx4 = await sm.setDelegatedStaking(dsAddress, { gasLimit: 200_000 });
      await tx4.wait();
      console.log(`  ✓ StakingManager.setDelegatedStaking(${dsAddress})`);
    } catch (err) {
      console.log(`  ⚠ StakingManager update skipped: ${err.message?.slice(0, 100)}`);
    }
  }

  // ── 6. Update config ───────────────────────────────────────────

  console.log("\n[6/6] Updating config...");
  config.contracts.hbarPool = {
    evmAddress: poolAddress,
    deployedAt: new Date().toISOString(),
    seedHbar: ethers.formatUnits(SEED_HBAR, 8),
    seedGuard: ethers.formatUnits(SEED_GUARD, 8)
  };
  config.contracts.delegatedStaking = {
    evmAddress: dsAddress,
    deployedAt: new Date().toISOString(),
    version: "v3-hbar-wrappers"
  };
  writeConfig(config);
  console.log("  ✓ Updated packages/sdk/config.json");

  // ── Summary ─────────────────────────────────────────────────────

  console.log("\n=== Deployment Complete ===");
  console.log(`HbarPool:          ${poolAddress}`);
  console.log(`DelegatedStaking:  ${dsAddress}`);
  console.log(`Rate:              1 HBAR = 100 GUARD (fixed)`);

  // Verify reserves
  const [hRes, gRes] = await pool.getReserves();
  console.log(`Pool HBAR reserve: ${ethers.formatUnits(hRes, 8)} HBAR`);
  console.log(`Pool GUARD reserve: ${ethers.formatUnits(gRes, 8)} GUARD`);

  console.log("\n=== NEXT STEPS ===");
  console.log("1. Approve HbarPool to spend GUARD on behalf of DelegatedStaking (for guardToHbarFor)");
  console.log("2. Call addAuthorizedDistributor() for PaymentSettlement if needed");
  console.log("3. Users can now delegate with HBAR via delegateWithHbar()");
}

main().catch((error) => {
  console.error("\nDeployment failed:", error.message || error);
  process.exit(1);
});
