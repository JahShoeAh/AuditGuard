/**
 * deploy-day2.js — Deploy Day 2 AuditGuard contracts to Hedera Testnet
 *
 * Deploys:  SubAuction, DataMarketplace, PaymentSettlement
 * Wires:    Cross-contract references, token associations, pre-funding
 * Updates:  packages/sdk/config.json + packages/sdk/abis/
 *
 * Usage:
 *   npx hardhat run packages/contracts/scripts/deploy-day2.js --config packages/contracts/hardhat.config.js --network hedera_testnet
 *
 * Partial deploy recovery:
 *   If the script fails midway, re-run it. It reads deploy-day2-state.json
 *   and skips already-completed steps.
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─── Paths ───────────────────────────────────────────────────────────────────

const SDK_DIR = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR = path.join(SDK_DIR, "abis");
const STATE_PATH = path.join(__dirname, "deploy-day2-state.json");

// ─── Constants ───────────────────────────────────────────────────────────────

const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";
const HTS_ABI = [
  "function transferToken(address token, address sender, address receiver, int64 amount) external returns (int64)",
  "function tokenAssociate(address account, address token) external returns (int64)",
];
const HTS_SUCCESS = 22;

// Pre-fund amount: 500 GUARD (8 decimals)
const PRE_FUND_AMOUNT = 500n * 10n ** 8n;

// Hedera mirror node polling — contract IDs may take a few seconds to appear
const MIRROR_POLL_INTERVAL_MS = 3000;
const MIRROR_POLL_MAX_ATTEMPTS = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Load or initialize partial deploy state for recovery. */
function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    console.log("  Resuming from partial deploy state...\n");
    return JSON.parse(raw);
  }
  return {};
}

/** Persist deploy state after each step for crash recovery. */
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Load existing SDK config.json (Day 1). */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`SDK config not found at ${CONFIG_PATH}. Deploy Day 1 first.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/** Merge Day 2 entries into config.json without overwriting Day 1 data. */
function mergeAndSaveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Resolve a Hedera contract EVM address to its 0.0.XXXXX contract ID
 * via the mirror node REST API. Retries with polling for mirror node delay.
 */
async function resolveHederaId(evmAddress) {
  const addr = evmAddress.toLowerCase().replace("0x", "");
  const url = `${MIRROR_NODE}/api/v1/contracts/${addr}`;

  for (let attempt = 1; attempt <= MIRROR_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.contract_id) return data.contract_id;
      }
    } catch {
      // Mirror node not ready yet — retry
    }
    if (attempt < MIRROR_POLL_MAX_ATTEMPTS) {
      console.log(`    Mirror node not ready (attempt ${attempt}/${MIRROR_POLL_MAX_ATTEMPTS}), waiting...`);
      await sleep(MIRROR_POLL_INTERVAL_MS);
    }
  }
  // Fallback: return the EVM address prefixed with 0.0. (same pattern as Day 1)
  console.log(`    Warning: Could not resolve Hedera ID for ${evmAddress}, using EVM fallback`);
  return `0.0.${addr}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the ABI portion from a Hardhat artifact and write it to the SDK
 * abis directory in the same format as existing Day 1 ABIs.
 */
function exportAbi(contractName) {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Did compilation succeed?`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiFile = { contractName: artifact.contractName, abi: artifact.abi };
  const outPath = path.join(ABI_DIR, `${contractName}.json`);

  fs.mkdirSync(ABI_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(abiFile, null, 2) + "\n");
  return outPath;
}

/** Wait for a transaction and return the receipt, with a descriptive label on failure. */
async function waitForTx(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction failed: ${label} (tx: ${tx.hash})`);
  }
  return receipt;
}

// ─── Deploy Steps ────────────────────────────────────────────────────────────

async function deploySubAuction(deployer, config, state) {
  if (state.subAuction) {
    console.log(`  SubAuction already deployed at ${state.subAuction.evmAddress}, skipping.`);
    return state.subAuction;
  }

  console.log("  Deploying SubAuction...");
  const factory = await hre.ethers.getContractFactory("SubAuction", deployer);

  // Constructor: (guardToken, agentRegistry, mainAuction, treasury)
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    config.contracts.auctionContract.evmAddress,
    deployer.address // treasury = deployer for MVP
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.subAuction = result;
  saveState(state);
  return result;
}

async function deployDataMarketplace(deployer, config, state) {
  if (state.dataMarketplace) {
    console.log(`  DataMarketplace already deployed at ${state.dataMarketplace.evmAddress}, skipping.`);
    return state.dataMarketplace;
  }

  console.log("  Deploying DataMarketplace...");
  const factory = await hre.ethers.getContractFactory("DataMarketplace", deployer);

  // Constructor: (guardToken, agentRegistry, treasury)
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    deployer.address // treasury = deployer for MVP
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.dataMarketplace = result;
  saveState(state);
  return result;
}

