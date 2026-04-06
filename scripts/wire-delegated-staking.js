#!/usr/bin/env node
/**
 * wire-delegated-staking.js
 *
 * One-time setup: tells DelegatedStaking which address is authorised to call
 * propagateSlash(). The orchestrator's EVM address fulfils this role because
 * the deployed StakingManager predates its setDelegatedStaking() function and
 * cannot call propagateSlash() on its own.
 *
 * Usage (from repo root):
 *   node scripts/wire-delegated-staking.js
 *
 * Required env vars (from .env):
 *   OPERATOR_PRIVATE_KEY (or ORCHESTRATOR_PRIVATE_KEY)
 *   HEDERA_JSON_RPC_URL  (optional; defaults to hashio testnet)
 */

import { ethers } from "ethers";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as dotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: join(__dirname, "..", ".env") });

const _require = createRequire(import.meta.url);
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
  const orchestratorAddress = wallet.address ?? (await wallet.getAddress());

  const dsAddress = SDK_CONFIG.contracts.delegatedStaking?.evmAddress;
  if (!dsAddress || !ethers.isAddress(dsAddress)) {
    throw new Error("DelegatedStaking address not found in packages/sdk/config.json");
  }

  const smAddress = SDK_CONFIG.contracts.stakingManager?.evmAddress;
  if (!smAddress || !ethers.isAddress(smAddress)) {
    throw new Error("StakingManager address not found in packages/sdk/config.json");
  }

  const ds = new ethers.Contract(dsAddress, loadABI("DelegatedStaking"), wallet);

  // Check current staking manager in DelegatedStaking
  let currentSM;
  try {
    currentSM = await ds.stakingManager();
  } catch {
    currentSM = ethers.ZeroAddress;
  }
  console.log(`DelegatedStaking (${dsAddress})`);
  console.log(`  current stakingManager : ${currentSM}`);
  console.log(`  orchestrator address   : ${orchestratorAddress}`);

  if (currentSM.toLowerCase() === orchestratorAddress.toLowerCase()) {
    console.log("✓ Already wired — no action needed.");
    return;
  }

  console.log("\nCalling DelegatedStaking.setStakingManager(orchestratorAddress)…");
  const tx = await ds.setStakingManager(orchestratorAddress);
  console.log(`  tx submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt.blockNumber}`);

  // Verify
  const newSM = await ds.stakingManager();
  if (newSM.toLowerCase() !== orchestratorAddress.toLowerCase()) {
    throw new Error(`Unexpected stakingManager after tx: ${newSM}`);
  }
  console.log("✓ DelegatedStaking now accepts propagateSlash from orchestrator.");
  console.log("\nOptional next step:");
  console.log("  If the deployed StakingManager supports setDelegatedStaking(), run:");
  console.log(`  await stakingManager.setDelegatedStaking("${dsAddress}")`);
  console.log("  This would make StakingManager auto-propagate slashes without the orchestrator relay.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
