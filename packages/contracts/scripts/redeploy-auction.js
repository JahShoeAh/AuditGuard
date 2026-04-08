#!/usr/bin/env node
/**
 * redeploy-auction.js
 *
 * Deploys a new AuditAuction contract (with updateBid + RegistryCallFailed try/catch),
 * wires it to PaymentSettlement and SubAuction via setMainAuction(), associates the
 * GUARD token on HTS, and updates packages/sdk/config.json + packages/sdk/abis/.
 *
 * Run:
 *   npx hardhat run packages/contracts/scripts/redeploy-auction.js \
 *     --config packages/contracts/hardhat.config.js --network hedera_testnet
 *
 * After running:
 *   1. npm run activate:live-agents    (re-registers agents in AgentRegistry)
 *   2. npm run fund:agents             (re-tops up GUARD stakes if needed)
 *   3. Restart orchestrator + agents
 */

const hre = require("hardhat");
const path = require("path");
const fs = require("fs");

const SDK_DIR = path.resolve(__dirname, "../../sdk");
const CONFIG_PATH = path.join(SDK_DIR, "config.json");
const ABI_DIR = path.join(SDK_DIR, "abis");

const GAS_LIMIT = 5_000_000;

async function resolveHederaId(evmAddress) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(
        `https://testnet.mirrornode.hedera.com/api/v1/contracts/${evmAddress.toLowerCase()}`
      );
      const data = await res.json();
      if (data.contract_id) return data.contract_id;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "unknown";
}

async function sendTx(fn, label) {
  console.log(`  → ${label}...`);
  const tx = await fn();
  const receipt = await tx.wait();
  if (receipt.status === 0) throw new Error(`${label}: tx reverted (hash=${receipt.hash})`);
  console.log(`    ✓ ${label} (${receipt.hash})`);
  return receipt;
}

async function main() {
  await hre.run("compile", { quiet: true });

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:         ", deployer.address);
  console.log("Guard token:      ", config.guardTokenEvmAddress);
  console.log("AgentRegistry:    ", config.contracts.agentRegistry.evmAddress);
  console.log("PaymentSettlement:", config.contracts.paymentSettlement.evmAddress);
  console.log("SubAuction:       ", config.contracts.subAuction.evmAddress);
  console.log("Treasury:         ", config.contracts.treasury.evmAddress);
  console.log("Old AuditAuction: ", config.contracts.auctionContract.evmAddress);
  console.log();

  // ── 1. Deploy new AuditAuction ──────────────────────────────────────────────
  console.log("Deploying AuditAuction...");
  const factory = await hre.ethers.getContractFactory("AuditAuction", deployer);
  const auction = await factory.deploy(
    config.guardTokenEvmAddress,
    config.contracts.agentRegistry.evmAddress,
    deployer.address,   // orchestrator = deployer EOA (matches original)
    config.contracts.treasury.evmAddress,
    { gasLimit: GAS_LIMIT }
  );
  await auction.waitForDeployment();
  const newEvmAddress = await auction.getAddress();
  console.log("New EVM address:  ", newEvmAddress);

  // ── 2. Associate GUARD token on HTS (Hedera precompile) ────────────────────
  console.log("\nAssociating GUARD token on HTS...");
  try {
    await sendTx(
      () => auction.associateGuardToken({ gasLimit: 300_000 }),
      "AuditAuction.associateGuardToken()"
    );
  } catch (e) {
    // Non-fatal: already associated or precompile not available in local fork.
    console.warn("  ⚠  associateGuardToken failed (may already be associated):", e.message);
  }

  // ── 3. Wire PaymentSettlement → new AuditAuction ───────────────────────────
  console.log("\nWiring PaymentSettlement.setMainAuction()...");
  const psAbi = JSON.parse(
    fs.readFileSync(path.join(ABI_DIR, "PaymentSettlement.json"), "utf8")
  ).abi;
  const ps = new hre.ethers.Contract(
    config.contracts.paymentSettlement.evmAddress,
    psAbi,
    deployer
  );
  await sendTx(
    () => ps.setMainAuction(newEvmAddress, { gasLimit: 200_000 }),
    "PaymentSettlement.setMainAuction()"
  );

  // ── 4. Wire SubAuction → new AuditAuction ──────────────────────────────────
  console.log("\nWiring SubAuction.setMainAuction()...");
  const saAbi = JSON.parse(
    fs.readFileSync(path.join(ABI_DIR, "SubAuction.json"), "utf8")
  ).abi;
  const subAuction = new hre.ethers.Contract(
    config.contracts.subAuction.evmAddress,
    saAbi,
    deployer
  );
  await sendTx(
    () => subAuction.setMainAuction(newEvmAddress, { gasLimit: 200_000 }),
    "SubAuction.setMainAuction()"
  );

  // ── 5. Resolve Hedera contract ID ──────────────────────────────────────────
  console.log("\nResolving Hedera ID (mirror node, up to ~24s)...");
  const hederaId = await resolveHederaId(newEvmAddress);
  console.log("Hedera ID:", hederaId);

  // ── 6. Update config.json ──────────────────────────────────────────────────
  const oldAddr = config.contracts.auctionContract?.evmAddress ?? "none";
  config.contracts.auctionContract = { id: hederaId, evmAddress: newEvmAddress };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\nconfig.json updated: ${oldAddr} → ${newEvmAddress}`);

  // ── 7. Export ABI ──────────────────────────────────────────────────────────
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/AuditAuction.sol/AuditAuction.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiOut = {
    contractName: artifact.contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  };
  fs.writeFileSync(path.join(ABI_DIR, "AuditAuction.json"), JSON.stringify(abiOut, null, 2));
  console.log("ABI exported to packages/sdk/abis/AuditAuction.json");

  console.log(`
Done.

Next steps:
  1. npm run activate:live-agents   # re-registers agents (stakes + activation)
  2. npm run fund:agents            # top-up GUARD stakes if needed
  3. Restart orchestrator + agents  # pick up new AuditAuction address

Note: AgentRegistry still points to the old AuditAuction address for
onlyOrchestratorOrAuction checks. recordJobCompletion / slashAgent calls
from the new contract will emit RegistryCallFailed events instead of
reverting (try/catch). The orchestrator (already authorized as the
'orchestrator' address in AgentRegistry) can call updateReputation directly.
`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
