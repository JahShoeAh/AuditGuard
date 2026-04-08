/**
 * deploy-test-contracts-direct.js
 * Deploys InsecureToken, VulnerableGovernance, and InsecureMarketplace directly
 * via ethers.js, bypassing Hardhat's eth_estimateGas (which hashio rate-limits,
 * causing INSUFFICIENT_TX_FEE).
 *
 * Usage:
 *   PERSONAL_PRIV=<hex-or-DER-key> node packages/contracts/scripts/deploy-test-contracts-direct.js
 *
 * PERSONAL_PRIV can be a raw 64-char hex key or a Hedera DER-encoded ECDSA key.
 * Falls back to HEDERA_PRIVATE_KEY from .env if PERSONAL_PRIV is not set.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });
const { ethers } = require("ethers");
const { PrivateKey } = require("@hashgraph/sdk");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api";
const RAW_KEY = process.env.PERSONAL_PRIV || process.env.HEDERA_PRIVATE_KEY || "";

function normalizeKey(raw) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) throw new Error("No private key found. Set PERSONAL_PRIV or HEDERA_PRIVATE_KEY in .env");
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
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found for ${contractName}. Run: npm run compile`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

// Per-contract gas limits tuned for Hedera testnet relay
const GAS_LIMITS = {
  InsecureToken:        2_000_000,
  VulnerableGovernance: 2_000_000,
  InsecureMarketplace:  2_000_000,
};

// Constructor args per contract
const CONSTRUCTOR_ARGS = {
  InsecureToken:        [ethers.parseEther("1000000")], // 1M initial supply
  VulnerableGovernance: [],                              // payable, no args
  InsecureMarketplace:  [],
};

// Value (ETH) to send with constructor call
const CONSTRUCTOR_VALUE = {
  InsecureToken:        0n,
  VulnerableGovernance: ethers.parseEther("0.01"), // seed the reward pool
  InsecureMarketplace:  0n,
};

async function deploy(signer, artifact, gasPrice, contractName) {
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const gasLimit = GAS_LIMITS[contractName] || 800_000;
  const args     = CONSTRUCTOR_ARGS[contractName] || [];
  const value    = CONSTRUCTOR_VALUE[contractName] || 0n;

  console.log(`  gas limit : ${gasLimit.toLocaleString()}`);
  if (value > 0n) console.log(`  value     : ${ethers.formatEther(value)} ETH`);

  const tx = await factory.deploy(...args, { gasLimit, gasPrice, type: 0, value });
  console.log(`  tx hash   : ${tx.deploymentTransaction().hash}`);
  await tx.waitForDeployment();
  const address = await tx.getAddress();
  console.log(`  deployed  : ${address}`);
  return address;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pk       = normalizeKey(RAW_KEY);
  const signer   = new ethers.Wallet(pk, provider);

  console.log(`Deployer : ${signer.address}`);
  console.log(`RPC      : ${RPC_URL}\n`);

  const feeData  = await provider.getFeeData();
  const gasPrice = (feeData.gasPrice * 110n) / 100n;  // 10% above network price
  console.log(`Gas price: ${gasPrice.toString()} (${ethers.formatUnits(gasPrice, "gwei")} gwei)\n`);

  const contracts = ["InsecureToken", "VulnerableGovernance", "InsecureMarketplace"];
  const deployed  = [];

  for (const name of contracts) {
    console.log(`Deploying ${name}...`);
    const artifact = loadArtifact(name);
    const address  = await deploy(signer, artifact, gasPrice, name);
    deployed.push({ key: name.toLowerCase(), address, deployer: signer.address });
    console.log();
  }

  console.log("All contracts deployed:");
  console.log(JSON.stringify({ testContracts: deployed }, null, 2));
  console.log("\nAdd these to MEMORY.md under 'Test Contracts (Deployed on Hedera Testnet)'");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Deploy failed:", err.message || err);
    process.exit(1);
  });
