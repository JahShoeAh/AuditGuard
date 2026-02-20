#!/usr/bin/env node
const hre = require("hardhat");
const config = require("../../sdk/config.json");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Checking with account:", deployer.address);

  const dsAddress = config.contracts.delegatedStaking.evmAddress;
  const guardAddress = config.guardTokenEvmAddress;

  console.log("DelegatedStaking:", dsAddress);
  console.log("GUARD Token:", guardAddress);

  const DelegatedStaking = await hre.ethers.getContractFactory("DelegatedStaking");
  const ds = DelegatedStaking.attach(dsAddress);

  try {
    const owner = await ds.owner();
    console.log("\n✓ Contract Owner:", owner);
    console.log("  Your address:", deployer.address);
    console.log("  You are owner:", owner.toLowerCase() === deployer.address.toLowerCase());
  } catch (e) {
    console.log("✗ Error getting owner:", e.message);
  }

  try {
    const guardToken = await ds.guardToken();
    console.log("\n✓ GUARD Token configured:", guardToken);
  } catch (e) {
    console.log("✗ Error getting guardToken:", e.message);
  }

  // Try a test delegation to see the actual error
  console.log("\n📋 Testing delegation with 10 GUARD...");
  const testAmount = hre.ethers.parseUnits("10", 8);
  const testAgent = "0x8FA8aa2b692a2f1F9402cCadF2bd5DA6C772a905"; // from the error message

  try {
    await ds.delegate.staticCall(testAgent, testAmount);
    console.log("✓ Delegation would succeed!");
  } catch (e) {
    console.log("✗ Delegation error:", e.message);
    if (e.message.includes("HTS transfer failed")) {
      console.log("\n🔍 This confirms the HTS transfer issue.");
      console.log("The contract needs to be associated with the GUARD token.");
    }
  }
}

main().then(() => process.exit(0)).catch(console.error);
