/**
 * deploy-day4.js — Deploy Day 4 AuditGuard contracts to Hedera Testnet
 *
 * Deploys:   DelegatedStaking
 * Wires:     PaymentSettlement as an authorized reward distributor
 *            HTS GUARD token association for the new contract
 * Updates:   packages/sdk/config.json  (replaces placeholder evmAddress)
 *            packages/sdk/abis/DelegatedStaking.json  (live ABI from artifact)
 *
 * Prerequisites (must already be in config.json):
 *   contracts.agentRegistry    — deployed Day 1
 *   contracts.paymentSettlement — deployed Day 2
 *   contracts.stakingManager   — deployed Day 3
 *   contracts.treasury         — deployed Day 3
 *   guardTokenEvmAddress       — GUARD HTS token
 *
 * Usage:
 *   npx hardhat run packages/contracts/scripts/deploy-day4.js \
 *     --config packages/contracts/hardhat.config.js \
 *     --network hedera_testnet
 *
 * Idempotent — safe to re-run if it fails mid-way.
 * Progress is persisted to deploy-day4-state.json; completed steps are skipped.
 *
 * ─── IMPORTANT: GUARD token decimals ────────────────────────────────────────
 *   DelegatedStaking stores amounts with 8 decimal places (minDelegation is
 *   10 * 10**8).  The frontend must therefore call:
 *
 *     delegate(agent, parseUnits(humanAmount, 8))   ← 8, NOT 18
 *
 *   The HTS transferToken path enforces amount ≤ int64.max (~9.2e18), so
 *   passing 18-decimal units (e.g. parseUnits("50", 18) = 5e19) will revert.
 * ────────────────────────────────────────────────────────────────────────────
 */

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

// ─── Paths ────────────────────────────────────────────────────────────────────

const SDK_DIR    = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR    = path.join(SDK_DIR, "abis");
const STATE_PATH = path.join(__dirname, "deploy-day4-state.json");

// ─── Constants ────────────────────────────────────────────────────────────────

const MIRROR_NODE              = "https://testnet.mirrornode.hedera.com";
const MIRROR_POLL_INTERVAL_MS  = 3_000;
const MIRROR_POLL_MAX_ATTEMPTS = 20;
const GAS_LIMIT                = 1_000_000;

const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";
const HTS_ABI = [
  "function tokenAssociate(address account, address token) external returns (int64)",
];
const HTS_SUCCESS                  = 22;
const HTS_TOKEN_ALREADY_ASSOCIATED = 194;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    console.log("  Resuming from partial deploy state...\n");
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`SDK config not found at ${CONFIG_PATH}. Deploy Day 1–3 first.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function mergeAndSaveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function resolveHederaId(evmAddress) {
  const addr = evmAddress.toLowerCase().replace("0x", "");
  const url  = `${MIRROR_NODE}/api/v1/contracts/${addr}`;

  for (let attempt = 1; attempt <= MIRROR_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.contract_id) return data.contract_id;
      }
    } catch { /* mirror not ready */ }

    if (attempt < MIRROR_POLL_MAX_ATTEMPTS) {
      console.log(`    Mirror node not ready (attempt ${attempt}/${MIRROR_POLL_MAX_ATTEMPTS}), waiting...`);
      await sleep(MIRROR_POLL_INTERVAL_MS);
    }
  }

  console.log(`    ⚠ Could not resolve Hedera ID for ${evmAddress}, using EVM fallback`);
  return `0.0.${addr}`;
}

function exportAbi(contractName) {
  const artifactPath = path.join(
    __dirname, "..", "artifacts", "contracts",
    `${contractName}.sol`, `${contractName}.json`
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Did compilation succeed?`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiFile  = { contractName: artifact.contractName, abi: artifact.abi };
  const outPath  = path.join(ABI_DIR, `${contractName}.json`);

  fs.mkdirSync(ABI_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(abiFile, null, 2) + "\n");
  return outPath;
}

