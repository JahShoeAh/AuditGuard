#!/usr/bin/env node
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

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function normalizePrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['\"]|['\"]$/g, "");
  if (!value) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  }
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function main() {
  console.log("\n=== Wiring Contracts ===\n");

  const config = readConfig();
  const hbarPoolAddress = config.contracts.hbarPool.evmAddress;
  const delegatedStakingAddress = config.contracts.delegatedStaking.evmAddress;
  const stakingManagerAddress = config.contracts.stakingManager.evmAddress;

  console.log(`HbarPool: ${hbarPoolAddress}`);
  console.log(`DelegatedStaking: ${delegatedStakingAddress}`);
  console.log(`StakingManager: ${stakingManagerAddress}`);

  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer: ${wallet.address}\n`);

  // 1. Set HbarPool on DelegatedStaking
  console.log("[1/2] Setting HbarPool on DelegatedStaking...");
  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", wallet);
  const ds = DelegatedStaking.attach(delegatedStakingAddress);

  try {
    const tx1 = await ds.setHbarPool(hbarPoolAddress, { gasLimit: 200_000 });
    await tx1.wait();
    console.log(`  ✓ DelegatedStaking.setHbarPool(${hbarPoolAddress})`);
  } catch (err) {
    console.log(`  ⚠ setHbarPool failed: ${err.message?.slice(0, 100)}`);
  }

  // 2. Set DelegatedStaking on StakingManager
  console.log("\n[2/2] Setting DelegatedStaking on StakingManager...");
  const StakingManager = await ethers.getContractFactory("StakingManager", wallet);
  const sm = StakingManager.attach(stakingManagerAddress);

  try {
    const tx2 = await sm.setDelegatedStaking(delegatedStakingAddress, { gasLimit: 200_000 });
    await tx2.wait();
    console.log(`  ✓ StakingManager.setDelegatedStaking(${delegatedStakingAddress})`);
  } catch (err) {
    console.log(`  ⚠ setDelegatedStaking failed: ${err.message?.slice(0, 100)}`);
  }

  console.log("\n=== Wiring Complete ===");
}

main().catch((error) => {
  console.error("\n❌ Wiring failed:", error.message || error);
  process.exit(1);
});
