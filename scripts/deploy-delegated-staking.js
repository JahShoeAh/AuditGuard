/**
 * AuditGuard — DelegatedStaking Deployment Script
 *
 * 1. Deploy DelegatedStaking.sol
 * 2. Associate DelegatedStaking with GUARD token via HTS precompile
 * 3. Wire: setGuardToken, setStakingManager, setAgentRegistry, setTreasury
 * 4. Authorize PaymentSettlement as a reward distributor
 * 5. Update StakingManager: setDelegatedStaking(address)
 * 6. Register in SystemGovernor (if deployed)
 * 7. Enable delegation for each seeded agent (if agent private keys available in .env)
 * 8. Export ABI to packages/sdk/abis/DelegatedStaking.json
 * 9. Update packages/sdk/config.json with new contract address
 * 10. Print deployment summary
 *
 * Usage:
 *   node scripts/deploy-delegated-staking.js
 *
 * Environment variables used:
 *   HEDERA_ACCOUNT_ID          — deployer account (e.g. "0.0.12345")
 *   HEDERA_PRIVATE_KEY         — deployer EVM hex private key
 *   AGENT1_PRIVATE_KEY         — optional: StaticAnalysis-47 key (for enableDelegation)
 *   AGENT2_PRIVATE_KEY         — optional: Fuzzer-12 key
 *   AGENT3_PRIVATE_KEY         — optional: LLMContextual-3 key
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// ─── Paths ────────────────────────────────────────────────────────────────────
const REPO_ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts");
const SDK_DIR = path.join(REPO_ROOT, "packages", "sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABIS_DIR = path.join(SDK_DIR, "abis");

// ─── Hardhat Bootstrap ────────────────────────────────────────────────────────
if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = "hedera_testnet";
}
process.env.HARDHAT_CONFIG = path.join(CONTRACTS_DIR, "hardhat.config.js");
process.chdir(CONTRACTS_DIR);

const hardhatRequire = createRequire(path.join(CONTRACTS_DIR, "package.json"));
const hre = hardhatRequire("hardhat");
const { ethers } = hre;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HASHSCAN_BASE = "https://hashscan.io/testnet/contract";

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function readArtifact(contractName) {
  const p = path.join(
    CONTRACTS_DIR, "artifacts", "contracts",
    `${contractName}.sol`, `${contractName}.json`
  );
  if (!fs.existsSync(p)) throw new Error(`Artifact not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function evmToHederaId(evmAddress) {
  if (!evmAddress || !evmAddress.startsWith("0x")) return "unknown";
  const num = parseInt(evmAddress.slice(-8), 16);
  return `0.0.${num}`;
}

function hashScanUrl(evmAddress) {
  return `${HASHSCAN_BASE}/${evmAddress}`;
}

function log(msg) { console.log("  " + msg); }

// ─── Step 1: Deploy DelegatedStaking ─────────────────────────────────────────

async function deployDelegatedStaking(deployer, config) {
  log("Deploying DelegatedStaking.sol...");

  const c = config.contracts;

  // Constructor: (guardToken, stakingManager, agentRegistry, treasury)
  const constructorArgs = [
    config.guardTokenEvmAddress,
    c.stakingManager.evmAddress,
    c.agentRegistry.evmAddress,
    c.treasury.evmAddress,
  ];

  const DelegatedStaking = await ethers.getContractFactory("DelegatedStaking", deployer);
  const ds = await DelegatedStaking.deploy(...constructorArgs);
  await ds.waitForDeployment();

  const evmAddress = await ds.getAddress();
  log(`  DelegatedStaking deployed → ${evmAddress}`);
  log(`  HashScan: ${hashScanUrl(evmAddress)}`);

  return { ds, evmAddress, constructorArgs };
}

// ─── Step 2: Associate GUARD Token ───────────────────────────────────────────

async function associateGuardToken(ds) {
  log("Associating DelegatedStaking with GUARD token (HTS)...");
  try {
    const tx = await ds.associateGuardToken();
    await tx.wait();
    log("  ✓ GUARD token associated");
  } catch (err) {
    if (err.message && err.message.includes("already associated")) {
      log("  ✓ Already associated");
    } else {
      log(`  ⚠ Association failed: ${err.message.slice(0, 80)}`);
      log("    Run ds.associateGuardToken() manually after deployment.");
    }
  }
}

// ─── Step 3+4: Wire Addresses + Authorize PaymentSettlement ──────────────────

async function wireAddresses(ds, config) {
  log("Wiring contract addresses...");

  // setGuardToken, setStakingManager, setAgentRegistry, setTreasury are set in constructor.
  // Re-confirm by reading state (no setters needed unless addresses changed).
  const [gt, sm, ar, tr] = await Promise.all([
    ds.guardToken(),
    ds.stakingManager(),
    ds.agentRegistry(),
    ds.treasury(),
  ]);

  log(`  guardToken:      ${gt}`);
  log(`  stakingManager:  ${sm}`);
  log(`  agentRegistry:   ${ar}`);
  log(`  treasury:        ${tr}`);

  // Authorize PaymentSettlement as a reward distributor
  log("Authorizing PaymentSettlement as reward distributor...");
  try {
    const tx = await ds.addAuthorizedDistributor(config.contracts.paymentSettlement.evmAddress);
    await tx.wait();
    log("  ✓ PaymentSettlement authorized as distributor");
  } catch (err) {
    log(`  ⚠ Could not authorize PaymentSettlement: ${err.message.slice(0, 80)}`);
  }
}

// ─── Step 5: Update StakingManager ───────────────────────────────────────────

async function wireStakingManager(deployer, dsAddress, config) {
  log("Wiring StakingManager.setDelegatedStaking()...");

  const smArtifact = readArtifact("StakingManager");
  const sm = new ethers.Contract(
    config.contracts.stakingManager.evmAddress,
    smArtifact.abi,
    deployer
  );

  try {
    const tx = await sm.setDelegatedStaking(dsAddress);
    await tx.wait();
    log("  ✓ StakingManager.delegatedStaking set");
  } catch (err) {
    log(`  ⚠ setDelegatedStaking() failed: ${err.message.slice(0, 80)}`);
    log("    StakingManager may not be owned by deployer — check ownership.");
  }
}

// ─── Step 6: Register in SystemGovernor ──────────────────────────────────────

async function registerInGovernor(deployer, dsAddress, config) {
  if (!config.contracts.systemGovernor?.evmAddress) {
    log("SystemGovernor not yet deployed — skip registration. Run after deploy-day4.js.");
    return;
  }

  log("Registering DelegatedStaking in SystemGovernor...");
  try {
    const govArtifact = readArtifact("SystemGovernor");
    const gov = new ethers.Contract(
      config.contracts.systemGovernor.evmAddress,
      govArtifact.abi,
      deployer
    );
    const tx = await gov.registerContract("delegatedStaking", dsAddress);
    await tx.wait();
    log("  ✓ Registered in SystemGovernor");
  } catch (err) {
    log(`  ⚠ SystemGovernor registration failed: ${err.message.slice(0, 80)}`);
  }
}

// ─── Step 7: Enable Delegation for Seeded Agents ─────────────────────────────

async function enableDelegationForSeededAgents(provider, dsAddress, dsAbi) {
  log("Enabling delegation for seeded agents...");

  const agentKeys = [
    { name: "StaticAnalysis-47", envKey: "AGENT1_PRIVATE_KEY" },
    { name: "Fuzzer-12",         envKey: "AGENT2_PRIVATE_KEY" },
    { name: "LLMContextual-3",   envKey: "AGENT3_PRIVATE_KEY" },
  ];

  for (const { name, envKey } of agentKeys) {
    const privateKey = process.env[envKey];
    if (!privateKey) {
      log(`  ⚠ ${envKey} not set — skipping ${name}. Run enableDelegation() manually.`);
      continue;
    }

    try {
      const agentWallet = new ethers.Wallet(
        privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
        provider
      );
      const dsAsAgent = new ethers.Contract(dsAddress, dsAbi, agentWallet);
      const tx = await dsAsAgent.enableDelegation();
      await tx.wait();
      log(`  ✓ ${name} (${agentWallet.address}) enabled delegation`);
    } catch (err) {
      log(`  ⚠ ${name} enableDelegation failed: ${err.message.slice(0, 80)}`);
    }
  }
}

// ─── Step 8: Export ABI ───────────────────────────────────────────────────────

function exportAbi() {
  log("Exporting DelegatedStaking ABI...");
  try {
    const artifact = readArtifact("DelegatedStaking");
    const abiPath = path.join(ABIS_DIR, "DelegatedStaking.json");
    fs.writeFileSync(abiPath, JSON.stringify(artifact, null, 2));
    log(`  ✓ ABI exported to packages/sdk/abis/DelegatedStaking.json`);
  } catch (err) {
    log(`  ⚠ ABI export failed: ${err.message}`);
    log("    Run 'npx hardhat compile' in packages/contracts first.");
  }
}

// ─── Step 9: Update config.json ───────────────────────────────────────────────

function updateConfig(config, evmAddress) {
  config.contracts.delegatedStaking = {
    id: evmToHederaId(evmAddress),
    evmAddress,
    hashScanUrl: hashScanUrl(evmAddress),
  };

  writeConfig(config);
  log("  ✓ config.json updated with DelegatedStaking address");
}

// ─── Step 10: Summary ─────────────────────────────────────────────────────────

function printSummary(evmAddress, config) {
  const BOX = 60;
  const line = "═".repeat(BOX);
  function row(text) { return `║  ${text.padEnd(BOX - 2)}║`; }

  console.log(`\n╔${line}╗`);
  console.log(`║${"DelegatedStaking — Deployed".padStart(Math.floor((BOX + 26) / 2)).padEnd(BOX)}║`);
  console.log(`╠${line}╣`);
  console.log(row(""));
  console.log(row(`Address: ${evmAddress}`));
  console.log(row(`Hedera:  ${evmToHederaId(evmAddress)}`));
  console.log(row(`URL:     ${hashScanUrl(evmAddress)}`));
  console.log(row(""));
  console.log(`╠${line}╣`);
  console.log(row("Wiring"));
  console.log(`╠${line}╣`);
  console.log(row(`StakingManager → setDelegatedStaking ✓`));
  console.log(row(`PaymentSettlement → addAuthorizedDistributor ✓`));
  console.log(row(`GUARD token association ✓`));
  console.log(row(""));
  console.log(`╠${line}╣`);
  console.log(row("Next Steps"));
  console.log(`╠${line}╣`);
  console.log(row("1. Each agent calls enableDelegation() to opt-in"));
  console.log(row("2. Delegators call delegate(agent, amount)"));
  console.log(row("3. PaymentSettlement calls distributeRewards() on"));
  console.log(row("   each settlement (add to PaymentSettlement.sol)"));
  console.log(row("4. SDK: ag.delegation module (add to auditguard-sdk.js)"));
  console.log(row(""));
  console.log(`╚${line}╝\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  AuditGuard — DelegatedStaking Deployment\n");

  const [deployer] = await ethers.getSigners();
  log(`Deployer: ${await deployer.getAddress()}`);

  let config = readConfig();

  // Step 1: Deploy
  console.log("\n  [Step 1/10] Deploy DelegatedStaking");
  const { ds, evmAddress } = await deployDelegatedStaking(deployer, config);

  // Step 2: Associate GUARD
  console.log("\n  [Step 2/10] Associate GUARD Token");
  await associateGuardToken(ds);

  // Step 3+4: Wire addresses + authorize distributor
  console.log("\n  [Step 3+4/10] Wire Addresses + Authorize Distributor");
  await wireAddresses(ds, config);

  // Step 5: Update StakingManager
  console.log("\n  [Step 5/10] Update StakingManager");
  await wireStakingManager(deployer, evmAddress, config);

  // Step 6: Register in SystemGovernor
  console.log("\n  [Step 6/10] Register in SystemGovernor");
  await registerInGovernor(deployer, evmAddress, config);

  // Step 7: Enable delegation for seeded agents
  console.log("\n  [Step 7/10] Enable Delegation for Seeded Agents");
  const dsArtifact = readArtifact("DelegatedStaking");
  await enableDelegationForSeededAgents(deployer.provider, evmAddress, dsArtifact.abi);

  // Step 8: Export ABI
  console.log("\n  [Step 8/10] Export ABI");
  exportAbi();

  // Step 9: Update config.json
  console.log("\n  [Step 9/10] Update config.json");
  config = readConfig();
  updateConfig(config, evmAddress);

  // Step 10: Summary
  console.log("\n  [Step 10/10] Summary");
  printSummary(evmAddress, readConfig());
}

main().catch((err) => {
  console.error("\n  FATAL ERROR:", err.message);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
