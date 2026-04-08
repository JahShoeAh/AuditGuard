/**
 * deploy-test-contracts.js
 * Deploys InsecureToken, VulnerableGovernance, InsecureMarketplace via Hardhat.
 * Use this for local Hardhat network. For Hedera testnet use deploy-test-contracts-direct.js.
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const Token = await hre.ethers.getContractFactory("InsecureToken", deployer);
  const token = await Token.deploy(hre.ethers.parseEther("1000000"));
  await token.waitForDeployment();
  console.log(`InsecureToken deployed: ${token.target}`);

  const Governance = await hre.ethers.getContractFactory("VulnerableGovernance", deployer);
  const governance = await Governance.deploy({ value: hre.ethers.parseEther("0.01") });
  await governance.waitForDeployment();
  console.log(`VulnerableGovernance deployed: ${governance.target}`);

  const Marketplace = await hre.ethers.getContractFactory("InsecureMarketplace", deployer);
  const marketplace = await Marketplace.deploy();
  await marketplace.waitForDeployment();
  console.log(`InsecureMarketplace deployed: ${marketplace.target}`);

  console.log(
    JSON.stringify(
      {
        testContracts: [
          { key: "insecuretoken",        address: token.target,       deployer: deployer.address },
          { key: "vulnerablegovernance", address: governance.target,  deployer: deployer.address },
          { key: "insecuremarketplace",  address: marketplace.target, deployer: deployer.address },
        ],
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Deploy test contracts failed:", err.message || err);
    process.exit(1);
  });
