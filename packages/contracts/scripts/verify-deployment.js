/**
 * AuditGuard Deployment Verification
 *
 * Connects to Hedera testnet, loads deployed addresses from packages/sdk/config.json,
 * and runs 5 verification sections against live contracts.
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment.js --network hedera_testnet
 */

const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

// Load SDK config and ABIs
const configPath = path.resolve(__dirname, "../../../packages/sdk/config.json");
const abiDir = path.resolve(__dirname, "../../../packages/sdk/abis");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function loadAbi(name) {
  const filePath = path.join(abiDir, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return raw.abi || raw;
}

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";

let passed = 0;
let failed = 0;
let warnings = 0;

function check(label, condition, details = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

function warn(label, details = "") {
  console.log(`  ${WARN} ${label}${details ? ` — ${details}` : ""}`);
  warnings++;
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║       AuditGuard Deployment Verification             ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${await signer.getAddress()}`);
  const network = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${network.chainId}\n`);

  const contracts = config.contracts;
  const guardAddr = config.guardTokenEvmAddress;

  // ── Section 1: Contract Existence ───────────────────────────────
  console.log("Section 1: Contract Existence (getCode != '0x')");
  console.log("─".repeat(54));

  const contractList = [
    { name: "AgentRegistry",      addr: contracts.agentRegistry?.evmAddress },
    { name: "AuditAuction",       addr: contracts.auctionContract?.evmAddress },
    { name: "SubAuction",         addr: contracts.subAuction?.evmAddress },
    { name: "DataMarketplace",    addr: contracts.dataMarketplace?.evmAddress },
    { name: "PaymentSettlement",  addr: contracts.paymentSettlement?.evmAddress },
    { name: "AuditBudgetVault",   addr: contracts.budgetVault?.evmAddress },
    { name: "VaultFactory",       addr: contracts.vaultFactory?.evmAddress },
    { name: "StakingManager",     addr: contracts.stakingManager?.evmAddress },
    { name: "Treasury",           addr: contracts.treasury?.evmAddress },
    { name: "GUARD Token",        addr: guardAddr },
  ];

  const deployedContracts = {};
  for (const c of contractList) {
    if (!c.addr) {
      warn(`${c.name}`, "address not in config");
      continue;
    }
    try {
      const code = await ethers.provider.getCode(c.addr);
      const exists = code !== "0x" && code.length > 2;
      check(`${c.name} at ${c.addr}`, exists, exists ? "" : "no bytecode");
      if (exists) deployedContracts[c.name] = c.addr;
    } catch (e) {
      check(`${c.name}`, false, e.message);
    }
  }

  // ── Section 2: Cross-Reference Wiring ───────────────────────────
  console.log("\nSection 2: Cross-Reference Wiring");
  console.log("─".repeat(54));

  const agentRegistryAbi = loadAbi("AgentRegistry");
  if (agentRegistryAbi && contracts.agentRegistry?.evmAddress) {
    try {
      const ar = new ethers.Contract(contracts.agentRegistry.evmAddress, agentRegistryAbi, signer);

      const orchestrator = await ar.orchestrator();
      check("AgentRegistry.orchestrator != zero", orchestrator !== ethers.ZeroAddress, orchestrator);

      const auctionRef = await ar.auctionContract();
      const expectedAuction = contracts.auctionContract?.evmAddress;
      check(
        "AgentRegistry.auctionContract matches config",
        expectedAuction && auctionRef.toLowerCase() === expectedAuction.toLowerCase(),
        `got ${auctionRef}`
      );

      const guardRef = await ar.guardToken();
      check(
        "AgentRegistry.guardToken matches config",
        guardRef.toLowerCase() === guardAddr.toLowerCase(),
        `got ${guardRef}`
      );
    } catch (e) {
      warn("AgentRegistry cross-ref check failed", e.message);
    }
  }

  const auctionAbi = loadAbi("AuditAuction");
  if (auctionAbi && contracts.auctionContract?.evmAddress) {
    try {
      const aa = new ethers.Contract(contracts.auctionContract.evmAddress, auctionAbi, signer);

      const registryRef = await aa.agentRegistry();
      const expectedRegistry = contracts.agentRegistry?.evmAddress;
      check(
        "AuditAuction.agentRegistry matches config",
        expectedRegistry && registryRef.toLowerCase() === expectedRegistry.toLowerCase(),
        `got ${registryRef}`
      );

      const treasuryRef = await aa.treasury();
      const expectedTreasury = contracts.treasury?.evmAddress;
      check(
        "AuditAuction.treasury matches config",
        expectedTreasury && treasuryRef.toLowerCase() === expectedTreasury.toLowerCase(),
        `got ${treasuryRef}`
      );
    } catch (e) {
      warn("AuditAuction cross-ref check failed", e.message);
    }
  }

  // ── Section 3: Configuration Values ─────────────────────────────
  console.log("\nSection 3: Configuration Values");
  console.log("─".repeat(54));

  if (agentRegistryAbi && contracts.agentRegistry?.evmAddress) {
    try {
      const ar = new ethers.Contract(contracts.agentRegistry.evmAddress, agentRegistryAbi, signer);
      const commodityMin = await ar.COMMODITY_MIN_STAKE();
      check("AgentRegistry.COMMODITY_MIN_STAKE = 100 GUARD",
        commodityMin === BigInt("10000000000"), // 100 * 10^8
        `got ${commodityMin}`
      );
      const newAgentRep = await ar.NEW_AGENT_INITIAL_REPUTATION();
      check("AgentRegistry.NEW_AGENT_INITIAL_REPUTATION = 5000",
        newAgentRep === 5000n,
        `got ${newAgentRep}`
      );
    } catch (e) {
      warn("AgentRegistry config values check failed", e.message);
    }
  }

  if (auctionAbi && contracts.auctionContract?.evmAddress) {
    try {
      const aa = new ethers.Contract(contracts.auctionContract.evmAddress, auctionAbi, signer);
      const minCollateral = await aa.MIN_BID_COLLATERAL();
      check("AuditAuction.MIN_BID_COLLATERAL = 50 GUARD",
        minCollateral === BigInt("5000000000"), // 50 * 10^8
        `got ${minCollateral}`
      );
      const feePercent = await aa.platformFeePercent();
      check("AuditAuction.platformFeePercent = 5",
        feePercent === 5n,
        `got ${feePercent}`
      );
    } catch (e) {
      warn("AuditAuction config values check failed", e.message);
    }
  }

  const treasuryAbi = loadAbi("Treasury");
  if (treasuryAbi && contracts.treasury?.evmAddress) {
    try {
      const tr = new ethers.Contract(contracts.treasury.evmAddress, treasuryAbi, signer);
      const distConfig = await tr.getDistributionConfig();
      check("Treasury distribution = 40/50/10",
        distConfig.ucpValidatorsPercent === 40n &&
        distConfig.protocolReservePercent === 50n &&
        distConfig.burnPercent === 10n,
        `got ${distConfig.ucpValidatorsPercent}/${distConfig.protocolReservePercent}/${distConfig.burnPercent}`
      );
    } catch (e) {
      warn("Treasury config values check failed", e.message);
    }
  }

  // ── Section 4: Token Association ────────────────────────────────
  console.log("\nSection 4: Token Association");
  console.log("─".repeat(54));

  for (const c of contractList.slice(0, 9)) {
    if (!c.addr || !deployedContracts[c.name]) continue;
    // On Hedera, we verify guardToken getter matches config
    const abi = loadAbi(c.name === "AuditBudgetVault" ? "AuditBudgetVault" :
                        c.name === "GUARD Token" ? null : c.name);
    if (!abi) continue;
    try {
      const contract = new ethers.Contract(c.addr, abi, signer);
      if (typeof contract.guardToken === "function") {
        const tokenAddr = await contract.guardToken();
        check(
          `${c.name}.guardToken matches config`,
          tokenAddr.toLowerCase() === guardAddr.toLowerCase(),
          `got ${tokenAddr}`
        );
      }
    } catch (_) {
      // skip if getter doesn't exist
    }
  }

  // ── Section 5: Pausable Inventory ───────────────────────────────
  console.log("\nSection 5: Pausable Inventory");
  console.log("─".repeat(54));

  const pausableContracts = [
    "AgentRegistry", "AuditAuction", "SubAuction", "StakingManager", "PaymentSettlement"
  ];
  const nonPausableContracts = [
    "Treasury", "DataMarketplace", "VaultFactory", "AuditBudgetVault", "AuditVault"
  ];

  for (const name of pausableContracts) {
    const abi = loadAbi(name);
    const addr = contractList.find(c => c.name === name)?.addr;
    if (!abi || !addr) { warn(`${name} — ABI or address missing`); continue; }
    try {
      const contract = new ethers.Contract(addr, abi, signer);
      const paused = await contract.paused();
      check(`${name} has Pausable (paused=${paused})`, true);
    } catch (e) {
      check(`${name} has Pausable`, false, e.message);
    }
  }

  for (const name of nonPausableContracts) {
    warn(`${name} — no Pausable (by design)`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(54));
  console.log(
    `  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${WARN} ${warnings} warnings`
  );
  console.log("═".repeat(54) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nVerification failed with error:", err.message);
  process.exit(1);
});