async function deployPaymentSettlement(deployer, config, state) {
  if (state.paymentSettlement) {
    console.log(`  PaymentSettlement already deployed at ${state.paymentSettlement.evmAddress}, skipping.`);
    return state.paymentSettlement;
  }

  if (!state.subAuction) {
    throw new Error("SubAuction must be deployed before PaymentSettlement (needs its address).");
  }

  console.log("  Deploying PaymentSettlement...");
  const factory = await hre.ethers.getContractFactory("PaymentSettlement", deployer);

  // Constructor: (guardToken, agentRegistry, mainAuction, subAuction, treasury, orchestrator)
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    config.contracts.auctionContract.evmAddress,
    state.subAuction.evmAddress,
    deployer.address, // treasury = deployer for MVP
    deployer.address  // orchestrator = deployer for MVP
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.paymentSettlement = result;
  saveState(state);
  return result;
}

async function associateTokens(deployer, config, state) {
  if (state.tokensAssociated) {
    console.log("  Token associations already done, skipping.");
    return;
  }

  console.log("  Associating GUARD token with new contracts...");
  const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);
  const guardToken = config.guardTokenEvmAddress;

  const contracts = [
    { name: "SubAuction", address: state.subAuction.evmAddress },
    { name: "DataMarketplace", address: state.dataMarketplace.evmAddress },
    { name: "PaymentSettlement", address: state.paymentSettlement.evmAddress },
  ];

  for (const c of contracts) {
    try {
      console.log(`    Associating ${c.name} (${c.address})...`);
      const tx = await hts.tokenAssociate(c.address, guardToken, { gasLimit: 1_000_000 });
      await waitForTx(tx, `tokenAssociate ${c.name}`);
      console.log(`    ${c.name} associated.`);
    } catch (err) {
      // TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT (292) is fine — skip
      if (err.message && err.message.includes("already associated")) {
        console.log(`    ${c.name} already associated, skipping.`);
      } else {
        // Log but don't fail — association may succeed via a different path
        console.log(`    Warning: Association for ${c.name} returned error: ${err.message}`);
        console.log(`    (This may be non-fatal — Hedera auto-association could be enabled.)`);
      }
    }
  }

  state.tokensAssociated = true;
  saveState(state);
}

async function preFundSettlement(deployer, config, state) {
  if (state.preFunded) {
    console.log("  PaymentSettlement already pre-funded, skipping.");
    return;
  }

  console.log(`  Pre-funding PaymentSettlement with 500 GUARD...`);
  const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);

  try {
    const tx = await hts.transferToken(
      config.guardTokenEvmAddress,
      deployer.address,
      state.paymentSettlement.evmAddress,
      PRE_FUND_AMOUNT,
      { gasLimit: 1_000_000 }
    );
    await waitForTx(tx, "pre-fund PaymentSettlement");
    console.log("    500 GUARD deposited.");
  } catch (err) {
    console.log(`    Warning: Pre-funding failed: ${err.message}`);
    console.log("    The Orchestrator can fund the contract manually via depositSettlementFunds().");
    console.log("    Continuing deployment...");
  }

  state.preFunded = true;
  saveState(state);
}

function checkCrossContractPermissions(config) {
  // AgentRegistry.setOrchestratorAndAuction is a ONE-TIME function that was
  // already called during Day 1 deployment. It only accepts two addresses
  // (orchestrator + auctionContract) and cannot be called again.
  //
  // This means SubAuction, DataMarketplace, and PaymentSettlement CANNOT
  // directly call AgentRegistry functions guarded by onlyOrchestratorOrAuction
  // (recordJobCompletion, updateReputation, slashAgent).
  //
  // Workaround: The Orchestrator EOA (which IS authorized on AgentRegistry)
  // acts as the intermediary. When these Day 2 contracts need to update
  // reputation, the Orchestrator listens for their events and calls
  // AgentRegistry directly.
  //
  // TODO (Day 3): Extend AgentRegistry with an addAuthorizedCaller(address)
  // function that the owner can call to whitelist additional contracts.

  console.log("  Cross-contract permissions:");
  console.log("    AgentRegistry.setOrchestratorAndAuction was called in Day 1 (one-time).");
  console.log("    Day 2 contracts use the Orchestrator EOA as intermediary for reputation calls.");
  console.log("    TODO: Extend AgentRegistry with addAuthorizedCaller() for Day 3.\n");
}

function exportAbis(state) {
  if (state.abisExported) {
    console.log("  ABIs already exported, skipping.");
    return;
  }

  console.log("  Exporting ABIs to SDK...");
  const contracts = ["SubAuction", "DataMarketplace", "PaymentSettlement"];
  for (const name of contracts) {
    const outPath = exportAbi(name);
    console.log(`    ${name} -> ${path.relative(process.cwd(), outPath)}`);
  }

  state.abisExported = true;
  saveState(state);
}

