const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const Vault1 = await hre.ethers.getContractFactory("VulnerableVault1", deployer);
  const vault1 = await Vault1.deploy();
  await vault1.waitForDeployment();
  console.log(`VulnerableVault1 deployed: ${vault1.target}`);

  const Vault2 = await hre.ethers.getContractFactory("VulnerableVault2", deployer);
  const vault2 = await Vault2.deploy();
  await vault2.waitForDeployment();
  console.log(`VulnerableVault2 deployed: ${vault2.target}`);

  const Vault3 = await hre.ethers.getContractFactory("VulnerableVault3", deployer);
  const vault3 = await Vault3.deploy();
  await vault3.waitForDeployment();
  console.log(`VulnerableVault3 deployed: ${vault3.target}`);

  console.log(
    JSON.stringify(
      {
        testContracts: [
          { key: "vault1", address: vault1.target, deployer: deployer.address },
          { key: "vault2", address: vault2.target, deployer: deployer.address },
          { key: "vault3", address: vault3.target, deployer: deployer.address },
        ],
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Deploy test contracts failed:", err.message || err);
    process.exit(1);
  });

