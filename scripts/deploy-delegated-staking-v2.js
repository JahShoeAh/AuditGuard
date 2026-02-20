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

const CONFIG_PATH = path.join(__dirname, "..", "packages", "sdk", "config.json");

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function normalizePrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['\"]|['\"]$/g, "");
  if (!value) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  }
  if (value.startsWith("0x")) {
    return value;
  }
  return `0x${value}`;
}

async function main() {
  console.log("\n=== DelegatedStaking V2 Deployment (No Delegation Gating) ===");

  const config = readConfig();
  const guardTokenAddress = config.guardTokenEvmAddress;
  const treasuryAddress = config.contracts.treasury.evmAddress;

  if (!guardTokenAddress || !treasuryAddress) {
    throw new Error("Missing GUARD token or treasury address in config");
  }

  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`GUARD Token: ${guardTokenAddress}`);
  console.log(`Treasury: ${treasuryAddress}`);

  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", wallet);
  const ds = await DelegatedStaking.deploy(guardTokenAddress, treasuryAddress);
  await ds.waitForDeployment();
  const dsAddress = await ds.getAddress();

  console.log(`DelegatedStaking V2 deployed: ${dsAddress}`);

  // Associate with GUARD token (optional - may already be associated)
  try {
    console.log("Associating contract with GUARD token via HTS...");
    const associateTx = await ds.associateGuardToken();
    await associateTx.wait();
    console.log("✓ GUARD token association complete");
  } catch (err) {
    console.log("⚠ Token association failed (may already be associated):", err.message?.slice(0, 100));
    console.log("Continuing deployment...");
  }

  // Update config
  config.contracts.delegatedStaking = {
    id: `0.0.${dsAddress.toLowerCase().replace(/^0x/, "")}`,
    evmAddress: dsAddress,
    deployedAt: new Date().toISOString(),
    version: "v2-no-gating"
  };
  writeConfig(config);
  console.log("Updated packages/sdk/config.json");

  console.log("\n=== NEXT STEPS ===");
  console.log("1. Update StakingManager.setDelegatedStaking() with new address:");
  console.log(`   ${dsAddress}`);
  console.log("2. Update AgentRegistry.setDelegatedStaking() with new address:");
  console.log(`   ${dsAddress}`);
  console.log("3. Call addAuthorizedDistributor() for PaymentSettlement if needed");
  console.log("4. Existing delegations on old contract will NOT migrate automatically");
  console.log("   (Users will need to redelegate - acceptable for testnet demo)");
}

main().catch((error) => {
  console.error("\nDeployment failed:", error.message || error);
  process.exit(1);
});