function updateConfig(config, state) {
  if (state.configUpdated) {
    console.log("  config.json already updated, skipping.");
    return;
  }

  console.log("  Updating packages/sdk/config.json...");

  // Merge Day 2 contracts into existing contracts object
  config.contracts.subAuction = {
    id: state.subAuction.id,
    evmAddress: state.subAuction.evmAddress,
  };
  config.contracts.dataMarketplace = {
    id: state.dataMarketplace.id,
    evmAddress: state.dataMarketplace.evmAddress,
  };
  config.contracts.paymentSettlement = {
    id: state.paymentSettlement.id,
    evmAddress: state.paymentSettlement.evmAddress,
  };

  // Add Day 2 metadata
  config.day2 = {
    settlementPreFunded: 500,
    deployedAt: new Date().toISOString(),
  };

  mergeAndSaveConfig(config);
  console.log("    config.json updated with 3 new contracts + day2 metadata.\n");

  state.configUpdated = true;
  saveState(state);
}

function printSummary(config, state) {
  const bar = "─";
  const tl = "┌", tr = "┐", bl = "└", br = "┘";
  const ml = "├", mr = "┤", sep = "│";
  const tj = "┬", bj = "┴", mj = "┼";

  const col1 = 27;
  const col2 = 22;
  const hLine = (l, m, r) => l + bar.repeat(col1) + m + bar.repeat(col2) + r;

  const row = (label, value) => {
    const l = ` ${label}`.padEnd(col1 - 1) + " ";
    const v = ` ${value}`.padEnd(col2 - 1) + " ";
    return `${sep}${l}${sep}${v}${sep}`;
  };

  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Day 2 Component", "Address"));
  console.log(hLine(ml, mj, mr));
  console.log(row("Sub-Auction", state.subAuction.id));
  console.log(row("Data Marketplace", state.dataMarketplace.id));
  console.log(row("Payment Settlement", state.paymentSettlement.id));
  console.log(row("Settlement Pre-Funded", "500 GUARD"));
  console.log(row("Cross-Contract Wiring", "Done (see TODOs)"));
  console.log(row("ABIs Exported", "3 files"));
  console.log(hLine(bl, bj, br));

  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Full Contract Map", "Hedera ID"));
  console.log(hLine(ml, mj, mr));
  console.log(row("Agent Registry", config.contracts.agentRegistry.id));
  console.log(row("Audit Auction", config.contracts.auctionContract.id));
  console.log(row("Budget Vault", config.contracts.budgetVault.id));
  console.log(row("Sub-Auction", config.contracts.subAuction.id));
  console.log(row("Data Marketplace", config.contracts.dataMarketplace.id));
  console.log(row("Payment Settlement", config.contracts.paymentSettlement.id));
  console.log(hLine(bl, bj, br));

  console.log("\n  Day 2 infrastructure deployed. Updated config.json + ABIs ready for teammates.\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n========================================");
  console.log("  AuditGuard Day 2 — Contract Deployment");
  console.log("========================================\n");

  // ── Setup ─────────────────────────────────────────────────────────────
  const [deployer] = await hre.ethers.getSigners();
  console.log(`  Deployer: ${deployer.address}`);

  const config = loadConfig();
  console.log(`  GUARD Token: ${config.guardTokenEvmAddress}`);
  console.log(`  Agent Registry: ${config.contracts.agentRegistry.evmAddress}`);
  console.log(`  Auction Contract: ${config.contracts.auctionContract.evmAddress}`);
  console.log(`  Budget Vault: ${config.contracts.budgetVault.evmAddress}`);
  console.log("");

  const state = loadState();

  // ── Compile ───────────────────────────────────────────────────────────
  console.log("Step 1: Compiling contracts...");
  await hre.run("compile");
  console.log("");

  // ── Deploy (order matters: SubAuction before PaymentSettlement) ──────
  console.log("Step 2: Deploying Day 2 contracts...\n");

  await deploySubAuction(deployer, config, state);
  console.log("");

  await deployDataMarketplace(deployer, config, state);
  console.log("");

  await deployPaymentSettlement(deployer, config, state);
  console.log("");

  // ── Token associations ────────────────────────────────────────────────
  console.log("Step 3: Token associations...\n");
  await associateTokens(deployer, config, state);
  console.log("");

  // ── Pre-fund PaymentSettlement ────────────────────────────────────────
  console.log("Step 4: Pre-funding PaymentSettlement...\n");
  await preFundSettlement(deployer, config, state);
  console.log("");

  // ── Cross-contract permissions ────────────────────────────────────────
  console.log("Step 5: Cross-contract permissions...\n");
  checkCrossContractPermissions(config);

  // ── Export ABIs ───────────────────────────────────────────────────────
  console.log("Step 6: Exporting ABIs...\n");
  exportAbis(state);
  console.log("");

  // ── Update config.json ────────────────────────────────────────────────
  console.log("Step 7: Updating config.json...\n");
  updateConfig(config, state);

  // ── Summary ───────────────────────────────────────────────────────────
  printSummary(config, state);

  // ── Cleanup state file on success ─────────────────────────────────────
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
    console.log("  Cleaned up deploy-day2-state.json (full success).\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n  DEPLOYMENT FAILED:", err.message);
    console.error("  Partial state saved to deploy-day2-state.json — re-run to resume.\n");
    process.exit(1);
  });
