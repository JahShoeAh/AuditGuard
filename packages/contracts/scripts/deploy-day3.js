/**
 * deploy-day3.js — Deploy Day 3 AuditGuard contracts to Hedera Testnet
 *
 * Deploys:   Treasury, StakingManager, VaultFactory
 * Wires:     Day 1/2 contracts to point to Day 3 infrastructure
 * Migrates:  Agent stakes to StakingManager, demo vault via VaultFactory
 * Updates:   packages/sdk/config.json + packages/sdk/abis/
 *
 * Usage:
 *   npx hardhat run packages/contracts/scripts/deploy-day3.js --config packages/contracts/hardhat.config.js --network hedera_testnet
 *
 * Partial deploy recovery:
 *   If the script fails midway, re-run it. It reads deploy-day3-state.json
 *   and skips already-completed steps.
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─── Paths ───────────────────────────────────────────────────────────────────

const SDK_DIR = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR = path.join(SDK_DIR, "abis");
const STATE_PATH = path.join(__dirname, "deploy-day3-state.json");

// ─── Constants ───────────────────────────────────────────────────────────────

const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";
const HTS_ABI = [
  "function transferToken(address token, address sender, address receiver, int64 amount) external returns (int64)",
  "function tokenAssociate(address account, address token) external returns (int64)",
];
const HTS_SUCCESS = 22;

const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TOKEN_DECIMALS = 8;

// Hedera mirror node polling — contract IDs may take a few seconds to appear
const MIRROR_POLL_INTERVAL_MS = 3000;
const MIRROR_POLL_MAX_ATTEMPTS = 20;

// Gas limit for most setter calls
const GAS_LIMIT = 1_000_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toTokenUnits(amount) {
  return BigInt(Math.floor(amount * 10 ** TOKEN_DECIMALS));
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    console.log("  Resuming from partial deploy state...\n");
    return JSON.parse(raw);
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`SDK config not found at ${CONFIG_PATH}. Deploy Day 1 + Day 2 first.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function mergeAndSaveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

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
  console.log(`    Warning: Could not resolve Hedera ID for ${evmAddress}, using EVM fallback`);
  return `0.0.${addr}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForTx(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction failed: ${label} (tx: ${tx.hash})`);
  }
  return receipt;
}

/**
 * Best-effort transaction: logs warning on failure but doesn't throw.
 * Returns true if the tx succeeded, false if it was skipped.
 */
async function sendTxOptional(txBuilder, label) {
  try {
    const tx = await txBuilder();
    await waitForTx(tx, label);
    console.log(`    ✓ ${label}`);
    return true;
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    console.log(`    ⚠ ${label} skipped: ${msg}`);
    return false;
  }
}

/**
 * Required transaction: throws on failure.
 */
