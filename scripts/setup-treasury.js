#!/usr/bin/env node
/**
 * setup-treasury.js
 *
 * One-time setup for the Treasury contract:
 *   1. Adds PaymentSettlement and DataMarketplace as authorised fee sources.
 *   2. Sets StakingManager reference so Treasury can read agent discount eligibility.
 *   3. Sets AgentRegistry reference on Treasury.
 *
 * Usage (from repo root):
 *   node scripts/setup-treasury.js
 *
 * Required env vars (from .env):
 *   OPERATOR_PRIVATE_KEY (or ORCHESTRATOR_PRIVATE_KEY)
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as dotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: join(__dirname, "..", ".env") });

const SDK_CONFIG = JSON.parse(readFileSync(join(__dirname, "..", "packages", "sdk", "config.json"), "utf-8"));
const ABI_DIR = join(__dirname, "..", "packages", "sdk", "abis");

function loadABI(name) {
  const raw = JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf-8"));
  return raw.abi || raw;
}

const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };
const DEFAULT_RPC = "https://testnet.hashio.io/api";
const HEDERA_LEGACY_GAS_PRICE = BigInt(process.env.HEDERA_LEGACY_GAS_PRICE ?? "1111000000000");

function getKey() {
  const raw =
    process.env.ORCHESTRATOR_PRIVATE_KEY ??
    process.env.OPERATOR_PRIVATE_KEY ??
    process.env.HEDERA_PRIVATE_KEY;
  if (!raw) throw new Error("Set ORCHESTRATOR_PRIVATE_KEY or OPERATOR_PRIVATE_KEY in .env");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function sendTx(label, txPromise) {
  console.log(`  ${label}…`);
  const tx = await txPromise;
  console.log(`    tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`    confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  const rpcUrl = process.env.HEDERA_JSON_RPC_URL ?? DEFAULT_RPC;
  const provider = new ethers.JsonRpcProvider(rpcUrl, HEDERA_NETWORK, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
  provider.getFeeData = async () => ({
    gasPrice: HEDERA_LEGACY_GAS_PRICE,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  });

  const wallet = new ethers.NonceManager(new ethers.Wallet(getKey(), provider));

  const treasuryAddr  = SDK_CONFIG.contracts.treasury?.evmAddress;
  const paySettleAddr = SDK_CONFIG.contracts.paymentSettlement?.evmAddress;
  const mktplaceAddr  = SDK_CONFIG.contracts.dataMarketplace?.evmAddress;
  const smAddr        = SDK_CONFIG.contracts.stakingManager?.evmAddress;
  const agentRegAddr  = SDK_CONFIG.contracts.agentRegistry?.evmAddress;

  for (const [label, addr] of [
    ["treasury", treasuryAddr],
    ["paymentSettlement", paySettleAddr],
    ["dataMarketplace", mktplaceAddr],
    ["stakingManager", smAddr],
    ["agentRegistry", agentRegAddr],
  ]) {
    if (!addr || !ethers.isAddress(addr)) throw new Error(`${label} address missing from config.json`);
  }

  const treasury = new ethers.Contract(treasuryAddr, loadABI("Treasury"), wallet);

  console.log(`Treasury at ${treasuryAddr}`);

  // 1. Authorise fee sources
  for (const [name, addr] of [
    ["PaymentSettlement", paySettleAddr],
    ["DataMarketplace",   mktplaceAddr],
  ]) {
    const already = await treasury.authorizedSources(addr);
    if (already) {
      console.log(`  ✓ ${name} (${addr}) already authorised`);
    } else {
      await sendTx(`addAuthorizedSource(${name})`, treasury.addAuthorizedSource(addr));
      console.log(`  ✓ ${name} authorised`);
    }
  }

  // 2. Set StakingManager reference
  const currentSM = await treasury.stakingManager();
  if (currentSM.toLowerCase() === smAddr.toLowerCase()) {
    console.log(`  ✓ StakingManager already set (${currentSM})`);
  } else {
    await sendTx("setStakingManager", treasury.setStakingManager(smAddr));
    console.log(`  ✓ StakingManager set to ${smAddr}`);
  }

  // 3. Set AgentRegistry reference
  const currentAR = await treasury.agentRegistry();
  if (currentAR.toLowerCase() === agentRegAddr.toLowerCase()) {
    console.log(`  ✓ AgentRegistry already set (${currentAR})`);
  } else {
    await sendTx("setAgentRegistry", treasury.setAgentRegistry(agentRegAddr));
    console.log(`  ✓ AgentRegistry set to ${agentRegAddr}`);
  }

  console.log("\n✓ Treasury setup complete.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
