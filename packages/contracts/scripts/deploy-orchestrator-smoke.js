const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const factory = await hre.ethers.getContractFactory("MockGuardToken", deployer);
  const contract = await factory.deploy("SmokeGuard", "SGUARD", 1_000_000_000_000n);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`Smoke contract deployed: ${address}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Smoke deploy failed:", err.message || err);
    process.exit(1);
  });
