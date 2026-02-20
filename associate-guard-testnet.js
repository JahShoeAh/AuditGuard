#!/usr/bin/env node
/**
 * Associate GUARD token with DelegatedStaking contract on Hedera TESTNET
 * This connects directly to testnet (not local hardhat node)
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
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function normalizePrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['\"]|['\"]$/g, "");
  if (!value) throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function main() {
  console.log("\n=== Associate GUARD Token on Hedera Testnet ===");

  const config = readConfig();
  const delegatedStakingAddress = config.contracts.delegatedStaking.evmAddress;

  console.log(`DelegatedStaking: ${delegatedStakingAddress}`);
  console.log(`GUARD Token: ${config.guardTokenEvmAddress}`);

  // Connect directly to Hedera testnet
  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer (owner): ${wallet.address}`);

  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", wallet);
  const ds = DelegatedStaking.attach(delegatedStakingAddress);

  console.log("\nCalling associateGuardToken()...");
  try {
    const tx = await ds.associateGuardToken({ gasLimit: 1_000_000 });
    console.log("Transaction sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("✅ Association successful on TESTNET!");
    console.log("Block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());
  } catch (error) {
    if (error.message.includes("ALREADY_ASSOCIATED") || error.message.includes("194")) {
      console.log("✅ Token is already associated on testnet!");
    } else {
      console.error("❌ Association failed:", error.message);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error("\nFailed:", error.message || error);
  process.exit(1);
});
