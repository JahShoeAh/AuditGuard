#!/usr/bin/env node
/**
 * Associate GUARD token with DelegatedStaking contract
 * Run this if you get "HTS transfer failed" errors during delegation
 */

const hre = require("hardhat");
const config = require("../../sdk/config.json");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Using account:", deployer.address);

  const delegatedStakingAddress = config.contracts.delegatedStaking.evmAddress;
  if (!delegatedStakingAddress) {
    throw new Error("DelegatedStaking address not found in config");
  }

  console.log("DelegatedStaking address:", delegatedStakingAddress);

  // Get the contract instance
  const DelegatedStaking = await hre.ethers.getContractFactory("DelegatedStaking");
  const ds = DelegatedStaking.attach(delegatedStakingAddress);

  console.log("\n🔗 Associating GUARD token with DelegatedStaking contract...");

  try {
    const tx = await ds.associateGuardToken({ gasLimit: 800000 });
    console.log("Transaction sent:", tx.hash);

    const receipt = await tx.wait();
    console.log("✅ Association successful!");
    console.log("Block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());
  } catch (error) {
    if (error.message.includes("TOKEN_ALREADY_ASSOCIATED")) {
      console.log("✅ Token is already associated!");
    } else {
      console.error("❌ Association failed:", error.message);
      throw error;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
