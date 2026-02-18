/**
 * deploy-timelock.js
 *
 * Deploys TimeLockVault to Hedera testnet and writes the result into
 * packages/sdk/config.json under the `timelockVault` key.
 * Also exports the ABI to packages/sdk/abis/TimeLockVault.json.
 *
 * Usage:
 *   node scripts/deploy-timelock.js
 *   npm run deploy:timelock
 */

const fs   = require("fs");
const path = require("path");
const { createRequire } = require("module");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { ContractId } = require("@hashgraph/sdk");

const REPO_ROOT      = path.join(__dirname, "..");
const CONTRACTS_DIR  = path.join(REPO_ROOT, "packages", "contracts");
const SDK_DIR        = path.join(REPO_ROOT, "packages", "sdk");
const CONFIG_PATH    = path.join(SDK_DIR, "config.json");
const ABIS_DIR       = path.join(SDK_DIR, "abis");

// ── Hardhat must run from the contracts dir ─────────────────────────────────
if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = "hedera_testnet";
}
process.env.HARDHAT_CONFIG = path.join(CONTRACTS_DIR, "hardhat.config.js");
process.chdir(CONTRACTS_DIR);

const hardhatRequire = createRequire(path.join(CONTRACTS_DIR, "package.json"));
const hre = hardhatRequire("hardhat");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(p, fallback = {}) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function evmAddressToContractId(evmAddress) {
  return ContractId.fromSolidityAddress(evmAddress).toString();
}

function readArtifact(contractName) {
  const artifactPath = path.join(
    CONTRACTS_DIR, "artifacts", "contracts",
    `${contractName}.sol`, `${contractName}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}`);
  }
  return readJson(artifactPath);
}

function exportAbi(contractName) {
  fs.mkdirSync(ABIS_DIR, { recursive: true });
  const artifact = readArtifact(contractName);
  const outPath  = path.join(ABIS_DIR, `${contractName}.json`);
  writeJson(outPath, { contractName, abi: artifact.abi });
  console.log(`   ✅ ABI exported → ${path.relative(REPO_ROOT, outPath)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   TimeLockVault Deployment — Hedera Testnet  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Step 1: compile
  console.log("=== Step 1: Compile contracts ===");
  await hre.run("compile");
  exportAbi("TimeLockVault");
  console.log("✅ Step 1: Compile contracts\n");

  // Step 2: deploy
  console.log("=== Step 2: Deploy TimeLockVault ===");
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log(`   Deployer: ${deployerAddress}`);

  const factory  = await hre.ethers.getContractFactory("TimeLockVault");
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const evmAddress = await contract.getAddress();
  const contractId = evmAddressToContractId(evmAddress);

  console.log(`   EVM Address:  ${evmAddress}`);
  console.log(`   Contract ID:  ${contractId}`);
  console.log("✅ Step 2: Deploy TimeLockVault\n");

  // Step 3: write config.json
  console.log("=== Step 3: Update packages/sdk/config.json ===");
  const config = readJson(CONFIG_PATH, {});
  config.timelockVault = {
    evmAddress,
    contractId,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    description: "HBAR time-lock vault — AuditGuard pipeline demo target",
  };
  writeJson(CONFIG_PATH, config);
  console.log(`   config.json updated → timelockVault.evmAddress = ${evmAddress}`);
  console.log("✅ Step 3: Update packages/sdk/config.json\n");

  // Summary
  console.log("┌──────────────────────────────────────────────────────────┐");
  console.log(`│  TimeLockVault deployed                                   │`);
  console.log(`│  EVM Address : ${evmAddress.padEnd(42)} │`);
  console.log(`│  Contract ID : ${contractId.padEnd(42)} │`);
  console.log("└──────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Run the pipeline test:");
  console.log("       npm --prefix agents test -- tests/timelock-pipeline.test.ts");
  console.log("  2. Verify on HashScan:");
  console.log(`       https://hashscan.io/testnet/contract/${contractId}`);
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message || err);
  process.exit(1);
});