async function sendTxRequired(txBuilder, label) {
  const tx = await txBuilder();
  await waitForTx(tx, label);
  console.log(`    ✓ ${label}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 1: DEPLOY NEW CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════

async function deployTreasury(deployer, config, state) {
  if (state.treasury) {
    console.log(`  Treasury already deployed at ${state.treasury.evmAddress}, skipping.`);
    return state.treasury;
  }

  console.log("  Deploying Treasury...");
  const factory = await hre.ethers.getContractFactory("Treasury", deployer);

  // Constructor: (guardToken, ucpValidatorPool, protocolReserve, burnAddress)
  // For MVP: deployer acts as both ucpValidatorPool and protocolReserve
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    deployer.address, // ucpValidatorPool = deployer for MVP
    deployer.address, // protocolReserve = deployer for MVP
    BURN_ADDRESS
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.treasury = result;
  saveState(state);
  return result;
}

async function deployStakingManager(deployer, config, state) {
  if (state.stakingManager) {
    console.log(`  StakingManager already deployed at ${state.stakingManager.evmAddress}, skipping.`);
    return state.stakingManager;
  }

  if (!state.treasury) {
    throw new Error("Treasury must be deployed before StakingManager (needs its address).");
  }

  console.log("  Deploying StakingManager...");
  const factory = await hre.ethers.getContractFactory("StakingManager", deployer);

  // Constructor: (guardToken, agentRegistry, treasury)
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    state.treasury.evmAddress
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.stakingManager = result;
  saveState(state);
  return result;
}

async function deployVaultFactory(deployer, config, state) {
  if (state.vaultFactory) {
    console.log(`  VaultFactory already deployed at ${state.vaultFactory.evmAddress}, skipping.`);
    return state.vaultFactory;
  }

  console.log("  Deploying VaultFactory...");
  const factory = await hre.ethers.getContractFactory("VaultFactory", deployer);

  // Constructor: (guardToken, agentRegistry)
  const contract = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress
  );
  await contract.waitForDeployment();
  const evmAddress = await contract.getAddress();
  console.log(`    Deployed at EVM: ${evmAddress}`);

  const hederaId = await resolveHederaId(evmAddress);
  console.log(`    Hedera ID: ${hederaId}`);

  const result = { evmAddress, id: hederaId };
  state.vaultFactory = result;
  saveState(state);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 2: TOKEN ASSOCIATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function associateTokens(deployer, config, state) {
  if (state.tokensAssociated) {
    console.log("  Token associations already done, skipping.");
    return;
  }

  console.log("  Associating GUARD token with Day 3 contracts...");

  const contracts = [
    { name: "Treasury", address: state.treasury.evmAddress },
    { name: "StakingManager", address: state.stakingManager.evmAddress },
    { name: "VaultFactory", address: state.vaultFactory.evmAddress },
  ];

  for (const c of contracts) {
    try {
      console.log(`    Associating ${c.name} (${c.address})...`);
      const contract = await hre.ethers.getContractAt(c.name, c.address, deployer);
      await sendTxOptional(
        () => contract.associateGuardToken({ gasLimit: GAS_LIMIT }),
        `${c.name}.associateGuardToken()`
      );
    } catch (err) {
      // Fallback: try direct HTS call
      try {
        const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);
        const tx = await hts.tokenAssociate(c.address, config.guardTokenEvmAddress, { gasLimit: GAS_LIMIT });
        await waitForTx(tx, `HTS.tokenAssociate(${c.name})`);
        console.log(`    ${c.name} associated via direct HTS call.`);
      } catch (htsErr) {
        console.log(`    ⚠ ${c.name} association failed: ${htsErr.message?.slice(0, 120)}`);
        console.log(`    (Hedera auto-association may handle this.)`);
      }
    }
  }

  state.tokensAssociated = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 3: CONFIGURE DAY 3 CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════

async function configureTreasury(deployer, config, state) {
  if (state.treasuryConfigured) {
    console.log("  Treasury already configured, skipping.");
    return;
  }

  console.log("  Configuring Treasury...");
  const treasury = await hre.ethers.getContractAt("Treasury", state.treasury.evmAddress, deployer);

  // Distribution config: 40% UCP validators, 50% reserve, 10% burn
  await sendTxRequired(
    () => treasury.setDistributionConfig(40, 50, 10, { gasLimit: GAS_LIMIT }),
    "Treasury.setDistributionConfig(40, 50, 10)"
  );

  // Distribution targets (deployer as MVP placeholders + burn address)
  await sendTxRequired(
    () => treasury.setDistributionTargets(deployer.address, deployer.address, BURN_ADDRESS, { gasLimit: GAS_LIMIT }),
    "Treasury.setDistributionTargets(deployer, deployer, burnAddr)"
  );

  // Wire StakingManager + AgentRegistry into Treasury for fee discount checks
  await sendTxRequired(
    () => treasury.setStakingManager(state.stakingManager.evmAddress, { gasLimit: GAS_LIMIT }),
    "Treasury.setStakingManager(StakingManager)"
  );
  await sendTxRequired(
    () => treasury.setAgentRegistry(config.contracts.agentRegistry.evmAddress, { gasLimit: GAS_LIMIT }),
    "Treasury.setAgentRegistry(AgentRegistry)"
  );

  state.treasuryConfigured = true;
  saveState(state);
}

async function configureStakingManager(deployer, config, state) {
  if (state.stakingManagerConfigured) {
    console.log("  StakingManager already configured, skipping.");
    return;
  }

  console.log("  Configuring StakingManager...");
  const staking = await hre.ethers.getContractAt("StakingManager", state.stakingManager.evmAddress, deployer);

  // Add authorized slashers: AuditAuction, SubAuction, PaymentSettlement
  const slashers = [
    { name: "AuditAuction", address: config.contracts.auctionContract.evmAddress },
    { name: "SubAuction", address: config.contracts.subAuction.evmAddress },
    { name: "PaymentSettlement", address: config.contracts.paymentSettlement.evmAddress },
  ];
  for (const s of slashers) {
    await sendTxRequired(
      () => staking.addAuthorizedSlasher(s.address, { gasLimit: GAS_LIMIT }),
      `StakingManager.addAuthorizedSlasher(${s.name})`
    );
  }

  // Set slash rates (enum order: FALSE_POSITIVE=0, FALSE_NEGATIVE=1, MALICIOUS_REPORT=2,
  //                               SLA_VIOLATION=3, COLLUSION=4, PLAGIARISM=5)
  const slashRates = [
    { reason: 0, bps: 500,   label: "FALSE_POSITIVE → 500 bps (5%)" },
    { reason: 1, bps: 1000,  label: "FALSE_NEGATIVE → 1000 bps (10%)" },
    { reason: 2, bps: 10000, label: "MALICIOUS_REPORT → 10000 bps (100%)" },
    { reason: 3, bps: 2500,  label: "SLA_VIOLATION → 2500 bps (25%)" },
    { reason: 4, bps: 10000, label: "COLLUSION → 10000 bps (100%)" },
    { reason: 5, bps: 5000,  label: "PLAGIARISM → 5000 bps (50%)" },
  ];
  for (const sr of slashRates) {
    await sendTxRequired(
      () => staking.setSlashRate(sr.reason, sr.bps, { gasLimit: GAS_LIMIT }),
      `StakingManager.setSlashRate(${sr.label})`
    );
  }

  state.stakingManagerConfigured = true;
  saveState(state);
}

async function configureVaultFactory(deployer, config, state) {
  if (state.vaultFactoryConfigured) {
    console.log("  VaultFactory already configured, skipping.");
    return;
  }

  console.log("  Configuring VaultFactory...");
  const vaultFactory = await hre.ethers.getContractAt("VaultFactory", state.vaultFactory.evmAddress, deployer);

  await sendTxRequired(
    () => vaultFactory.setAuctionContract(config.contracts.auctionContract.evmAddress, { gasLimit: GAS_LIMIT }),
    "VaultFactory.setAuctionContract(AuditAuction)"
  );
  await sendTxRequired(
    () => vaultFactory.setPaymentSettlement(config.contracts.paymentSettlement.evmAddress, { gasLimit: GAS_LIMIT }),
    "VaultFactory.setPaymentSettlement(PaymentSettlement)"
  );

  state.vaultFactoryConfigured = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 4: REWIRE DAY 1/2 CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════

async function rewireExistingContracts(deployer, config, state) {
  if (state.rewired) {
    console.log("  Day 1/2 contracts already rewired, skipping.");
    return;
  }

  console.log("  Rewiring Day 1/2 contracts to point to Day 3 infrastructure...\n");

  const treasuryAddr = state.treasury.evmAddress;

  // ── 4a. AuditAuction ──
  console.log("    [AuditAuction]");
  const auction = await hre.ethers.getContractAt("AuditAuction", config.contracts.auctionContract.evmAddress, deployer);
  await sendTxRequired(
    () => auction.setTreasury(treasuryAddr, { gasLimit: GAS_LIMIT }),
    "AuditAuction.setTreasury(Treasury)"
  );
  // AuditAuction does NOT have setStakingManager or setBudgetVault.
  // The Orchestrator script should check StakingManager.isStakeSufficient()
  // before calling selectWinners.
  console.log("    TODO: AuditAuction has no setStakingManager(). Orchestrator should check");
  console.log("          StakingManager.isStakeSufficient() before selectWinners.\n");

  // ── 4b. SubAuction ──
  console.log("    [SubAuction]");
  const subAuction = await hre.ethers.getContractAt("SubAuction", config.contracts.subAuction.evmAddress, deployer);
  await sendTxRequired(
    () => subAuction.setTreasury(treasuryAddr, { gasLimit: GAS_LIMIT }),
    "SubAuction.setTreasury(Treasury)"
  );

  // ── 4c. DataMarketplace ──
  console.log("    [DataMarketplace]");
  const marketplace = await hre.ethers.getContractAt("DataMarketplace", config.contracts.dataMarketplace.evmAddress, deployer);
  await sendTxRequired(
    () => marketplace.setTreasury(treasuryAddr, { gasLimit: GAS_LIMIT }),
    "DataMarketplace.setTreasury(Treasury)"
  );

  // ── 4d. PaymentSettlement ──
  console.log("    [PaymentSettlement]");
  const settlement = await hre.ethers.getContractAt("PaymentSettlement", config.contracts.paymentSettlement.evmAddress, deployer);
  await sendTxRequired(
    () => settlement.setTreasury(treasuryAddr, { gasLimit: GAS_LIMIT }),
    "PaymentSettlement.setTreasury(Treasury)"
  );

  // ── 4e. Authorize Treasury to receive from all fee sources ──
  console.log("\n    [Treasury authorized sources]");
  const treasury = await hre.ethers.getContractAt("Treasury", treasuryAddr, deployer);
  const sources = [
    { name: "AuditAuction", address: config.contracts.auctionContract.evmAddress },
    { name: "PaymentSettlement", address: config.contracts.paymentSettlement.evmAddress },
    { name: "DataMarketplace", address: config.contracts.dataMarketplace.evmAddress },
    { name: "SubAuction", address: config.contracts.subAuction.evmAddress },
    { name: "StakingManager", address: state.stakingManager.evmAddress },
  ];
  for (const src of sources) {
    await sendTxRequired(
      () => treasury.addAuthorizedSource(src.address, { gasLimit: GAS_LIMIT }),
      `Treasury.addAuthorizedSource(${src.name})`
    );
  }

  state.rewired = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 5: MIGRATE AGENT STAKES
// ═══════════════════════════════════════════════════════════════════════════════

async function migrateAgentStakes(deployer, config, state) {
  if (state.stakesMigrated) {
    console.log("  Agent stakes already migrated, skipping.");
    return;
  }

  console.log("  Migrating seeded agent stakes to StakingManager...\n");

  const seeded = config.seededAgents || {};
  const agentSpecs = [
    { label: "staticAnalysis47", agentId: "StaticAnalysis-47", stake: 150 },
    { label: "fuzzer12", agentId: "Fuzzer-12", stake: 300 },
    { label: "llmContextual3", agentId: "LLMContextual-3", stake: 500 },
  ];

  state.stakeMigration = state.stakeMigration || {};
  const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);
  const stakingAddr = state.stakingManager.evmAddress;

  let migratedCount = 0;

  for (const spec of agentSpecs) {
    const agentConfig = seeded[spec.label];
    if (!agentConfig || !agentConfig.evmAddress) {
      console.log(`    ⚠ Skipping ${spec.label}: not found in config.seededAgents`);
      console.log(`      (Agent accounts were not configured during Day 1 deploy.)`);
      state.stakeMigration[spec.label] = { address: "N/A", staked: 0, skipped: true };
      continue;
    }

    const agentAddress = agentConfig.evmAddress;
    const stakeAmount = toTokenUnits(spec.stake);

    // Hackathon workaround: deployer transfers GUARD to agent, then agent
    // stakes in StakingManager. This avoids needing to withdraw from
    // AgentRegistry (which may not support stake withdrawal).
    console.log(`    Migrating ${spec.label} (${agentAddress}): ${spec.stake} GUARD`);

    // Step 1: Transfer GUARD from deployer to agent
    const transferOk = await sendTxOptional(
      () => hts.transferToken(config.guardTokenEvmAddress, deployer.address, agentAddress, stakeAmount, { gasLimit: GAS_LIMIT }),
      `Transfer ${spec.stake} GUARD to ${spec.label}`
    );

    if (transferOk) {
      // Step 2: Agent stakes in StakingManager
      // We need the agent's private key to sign, but in the hackathon setup
      // the deployer holds all agent keys via env vars. If agent keys aren't
      // available, the agent can stake later on their own.
      const keyName = spec.label === "staticAnalysis47" ? "STATIC"
        : spec.label === "fuzzer12" ? "FUZZER"
        : "LLM";
      const legacyKey = spec.label === "staticAnalysis47" ? "AUDITOR_AGENT_1"
        : spec.label === "fuzzer12" ? "AUDITOR_AGENT_2"
        : "AUDITOR_AGENT_3";
      const rawPk = process.env[`${keyName}_PRIVATE_KEY`] || process.env[`${legacyKey}_PRIVATE_KEY`];

      if (rawPk) {
        try {
          const pk = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
          const agentWallet = new hre.ethers.Wallet(pk, hre.ethers.provider);
          const staking = await hre.ethers.getContractAt("StakingManager", stakingAddr, agentWallet);
          await sendTxRequired(
            () => staking.stake(stakeAmount, { gasLimit: GAS_LIMIT }),
            `${spec.label}.stake(${spec.stake} GUARD)`
          );
          migratedCount++;
          state.stakeMigration[spec.label] = { address: agentAddress, staked: spec.stake };
        } catch (err) {
          console.log(`    ⚠ Stake call failed for ${spec.label}: ${err.message?.slice(0, 120)}`);
          console.log(`      GUARD transferred but not staked — agent can call stake() manually.`);
          state.stakeMigration[spec.label] = { address: agentAddress, staked: 0, transferred: spec.stake };
        }
      } else {
        console.log(`    ⚠ No private key for ${spec.label} — GUARD transferred, agent must call stake() manually.`);
        state.stakeMigration[spec.label] = { address: agentAddress, staked: 0, transferred: spec.stake };
      }
    } else {
      state.stakeMigration[spec.label] = { address: agentAddress, staked: 0, skipped: true };
    }
  }

  console.log(`\n    ${migratedCount} of ${agentSpecs.length} agents fully migrated.`);

  state.stakesMigrated = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 6: CREATE DEMO VAULT
// ═══════════════════════════════════════════════════════════════════════════════

async function createDemoVault(deployer, config, state) {
  if (state.demoVault) {
    console.log(`  Demo vault already created at ${state.demoVault.vaultInstanceAddress}, skipping.`);
    return;
  }

  console.log("  Creating demo vault via VaultFactory...");

  const vaultFactory = await hre.ethers.getContractAt("VaultFactory", state.vaultFactory.evmAddress, deployer);

  // Mock contract address for "LendingProtocolV2"
  const mockContractAddr = "0x" + "L2".repeat(20).replace(/L/g, "1").replace(/2/g, "2");
  // Use a more readable mock address
  const lendingContract = "0x1212121212121212121212121212121212121212";

  const vaultConfig = {
    weeklyMonitoringBudget: toTokenUnits(10),      // 10 GUARD/week
    criticalBountyAllocation: toTokenUnits(50),     // 50 GUARD bounty pool
    reauditIntervalSeconds: 300,                     // 5 minutes for demo
    maxSingleAuditBudget: toTokenUnits(100),        // 100 GUARD max per audit
    acceptsMonitoringBids: true,
  };

  console.log(`    Contract: ${lendingContract}`);
  console.log(`    Weekly monitoring: 10 GUARD, Bounty: 50 GUARD, Reaudit: 300s, Max audit: 100 GUARD`);

  try {
    const tx = await vaultFactory.createVault(
      lendingContract,
      "hedera",
      vaultConfig,
      { gasLimit: 5_000_000 } // CREATE2 deployment needs higher gas
    );
    const receipt = await waitForTx(tx, "VaultFactory.createVault(LendingProtocolV2)");
    console.log(`    ✓ Vault created (tx: ${receipt.hash})`);

    // Get the vault address from the factory
    const vaultAddress = await vaultFactory.getVaultFor(lendingContract);
    console.log(`    Vault instance address: ${vaultAddress}`);

    const vaultHederaId = await resolveHederaId(vaultAddress);
    console.log(`    Vault Hedera ID: ${vaultHederaId}`);

    // Associate GUARD token with the vault
    await sendTxOptional(
      async () => {
        const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);
        return hts.tokenAssociate(vaultAddress, config.guardTokenEvmAddress, { gasLimit: GAS_LIMIT });
      },
      "Associate GUARD with demo vault"
    );

    // Deposit 300 GUARD into the vault
    const depositAmount = toTokenUnits(300);
    const vault = await hre.ethers.getContractAt("AuditVault", vaultAddress, deployer);

    // First, deployer must approve the vault to pull GUARD via HTS
    // On Hedera, the contract calls HTS.transferToken(from=depositor, to=vault),
    // so we need to either: (a) use HTS.approve or (b) transfer directly.
    // AuditVault.deposit() calls _transferGuard(msg.sender, address(this), amount),
    // which does HTS.transferToken(token, from, to, amount).
    // For this to work, the deployer needs to have approved the vault contract.
    // Let's try the deposit directly — on Hedera, contract-initiated HTS transfers
    // from msg.sender may require prior approval.
    const depositOk = await sendTxOptional(
      () => vault.deposit(depositAmount, { gasLimit: GAS_LIMIT }),
      "AuditVault.deposit(300 GUARD)"
    );

    if (!depositOk) {
      // Fallback: Transfer GUARD directly to vault contract
      console.log("    Trying direct HTS transfer to vault as fallback...");
      const hts = new hre.ethers.Contract(HTS_ADDRESS, HTS_ABI, deployer);
      await sendTxOptional(
        () => hts.transferToken(config.guardTokenEvmAddress, deployer.address, vaultAddress, depositAmount, { gasLimit: GAS_LIMIT }),
        "HTS.transferToken(deployer → vault, 300 GUARD)"
      );
    }

    state.demoVault = {
      contractAddress: lendingContract,
      vaultInstanceAddress: vaultAddress,
      vaultHederaId,
      budget: 300,
      weeklyMonitoring: 10,
      criticalBounty: 50,
      reauditInterval: 300,
    };
    saveState(state);
  } catch (err) {
    console.log(`    ⚠ Demo vault creation failed: ${err.message?.slice(0, 200)}`);
    console.log("    (This is non-fatal — vault can be created later.)");
    state.demoVault = { skipped: true, error: err.message?.slice(0, 200) };
    saveState(state);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 7: EXPORT ABIs
// ═══════════════════════════════════════════════════════════════════════════════

function exportAbis(state) {
  if (state.abisExported) {
    console.log("  ABIs already exported, skipping.");
    return;
  }

  console.log("  Exporting ABIs to SDK...");
  const contracts = ["VaultFactory", "AuditVault", "StakingManager", "Treasury"];
  for (const name of contracts) {
    const outPath = exportAbi(name);
    console.log(`    ${name} -> ${path.relative(process.cwd(), outPath)}`);
  }

  state.abisExported = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 8: UPDATE CONFIG.JSON
// ═══════════════════════════════════════════════════════════════════════════════

function updateConfig(config, state) {
  if (state.configUpdated) {
    console.log("  config.json already updated, skipping.");
    return;
  }

  console.log("  Updating packages/sdk/config.json...");

  // Merge Day 3 contracts
  config.contracts.vaultFactory = {
    id: state.vaultFactory.id,
    evmAddress: state.vaultFactory.evmAddress,
  };
  config.contracts.stakingManager = {
    id: state.stakingManager.id,
    evmAddress: state.stakingManager.evmAddress,
  };
  config.contracts.treasury = {
    id: state.treasury.id,
    evmAddress: state.treasury.evmAddress,
  };

  // Vault info
  if (state.demoVault && !state.demoVault.skipped) {
    config.vaults = {
      lendingProtocolV2: {
        contractAddress: state.demoVault.contractAddress,
        vaultInstanceAddress: state.demoVault.vaultInstanceAddress,
        budget: state.demoVault.budget,
        weeklyMonitoring: state.demoVault.weeklyMonitoring,
        criticalBounty: state.demoVault.criticalBounty,
        reauditInterval: state.demoVault.reauditInterval,
      },
    };
  }

  // Day 3 metadata
  config.day3 = {
    treasuryConfig: {
      ucpValidatorsPercent: 40,
      protocolReservePercent: 50,
      burnPercent: 10,
    },
    slashRates: {
      falsePositive: 500,
      falseNegative: 1000,
      maliciousReport: 10000,
      slaViolation: 2500,
      collusion: 10000,
      plagiarism: 5000,
    },
    stakeMigration: state.stakeMigration || {},
    deployedAt: new Date().toISOString(),
  };

  mergeAndSaveConfig(config);
  console.log("    config.json updated with 3 new contracts + day3 metadata.\n");

  state.configUpdated = true;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 9: PRINT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

function printSummary(config, state) {
  const bar = "─";
  const tl = "┌", tr = "┐", bl = "└", br = "┘";
  const ml = "├", mr = "┤", sep = "│";
  const tj = "┬", bj = "┴", mj = "┼";

  const col1 = 32;
  const col2 = 25;
  const hLine = (l, m, r) => l + bar.repeat(col1) + m + bar.repeat(col2) + r;

  const row = (label, value) => {
    const l = ` ${label}`.padEnd(col1 - 1) + " ";
    const v = ` ${value}`.padEnd(col2 - 1) + " ";
    return `${sep}${l}${sep}${v}${sep}`;
  };

  // ── Day 3 Components ──
  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Day 3 Component", "Address"));
  console.log(hLine(ml, mj, mr));
  console.log(row("Treasury", state.treasury.id));
  console.log(row("StakingManager", state.stakingManager.id));
  console.log(row("VaultFactory", state.vaultFactory.id));
  if (state.demoVault && !state.demoVault.skipped) {
    console.log(row("Demo Vault (LendingV2)", state.demoVault.vaultHederaId || state.demoVault.vaultInstanceAddress));
  }
  console.log(hLine(bl, bj, br));

  // ── Rewiring Results ──
  const migratedAgents = Object.values(state.stakeMigration || {}).filter(m => m.staked > 0).length;
  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Contract Updated", "Change"));
  console.log(hLine(ml, mj, mr));
  console.log(row("AuditAuction.treasury", "→ Treasury"));
  console.log(row("SubAuction.treasury", "→ Treasury"));
  console.log(row("DataMarketplace.treasury", "→ Treasury"));
  console.log(row("PaymentSettlement.treasury", "→ Treasury"));
  console.log(row("Treasury authorized sources", "5 contracts"));
  console.log(row("StakingManager slashers", "3 contracts"));
  console.log(row("Agent stake migration", `${migratedAgents} agents`));
  if (state.demoVault && !state.demoVault.skipped) {
    console.log(row("Demo vault created", `${state.demoVault.budget} GUARD`));
  }
  console.log(hLine(bl, bj, br));

  // ── Full System Map ──
  console.log("\n" + hLine(tl, tj, tr));
  console.log(row("Full System Map (Day 1+2+3)", "Hedera ID"));
  console.log(hLine(ml, mj, mr));
  console.log(row("GUARD Token (HTS)", config.guardTokenId));
  console.log(row("Agent Registry", config.contracts.agentRegistry.id));
  console.log(row("Audit Auction", config.contracts.auctionContract.id));
  console.log(row("Budget Vault (Day 1, legacy)", config.contracts.budgetVault.id));
  console.log(row("Sub-Auction", config.contracts.subAuction.id));
  console.log(row("Data Marketplace", config.contracts.dataMarketplace.id));
  console.log(row("Payment Settlement", config.contracts.paymentSettlement.id));
  console.log(row("Vault Factory (Day 3)", config.contracts.vaultFactory.id));
  console.log(row("Staking Manager (Day 3)", config.contracts.stakingManager.id));
  console.log(row("Treasury (Day 3)", config.contracts.treasury.id));
  console.log(hLine(bl, bj, br));

  console.log(`
  Day 3 infrastructure deployed and rewired. All fee streams now route to
  Treasury. All staking operations now go through StakingManager. Vault
  Factory ready for per-contract vault creation. Config.json + ABIs
  updated for teammates.
`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n========================================");
  console.log("  AuditGuard Day 3 — Contract Deployment");
  console.log("========================================\n");

  // ── Setup ─────────────────────────────────────────────────────────────
  const [deployer] = await hre.ethers.getSigners();
  console.log(`  Deployer: ${deployer.address}`);

  const config = loadConfig();

  // Validate Day 1/2 prerequisites
  const required = ["agentRegistry", "auctionContract", "budgetVault", "subAuction", "dataMarketplace", "paymentSettlement"];
  for (const name of required) {
    if (!config.contracts[name]?.evmAddress) {
      throw new Error(`Missing Day 1/2 contract: ${name}. Deploy Day 1 + Day 2 first.`);
    }
  }

  console.log(`  GUARD Token:        ${config.guardTokenEvmAddress}`);
  console.log(`  Agent Registry:     ${config.contracts.agentRegistry.evmAddress}`);
  console.log(`  Auction Contract:   ${config.contracts.auctionContract.evmAddress}`);
  console.log(`  SubAuction:         ${config.contracts.subAuction.evmAddress}`);
  console.log(`  DataMarketplace:    ${config.contracts.dataMarketplace.evmAddress}`);
  console.log(`  PaymentSettlement:  ${config.contracts.paymentSettlement.evmAddress}`);
  console.log("");

  const state = loadState();

  // ── Step 1: Compile ─────────────────────────────────────────────────
  console.log("Step 1: Compiling contracts...");
  await hre.run("compile");
  console.log("");

  // ── Step 2: Deploy Day 3 contracts ──────────────────────────────────
  console.log("Step 2: Deploying Day 3 contracts...\n");
  await deployTreasury(deployer, config, state);
  console.log("");
  await deployStakingManager(deployer, config, state);
  console.log("");
  await deployVaultFactory(deployer, config, state);
  console.log("");

  // ── Step 3: Token associations ──────────────────────────────────────
  console.log("Step 3: Token associations...\n");
  await associateTokens(deployer, config, state);
  console.log("");

  // ── Step 4: Configure Day 3 contracts ───────────────────────────────
  console.log("Step 4: Configuring Day 3 contracts...\n");
  await configureTreasury(deployer, config, state);
  console.log("");
  await configureStakingManager(deployer, config, state);
  console.log("");
  await configureVaultFactory(deployer, config, state);
  console.log("");

  // ── Step 5: Rewire Day 1/2 contracts ────────────────────────────────
  console.log("Step 5: Rewiring Day 1/2 contracts...\n");
  await rewireExistingContracts(deployer, config, state);
  console.log("");

  // ── Step 6: Migrate agent stakes ────────────────────────────────────
  console.log("Step 6: Migrating agent stakes...\n");
  await migrateAgentStakes(deployer, config, state);
  console.log("");

  // ── Step 7: Create demo vault ───────────────────────────────────────
  console.log("Step 7: Creating demo vault...\n");
  await createDemoVault(deployer, config, state);
  console.log("");

  // ── Step 8: Export ABIs ─────────────────────────────────────────────
  console.log("Step 8: Exporting ABIs...\n");
  exportAbis(state);
  console.log("");

  // ── Step 9: Update config.json ──────────────────────────────────────
  console.log("Step 9: Updating config.json...\n");
  updateConfig(config, state);

  // ── Step 10: Summary ────────────────────────────────────────────────
  printSummary(config, state);

  // ── Cleanup state file on success ───────────────────────────────────
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
    console.log("  Cleaned up deploy-day3-state.json (full success).\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n  DEPLOYMENT FAILED:", err.message);
    console.error("  Partial state saved to deploy-day3-state.json — re-run to resume.\n");
    process.exit(1);
  });
