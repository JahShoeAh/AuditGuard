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
const EXCHANGE_ARTIFACT = require("../packages/contracts/artifacts/contracts/GuardExchange.sol/GuardExchange.json");

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
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) {
    throw new Error("Missing OPERATOR_PRIVATE_KEY in environment");
  }

  if (value.startsWith("0x")) {
    return value;
  }
  return `0x${value}`;
}

async function main() {
  console.log("\n=== GuardExchange Deployment (Hedera Testnet) ===");

  // Step 1: Load env/config
  const config = readConfig();
  if (!config.guardTokenEvmAddress) {
    throw new Error("config.guardTokenEvmAddress is missing in packages/sdk/config.json");
  }

  // Step 2: Build provider + wallet
  const provider = new ethers.JsonRpcProvider(
    "https://testnet.hashio.io/api",
    { name: "hedera_testnet", chainId: 296 },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  const wallet = new ethers.Wallet(normalizePrivateKey(process.env.OPERATOR_PRIVATE_KEY), provider);
  console.log(`Deployer wallet: ${wallet.address}`);
  console.log(`GUARD token: ${config.guardTokenEvmAddress}`);

  // Step 3: Deploy GuardExchange
  const factory = new ethers.ContractFactory(EXCHANGE_ARTIFACT.abi, EXCHANGE_ARTIFACT.bytecode, wallet);
  const exchange = await factory.deploy(config.guardTokenEvmAddress);
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  console.log(`GuardExchange deployed: ${exchangeAddress}`);

  // Step 4: Approve GUARD allowance for seeding
  const guardToken = new ethers.Contract(
    config.guardTokenEvmAddress,
    ["function approve(address spender, uint256 amount) returns (bool)"],
    wallet
  );
  const approvalAmount = ethers.parseUnits("1000000", 8);
  const approveTx = await guardToken.approve(exchangeAddress, approvalAmount);
  await approveTx.wait();
  console.log(`Approved GUARD allowance: ${approvalAmount.toString()}`);

  // Step 5: Seed liquidity pool
  const hbarSeedInput = process.env.EXCHANGE_HBAR_SEED || "10";
  const guardSeedInput = process.env.EXCHANGE_GUARD_SEED || "1000";
  const hbarSeedAmount = ethers.parseEther(hbarSeedInput);
  const guardSeedAmount = ethers.parseUnits(guardSeedInput, 8);

  const seedTx = await exchange.addLiquidity(guardSeedAmount, { value: hbarSeedAmount });
  await seedTx.wait();
  console.log(`Seeded liquidity: ${hbarSeedInput} HBAR + ${guardSeedInput} GUARD`);

  const impliedGuardPerHbar = Number(guardSeedInput) / Number(hbarSeedInput);
  if (Number.isFinite(impliedGuardPerHbar)) {
    console.log(`Implied seed rate: ${impliedGuardPerHbar} GUARD/HBAR`);
  }

  // Step 6: Update SDK config
  config.contracts = config.contracts || {};
  config.contracts.guardExchange = {
    evmAddress: exchangeAddress,
    deployedAt: new Date().toISOString(),
    seedHbar: hbarSeedInput,
    seedGuard: guardSeedInput
  };
  writeConfig(config);
  console.log("Updated packages/sdk/config.json with contracts.guardExchange");

  // Step 7: Verify reserves/rate
  const [hbar, guard] = await exchange.getReserves();
  const rate = await exchange.getRate();
  console.log(`Reserves -> HBAR: ${hbar.toString()} | GUARD: ${guard.toString()}`);
  console.log(`Rate (tinybars per 1 GUARD): ${rate.toString()}`);
}

main().catch((error) => {
  console.error("\nDeployment failed:", error.message || error);
  process.exit(1);
});
