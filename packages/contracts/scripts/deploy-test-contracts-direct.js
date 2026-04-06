/**
 * deploy-test-contracts-direct.js
 * Deploys VulnerableVault1/2/3 directly via ethers.js, bypassing Hardhat's
 * eth_estimateGas (which hashio rate-limits, causing INSUFFICIENT_TX_FEE).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });
const { ethers } = require("ethers");
const { PrivateKey } = require("@hashgraph/sdk");
const fs = require("fs");
const path = require("path");

const RPC_URL   = process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api";
const RAW_KEY   = process.env.PERSONAL_PRIV || "";

function normalizeKey(raw) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) throw new Error("PERSONAL_PRIV not set");
  const noPrefix = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(noPrefix)) return `0x${noPrefix}`;
  const parsed = PrivateKey.fromString(value);
  return `0x${parsed.toStringRaw()}`;
}

function loadArtifact(contractName) {
  const artifactPath = path.resolve(
    __dirname,
    `../artifacts/contracts/test/${contractName}.sol/${contractName}.json`
  );
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

// Per-contract gas limits — Hedera testnet needs more than EVM mainnet
const GAS_LIMITS = {
  VulnerableVault1: 800_000,
  VulnerableVault2: 800_000,
  VulnerableVault3: 2_500_000,
};

async function deploy(signer, artifact, gasPrice, contractName) {
  const factory   = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const gasLimit  = GAS_LIMITS[contractName] || 800_000;
  console.log(`  gas limit: ${gasLimit.toLocaleString()}`);
  // Use explicit gas limit + gas price; no estimation call
  const tx = await factory.deploy({
    gasLimit,
    gasPrice,
    type:  0,      // legacy tx — most compatible with Hedera relay
  });
  console.log(`  tx hash: ${tx.deploymentTransaction().hash}`);
  await tx.waitForDeployment();
  return await tx.getAddress();
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pk       = normalizeKey(RAW_KEY);
  const signer   = new ethers.Wallet(pk, provider);

  console.log(`Deployer: ${signer.address}`);

  // Use a gasPrice 10% above network price to ensure acceptance
  const networkGasPrice = (await provider.getFeeData()).gasPrice;
  const gasPrice        = (networkGasPrice * 110n) / 100n;
  console.log(`Gas price: ${gasPrice.toString()} (${ethers.formatUnits(gasPrice, "gwei")} gwei)`);

  // Skip already-deployed vaults; only deploy VulnerableVault3 this run
  const alreadyDeployed = [
    { key: "vulnerablevault1", address: "0x0c5a2d6380F8f5E53A5b1C99c0FEE51d46834162", deployer: signer.address },
    { key: "vulnerablevault2", address: "0x57b2bc29B5dce8257F9536D7DcC46f41d495690E", deployer: signer.address },
  ];
  console.log("\nSkipping VulnerableVault1 (already deployed):", alreadyDeployed[0].address);
  console.log("Skipping VulnerableVault2 (already deployed):", alreadyDeployed[1].address);

  const names = ["VulnerableVault3"];
  const deployed = [...alreadyDeployed];

  for (const name of names) {
    console.log(`\nDeploying ${name}...`);
    const artifact = loadArtifact(name);
    const address  = await deploy(signer, artifact, gasPrice, name);
    console.log(`  ${name} deployed: ${address}`);
    deployed.push({ key: name.toLowerCase(), address, deployer: signer.address });
  }

  console.log("\n" + JSON.stringify({ testContracts: deployed }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error("Deploy failed:", err.message || err); process.exit(1); });
