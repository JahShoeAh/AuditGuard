#!/usr/bin/env node
const hre = require("hardhat");
const path = require("path");
const fs = require("fs");

const SDK_DIR = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR = path.join(SDK_DIR, "abis");

async function resolveHederaId(evmAddress) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(
        `https://testnet.mirrornode.hedera.com/api/v1/contracts/${evmAddress.toLowerCase()}`
      );
      const data = await res.json();
      if (data.contract_id) return data.contract_id;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "unknown";
}

async function main() {
  await hre.run("compile", { quiet: true });

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Guard token:", config.guardTokenEvmAddress);
  console.log("AgentRegistry:", config.contracts.agentRegistry.evmAddress);
  console.log("Treasury:", config.contracts.treasury.evmAddress);

  const factory = await hre.ethers.getContractFactory("DataMarketplace", deployer);
  console.log("\nDeploying DataMarketplace...");
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    config.contracts.treasury.evmAddress,
    { gasLimit: 3_000_000 }
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log("EVM address:", evmAddress);

  console.log("Resolving Hedera ID (mirror node)...");
  const hederaId = await resolveHederaId(evmAddress);
  console.log("Hedera ID:", hederaId);

  // Update config.json
  const oldAddr = config.contracts.dataMarketplace?.evmAddress ?? "none";
  config.contracts.dataMarketplace = { id: hederaId, evmAddress };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\nconfig.json updated: ${oldAddr} → ${evmAddress}`);

  // Export ABI
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/DataMarketplace.sol/DataMarketplace.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiOut = {
    contractName: artifact.contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  };
  fs.writeFileSync(path.join(ABI_DIR, "DataMarketplace.json"), JSON.stringify(abiOut, null, 2));
  console.log("ABI exported to packages/sdk/abis/DataMarketplace.json");

  console.log("\nDone. Restart agents + orchestrator to pick up new address.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