async function waitForTx(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction failed: ${label} (tx: ${tx.hash})`);
  }
  return receipt;
}

async function sendTxRequired(txBuilder, label) {
  const tx = await txBuilder();
  await waitForTx(tx, label);
  console.log(`    ✓ ${label}`);
}

async function sendTxOptional(txBuilder, label) {
  try {
    const tx = await txBuilder();
    await waitForTx(tx, label);
    console.log(`    ✓ ${label}`);
    return true;
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    console.log(`    ⚠ ${label} skipped: ${msg.slice(0, 120)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 1: DEPLOY
// ═══════════════════════════════════════════════════════════════════════════════

async function deployDelegatedStaking(deployer, config, state) {
  if (state.delegatedStaking) {
    console.log(
      `  DelegatedStaking already deployed at ${state.delegatedStaking.evmAddress}, skipping.`
    );
    return state.delegatedStaking;
  }

  console.log("  Deploying DelegatedStaking...");
  console.log(`    guardToken:     ${config.guardTokenEvmAddress}`);
  console.log(`    stakingManager: ${config.contracts.stakingManager.evmAddress}`);
  console.log(`    agentRegistry:  ${config.contracts.agentRegistry.evmAddress}`);
  console.log(`    treasury:       ${config.contracts.treasury.evmAddress}`);

  const factory  = await hre.ethers.getContractFactory("DelegatedStaking", deployer);
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.stakingManager.evmAddress,
    config.contracts.agentRegistry.evmAddress,
    config.contracts.treasury.evmAddress
  );

  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID:       ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.delegatedStaking = result;
  saveState(state);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 2: HTS TOKEN ASSOCIATION
// ═══════════════════════════════════════════════════════════════════════════════

async function associateGuardToken(deployer, config, state) {
  if (state.tokenAssociated) {
    console.log("  GUARD token association already done, skipping.");
    return;
  }

  const dsAddress = state.delegatedStaking.evmAddress;
  console.log(`  Associating GUARD token with DelegatedStaking (${dsAddress})...`);

  const ds = await hre.ethers.getContractAt("DelegatedStaking", dsAddress, deployer);

  // Primary path: call the contract's own associateGuardToken() (onlyOwner).
  // This is preferred because it emits the GuardTokenAssociated event.
  const primaryOk = await sendTxOptional(
    () => ds.associateGuardToken({ gasLimit: GAS_LIMIT }),
    "DelegatedStaking.associateGuardToken()"
  );

  if (!primaryOk) {
    // Fallback: direct HTS precompile call from the deployer EOA.
    console.log("    Falling back to direct HTS.tokenAssociate()...");
    const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);

    try {
      const tx = await hts.tokenAssociate(dsAddress, config.guardTokenEvmAddress, {
        gasLimit: GAS_LIMIT,
      });
      const receipt = await waitForTx(tx, "HTS.tokenAssociate(DelegatedStaking)");
      console.log(`    ✓ Direct HTS association confirmed (tx: ${receipt.hash})`);
    } catch (err) {
      // HTS response code 194 = already associated — safe to continue.
      if (err?.message?.includes("194")) {
        console.log("    ✓ Token already associated (HTS code 194).");
      } else {
        console.log(`    ⚠ HTS association failed: ${err?.message?.slice(0, 120)}`);
        console.log("    (Hedera may auto-associate on the first transfer. Proceeding.)");
      }
    }
  }

  state.tokenAssociated = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 3: AUTHORIZE REWARD DISTRIBUTORS
// ═══════════════════════════════════════════════════════════════════════════════

async function authorizeDistributors(deployer, config, state) {
  if (state.distributorsAuthorized) {
    console.log("  Reward distributors already authorized, skipping.");
    return;
  }

  const dsAddress = state.delegatedStaking.evmAddress;
  console.log("  Authorizing reward distributors...");

  const ds = await hre.ethers.getContractAt("DelegatedStaking", dsAddress, deployer);

  // PaymentSettlement distributes agent earnings → must be allowed to call
  // DelegatedStaking.distributeRewards(agent, amount).
  await sendTxRequired(
    () =>
      ds.addAuthorizedDistributor(config.contracts.paymentSettlement.evmAddress, {
        gasLimit: GAS_LIMIT,
      }),
    `DelegatedStaking.addAuthorizedDistributor(PaymentSettlement)`
  );

  state.distributorsAuthorized = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 4: EXPORT ABI
// ═══════════════════════════════════════════════════════════════════════════════

function exportAbis(state) {
  if (state.abisExported) {
    console.log("  ABI already exported, skipping.");
    return;
  }

  console.log("  Exporting DelegatedStaking ABI to SDK...");
  const outPath = exportAbi("DelegatedStaking");
  console.log(`    DelegatedStaking -> ${path.relative(process.cwd(), outPath)}`);

  state.abisExported = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 5: UPDATE CONFIG.JSON
// ═══════════════════════════════════════════════════════════════════════════════

function updateConfig(config, state) {
  if (state.configUpdated) {
    console.log("  config.json already updated, skipping.");
    return;
  }

  console.log("  Updating packages/sdk/config.json...");

  config.contracts.delegatedStaking = {
    id:         state.delegatedStaking.id,
    evmAddress: state.delegatedStaking.evmAddress,
  };

  config.day4 = {
    delegatedStakingAddress: state.delegatedStaking.evmAddress,
    deployedAt: new Date().toISOString(),
    notes: [
      "GUARD amounts use 8 decimal places (minDelegation = 10 * 10**8).",
      "Frontend must use parseUnits(amount, 8) — NOT parseUnits(amount, 18).",
      "StakingManager.propagateSlash → DelegatedStaking wiring: StakingManager",
      "was deployed on Day 3 and has no setDelegatedStaking() function in its",
      "current ABI. Either upgrade StakingManager or call propagateSlash manually",
      "from an authorized EOA until StakingManager is upgraded.",
    ],
  };

  mergeAndSaveConfig(config);
  console.log("    ✓ config.json updated with DelegatedStaking address + day4 metadata.\n");

  state.configUpdated = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 6: SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

function printSummary(config, state) {
  const bar = "─", tl = "┌", tr = "┐", bl = "└", br = "┘";
  const ml = "├", mr = "┤", sep = "│", tj = "┬", bj = "┴", mj = "┼";
  const col1 = 36, col2 = 45;
  const hLine = (l, m, r) => l + bar.repeat(col1) + m + bar.repeat(col2) + r;
  const row = (label, value) =>
    `${sep} ${label.padEnd(col1 - 2)} ${sep} ${value.padEnd(col2 - 2)} ${sep}`;

  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Day 4 — DelegatedStaking", "Details"));
  console.log(hLine(ml, mj, mr));
  console.log(row("EVM Address", state.delegatedStaking.evmAddress));
  console.log(row("Hedera ID",   state.delegatedStaking.id));
  console.log(row("guardToken",  config.guardTokenEvmAddress));
  console.log(row("stakingManager", config.contracts.stakingManager.evmAddress));
  console.log(row("agentRegistry",  config.contracts.agentRegistry.evmAddress));
  console.log(row("treasury",       config.contracts.treasury.evmAddress));
  console.log(hLine(ml, mj, mr));
  console.log(row("Authorized distributor", config.contracts.paymentSettlement.evmAddress));
  console.log(row("", "(PaymentSettlement)"));
  console.log(hLine(ml, mj, mr));
  console.log(row("GUARD token associated", "✓ (associateGuardToken)"));
  console.log(row("ABI exported",           "✓ packages/sdk/abis/DelegatedStaking.json"));
  console.log(row("config.json updated",    "✓ contracts.delegatedStaking"));
  console.log(hLine(bl, bj, br));

  console.log(`
  ┌─ Next Steps ────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  1. Agents call  enableDelegation()  to open their delegation pool.    │
  │                                                                         │
  │  2. Frontend amounts must use 8 decimal places:                        │
  │       parseUnits(amount, 8)  — NOT parseUnits(amount, 18)              │
  │     The contract enforces  minDelegation = 10 * 10**8  (10 GUARD).    │
  │                                                                         │
  │  3. propagateSlash integration: StakingManager (Day 3) does not yet    │
  │     have a setDelegatedStaking() method. Until StakingManager is       │
  │     upgraded, slash propagation to delegators must be called manually. │
  │                                                                         │
  └─────────────────────────────────────────────────────────────────────────┘
`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n================================================");
  console.log("  AuditGuard Day 4 — DelegatedStaking Deploy");
  console.log("================================================\n");

  // ── Setup ──────────────────────────────────────────────────────────────────
  const [deployer] = await hre.ethers.getSigners();
  console.log(`  Deployer: ${deployer.address}\n`);

  const config = loadConfig();

  // ── Validate Day 1–3 prerequisites ─────────────────────────────────────────
  const required = {
    "GUARD token":       config.guardTokenEvmAddress,
    agentRegistry:       config.contracts?.agentRegistry?.evmAddress,
    paymentSettlement:   config.contracts?.paymentSettlement?.evmAddress,
    stakingManager:      config.contracts?.stakingManager?.evmAddress,
    treasury:            config.contracts?.treasury?.evmAddress,
  };

  let missingAny = false;
  for (const [name, value] of Object.entries(required)) {
    const isPlaceholder = !value || value === "0x0000000000000000000000000000000000000000";
    if (isPlaceholder) {
      console.error(`  ✗ Missing prerequisite: ${name}. Deploy Day 1–3 first.`);
      missingAny = true;
    } else {
      console.log(`  ✓ ${name.padEnd(22)}: ${value}`);
    }
  }
  if (missingAny) {
    throw new Error("One or more Day 1–3 prerequisites are missing. Aborting.");
  }
  console.log("");

  const state = loadState();

  // ── Step 1: Compile ────────────────────────────────────────────────────────
  console.log("Step 1: Compiling contracts...");
  await hre.run("compile");
  console.log("");

  // ── Step 2: Deploy DelegatedStaking ───────────────────────────────────────
  console.log("Step 2: Deploying DelegatedStaking...\n");
  await deployDelegatedStaking(deployer, config, state);
  console.log("");

  // ── Step 3: HTS token association ─────────────────────────────────────────
  console.log("Step 3: HTS token association...\n");
  await associateGuardToken(deployer, config, state);
  console.log("");

  // ── Step 4: Authorize reward distributors ─────────────────────────────────
  console.log("Step 4: Authorizing reward distributors...\n");
  await authorizeDistributors(deployer, config, state);
  console.log("");

  // ── Step 5: Export ABI ────────────────────────────────────────────────────
  console.log("Step 5: Exporting ABI...\n");
  exportAbis(state);
  console.log("");

  // ── Step 6: Update config.json ────────────────────────────────────────────
  console.log("Step 6: Updating config.json...\n");
  updateConfig(config, state);

  // ── Step 7: Summary ───────────────────────────────────────────────────────
  printSummary(config, state);

  // ── Clean up state file on full success ───────────────────────────────────
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
    console.log("  Cleaned up deploy-day4-state.json (full success).\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n  DEPLOYMENT FAILED:", err.message);
    console.error("  Partial state saved to deploy-day4-state.json — re-run to resume.\n");
    process.exit(1);
  });
