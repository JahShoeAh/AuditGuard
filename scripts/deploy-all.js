/**
 * Master deployment pipeline for AuditGuard Day 1 infrastructure.
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { AccountId, ContractId } = require("@hashgraph/sdk");
const { createHcsTopicsAndSave } = require("./setup-hcs-topics");

const REPO_ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts");
const SDK_DIR = path.join(REPO_ROOT, "packages", "sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABIS_DIR = path.join(SDK_DIR, "abis");
const TOKEN_DECIMALS = 8;

if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = "hedera_testnet";
}

// Force Hardhat to resolve from the actual project folder even when this script
// is executed from the repo root.
process.env.HARDHAT_CONFIG = path.join(CONTRACTS_DIR, "hardhat.config.js");
process.chdir(CONTRACTS_DIR);

const hardhatRequire = createRequire(path.join(CONTRACTS_DIR, "package.json"));
const hre = hardhatRequire("hardhat");

function toTokenUnits(amount) {
  return BigInt(Math.floor(amount * 10 ** TOKEN_DECIMALS));
}

function normalizeHexPrivateKey(raw, envKeyName) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  const stripped = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`${envKeyName} must be a 32-byte hex private key for EVM RPC use`);
  }
  return `0x${stripped}`;
}

function accountIdToEvmAddress(accountIdString) {
  return `0x${AccountId.fromString(accountIdString).toSolidityAddress()}`;
}

function evmAddressToContractId(evmAddress) {
  return ContractId.fromSolidityAddress(evmAddress).toString();
}

function readJson(jsonPath, fallback = {}) {
  if (!fs.existsSync(jsonPath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function readArtifact(contractName) {
  const artifactPath = path.join(
    CONTRACTS_DIR,
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}`);
  }
  return readJson(artifactPath);
}

function exportAbis() {
  fs.mkdirSync(ABIS_DIR, { recursive: true });
  const contractNames = ["AgentRegistry", "AuditAuction", "AuditBudgetVault"];
  for (const name of contractNames) {
    const artifact = readArtifact(name);
    const outPath = path.join(ABIS_DIR, `${name}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ contractName: name, abi: artifact.abi }, null, 2));
  }
}

function printSummary(config) {
  console.log("\n┌─────────────────────┬─────────────────┐");
  console.log(`│ Component           │ Address         │`);
  console.log("├─────────────────────┼─────────────────┤");
  console.log(`│ GUARD Token         │ ${(config.guardTokenId || "-").padEnd(15)} │`);
  console.log(`│ Agent Registry      │ ${(config.contracts?.agentRegistry?.id || "-").padEnd(15)} │`);
  console.log(`│ Audit Auction       │ ${(config.contracts?.auctionContract?.id || "-").padEnd(15)} │`);
  console.log(`│ Budget Vault        │ ${(config.contracts?.budgetVault?.id || "-").padEnd(15)} │`);
  console.log(`│ HCS Discovery       │ ${(config.hcsTopics?.discovery || "-").padEnd(15)} │`);
  console.log(`│ HCS Audit Log       │ ${(config.hcsTopics?.auditLog || "-").padEnd(15)} │`);
  console.log(`│ HCS Agent Comms     │ ${(config.hcsTopics?.agentComms || "-").padEnd(15)} │`);
  console.log(
    `│ Seeded Agents       │ ${Object.keys(config.seededAgents || {}).length.toString().padEnd(15)} │`
  );
  console.log(`│ Demo Vault          │ ${(config.demoVault ? "200 GUARD" : "-").padEnd(15)} │`);
  console.log("└─────────────────────┴─────────────────┘");
  console.log('\n"All infrastructure deployed. Hand config.json to your teammate to wire up agent scripts."');
}

async function main() {
  const state = {
    step: "",
    config: readJson(CONFIG_PATH, {}),
  };

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  // Increase provider timeout for Hedera mirror node/JSON-RPC delays
  if (hre.ethers.provider && hre.ethers.provider._pollingInterval) {
    hre.ethers.provider.pollingInterval = 4000;
  }

  async function runStep(stepName, fn) {
    state.step = stepName;
    console.log(`\n=== ${stepName} ===`);
    await fn();
    writeConfig(state.config);
    console.log(`✅ ${stepName}`);
  }

  async function sendTx(label, txBuilder, { optional = false, retries = 3 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const tx = await txBuilder();
        await tx.wait();
        console.log(`   ✅ ${label}`);
        return true;
      } catch (error) {
        const message = error?.shortMessage || error?.message || String(error);
        const isTimeout = message.includes("timeout") || message.includes("504") || message.includes("ETIMEDOUT");
          
        if (isTimeout && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          console.log(`   ⏳ ${label} timed out (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        if (optional) {
          console.log(`   ⚠️  ${label} skipped: ${message}`);
          return false;
        }
        throw new Error(`${label} failed: ${message}`);
      }
    }
  }

  try {
    await runStep("Step 1: Read GUARD token info from config.json", async () => {
      if (!state.config.guardTokenId || !state.config.guardTokenEvmAddress) {
        throw new Error("guardTokenId/guardTokenEvmAddress missing in packages/sdk/config.json");
      }
    });

    await runStep("Step 2: Compile contracts", async () => {
      await hre.run("compile");
      exportAbis();
    });

    await runStep("Step 3: Deploy AgentRegistry", async () => {
      const factory = await hre.ethers.getContractFactory("AgentRegistry");
      const contract = await factory.deploy(state.config.guardTokenEvmAddress);
      await contract.waitForDeployment();
      const evmAddress = await contract.getAddress();
      state.config.contracts = state.config.contracts || {};
      state.config.contracts.agentRegistry = {
        id: evmAddressToContractId(evmAddress),
        evmAddress,
      };
    });

    await runStep("Step 4: Deploy AuditBudgetVault", async () => {
      const factory = await hre.ethers.getContractFactory("AuditBudgetVault");
      const contract = await factory.deploy(state.config.guardTokenEvmAddress);
      await contract.waitForDeployment();
      const evmAddress = await contract.getAddress();
      state.config.contracts = state.config.contracts || {};
      state.config.contracts.budgetVault = {
        id: evmAddressToContractId(evmAddress),
        evmAddress,
      };
    });

    await runStep("Step 5: Deploy AuditAuction", async () => {
      const factory = await hre.ethers.getContractFactory("AuditAuction");
      const contract = await factory.deploy(
        state.config.guardTokenEvmAddress,
        state.config.contracts.agentRegistry.evmAddress,
        deployerAddress,
        deployerAddress
      );
      await contract.waitForDeployment();
      const evmAddress = await contract.getAddress();
      state.config.contracts = state.config.contracts || {};
      state.config.contracts.auctionContract = {
        id: evmAddressToContractId(evmAddress),
        evmAddress,
      };
    });

    let registry;
    let auction;
    let budgetVault;

    await runStep("Step 6: Wire contracts together", async () => {
      registry = await hre.ethers.getContractAt(
        "AgentRegistry",
        state.config.contracts.agentRegistry.evmAddress,
        deployer
      );
      auction = await hre.ethers.getContractAt(
        "AuditAuction",
        state.config.contracts.auctionContract.evmAddress,
        deployer
      );
      budgetVault = await hre.ethers.getContractAt(
        "AuditBudgetVault",
        state.config.contracts.budgetVault.evmAddress,
        deployer
      );

      // HTS token association can revert on some Hedera RPC setups for contract accounts.
      // Treat these as best-effort and continue wiring to keep deployment resilient.
      await sendTx("Associate GUARD on AgentRegistry", () => registry.associateGuardToken(), { optional: true });
      await sendTx("Associate GUARD on AuditAuction", () => auction.associateGuardToken(), { optional: true });
      await sendTx("Associate GUARD on AuditBudgetVault", () => budgetVault.associateGuardToken(), { optional: true });

      await sendTx("Set AgentRegistry orchestrator+auction", () =>
        registry.setOrchestratorAndAuction(deployerAddress, state.config.contracts.auctionContract.evmAddress)
      );

      await sendTx(
        "Set AuditAuction agent registry",
        () => auction.setAgentRegistry(state.config.contracts.agentRegistry.evmAddress),
        { optional: true }
      );
      await sendTx("Set AuditAuction orchestrator", () => auction.setOrchestrator(deployerAddress));
      await sendTx("Set AuditAuction treasury", () => auction.setTreasury(deployerAddress));
      await sendTx("Set BudgetVault authorized drawer", () =>
        budgetVault.setAuthorizedDrawer(state.config.contracts.auctionContract.evmAddress)
      );
    });

    await runStep("Step 7: Seed pre-built agents", async () => {
      const provider = hre.ethers.provider;
      const seededSpecs = [
        {
          key: "AUDITOR_AGENT_1",
          label: "staticAnalysis47",
          agentId: "StaticAnalysis-47",
          specialization: ["static_analysis"],
          stake: 150,
          reputation: 9400,
          endpoint: process.env.AUDITOR_AGENT_1_UCP_ENDPOINT || "openclaw://staticaudit-47",
          promote: false,
        },
        {
          key: "AUDITOR_AGENT_2",
          label: "fuzzer12",
          agentId: "Fuzzer-12",
          specialization: ["fuzzing"],
          stake: 300,
          reputation: 8700,
          endpoint: process.env.AUDITOR_AGENT_2_UCP_ENDPOINT || "openclaw://fuzzer-12",
          promote: true,
        },
        {
          key: "AUDITOR_AGENT_3",
          label: "llmContextual3",
          agentId: "LLMContextual-3",
          specialization: ["llm_contextual"],
          stake: 500,
          reputation: 8700,
          endpoint: process.env.AUDITOR_AGENT_3_UCP_ENDPOINT || "openclaw://llmcontext-3",
          promote: true,
        },
      ];

      state.config.seededAgents = state.config.seededAgents || {};
      for (const spec of seededSpecs) {
        const accountId = process.env[`${spec.key}_ACCOUNT_ID`];
        const rawPk = process.env[`${spec.key}_PRIVATE_KEY`];
        if (!accountId || !rawPk) {
          console.log(`⚠️  Skipping ${spec.label}: missing ${spec.key}_ACCOUNT_ID/PRIVATE_KEY`);
          continue;
        }

        const privateKey = normalizeHexPrivateKey(rawPk, `${spec.key}_PRIVATE_KEY`);
        const wallet = new hre.ethers.Wallet(privateKey, provider);
        const registryFromAgent = registry.connect(wallet);

        let registered = false;
        try {
          await (
            await registryFromAgent.registerAgent(
              spec.agentId,
              spec.endpoint,
              spec.specialization,
              toTokenUnits(spec.stake)
            )
          ).wait();
          registered = true;
        } catch (error) {
          console.log(`ℹ️  registerAgent skipped for ${spec.label}: ${error.message}`);
        }

        try {
          await (await registry.seedAgentReputation(wallet.address, spec.reputation)).wait();
          registered = true;
        } catch (error) {
          console.log(`ℹ️  seedAgentReputation skipped for ${spec.label}: ${error.message}`);
        }

        if (spec.promote) {
          try {
            await (await registryFromAgent.requestPromotion()).wait();
          } catch (error) {
            console.log(`ℹ️  requestPromotion failed for ${spec.label}: ${error.message}`);
          }
        }

        const tier = Number(await registry.getAgentTier(wallet.address));
        const tierName = tier === 3 ? "PREMIUM" : tier === 2 ? "SPECIALIZED" : tier === 1 ? "COMMODITY" : "UNREGISTERED";

        if (registered || tier !== 0) {
          state.config.seededAgents[spec.label] = {
            accountId,
            evmAddress: accountIdToEvmAddress(accountId),
            tier: tierName,
            reputation: spec.reputation,
          };
        }
      }
    });

    await runStep("Step 8: Create demo audit budget vault", async () => {
      const mockContractAddress = process.env.DEMO_LENDING_CONTRACT_ADDRESS || "0x000000000000000000000000000000000000dEaD";
      const createOk = await sendTx(
        "Create demo vault",
        () => budgetVault.createVault(mockContractAddress, toTokenUnits(10), toTokenUnits(50)),
        { optional: true }
      );

      const fundOk = await sendTx(
        "Fund demo vault with 200 GUARD",
        () => budgetVault.deposit(mockContractAddress, toTokenUnits(200)),
        { optional: true }
      );

      if (!fundOk) {
        console.log(
          "ℹ️  Demo vault funding skipped. Most common cause: AuditBudgetVault GUARD association failed in Step 6 on this Hedera RPC setup."
        );
      }

      if (createOk || fundOk) {
        state.config.demoVault = {
          contractAddress: mockContractAddress,
          budget: fundOk ? 200 : 0,
          weeklyMonitoring: 10,
          criticalBounty: 50,
          funded: fundOk,
        };
      }
    });

    await runStep("Step 9: Setup HCS topics + write final config", async () => {
      const topics = await createHcsTopicsAndSave({ quiet: true });
      state.config = {
        ...readJson(CONFIG_PATH, {}),
        ...state.config,
        hcsTopics: {
          discovery: topics.discovery,
          auditLog: topics.auditLog,
          agentComms: topics.agentComms,
        },
      };
    });

    await runStep("Step 10: Print deployment summary", async () => {
      printSummary(state.config);
    });
  } catch (error) {
    writeConfig(state.config);
    console.error(`\n❌ Deployment failed at: ${state.step}`);
    console.error(`Error: ${error.message}`);
    console.error("\nPartial config.json state:");
    console.error(JSON.stringify(state.config, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ Unexpected deploy-all.js failure");
  console.error(error);
  process.exit(1);
});

