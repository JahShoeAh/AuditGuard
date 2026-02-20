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
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function main() {
  console.log("\n=== Test DelegatedStaking Deployment ===\n");

  const config = readConfig();
  const guardTokenAddress = config.guardTokenEvmAddress;
  const treasuryAddress = config.contracts.treasury.evmAddress;

  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);

  console.log(`Deployer: ${wallet.address}`);
  console.log(`GUARD Token: ${guardTokenAddress}`);
  console.log(`Treasury: ${treasuryAddress}`);

  console.log("\nDeploying DelegatedStaking with 5M gas...");
  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", wallet);

  try {
    const ds = await DelegatedStaking.deploy(
      guardTokenAddress,
      treasuryAddress,
      { gasLimit: 5_000_000 }
    );
    console.log("Waiting for deployment...");
    await ds.waitForDeployment();
    const dsAddress = await ds.getAddress();
    console.log(`✓ DelegatedStaking deployed: ${dsAddress}`);
  } catch (error) {
    console.error("Deployment failed:");
    console.error("Error message:", error.message);
    if (error.transaction) {
      console.error("Transaction:", error.transaction);
    }
    if (error.receipt) {
      console.error("Receipt status:", error.receipt.status);
      console.error("Gas used:", error.receipt.gasUsed?.toString());
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("\n❌ Test failed:", error.message || error);
  process.exit(1);
});
