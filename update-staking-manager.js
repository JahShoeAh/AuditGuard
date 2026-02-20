#!/usr/bin/env node
/**
 * Update StakingManager with new DelegatedStaking address
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const REPO_ROOT = __dirname;
const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts");

if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = "hedera_testnet";
}
process.env.HARDHAT_CONFIG = path.join(CONTRACTS_DIR, "hardhat.config.js");
process.chdir(CONTRACTS_DIR);

const hardhatRequire = createRequire(path.join(CONTRACTS_DIR, "package.json"));
const { ethers } = hardhatRequire("hardhat");

const CONFIG_PATH = path.join(__dirname, "packages", "sdk", "config.json");

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function normalizePrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['\"]|['\"]$/g, "");
  if (!value) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  }
  if (value.startsWith("0x")) {
    return value;
  }
  return `0x${value}`;
}

async function main() {
  console.log("\n=== Updating StakingManager with new DelegatedStaking address ===");

  const config = readConfig();
  const stakingManagerAddress = config.contracts.stakingManager.evmAddress;
  const delegatedStakingAddress = config.contracts.delegatedStaking.evmAddress;

  if (!stakingManagerAddress || !delegatedStakingAddress) {
    throw new Error("Missing StakingManager or DelegatedStaking address in config");
  }

  console.log(`StakingManager: ${stakingManagerAddress}`);
  console.log(`New DelegatedStaking: ${delegatedStakingAddress}`);

  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer: ${wallet.address}`);

  const StakingManager = await ethers.getContractFactory("StakingManager", wallet);
  const sm = StakingManager.attach(stakingManagerAddress);

  console.log("\nUpdating DelegatedStaking address...");
  try {
    const tx = await sm.setDelegatedStaking(delegatedStakingAddress, { gasLimit: 200000 });
    await tx.wait();
    console.log("✅ StakingManager updated successfully!");
  } catch (err) {
    console.log("⚠ StakingManager update failed (may not have this function):", err.message?.slice(0, 100));
  }
}

main().catch((error) => {
  console.error("\nUpdate failed:", error.message || error);
  process.exit(1);
});
