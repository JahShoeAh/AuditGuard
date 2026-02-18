/**
 * Config loader for the orchestrator.
 * Reads shared deployment data from packages/sdk/config.json when present.
 * Falls back to sensible defaults so the service can run in demo mode.
 */

import { config as dotenv } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv({ path: join(__dirname, "..", "..", ".env") });

const SDK_CONFIG_PATH = join(__dirname, "..", "..", "packages", "sdk", "config.json");

function loadSdkConfig() {
  if (!existsSync(SDK_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SDK_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

const sdk = loadSdkConfig();

function getEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

export const CONFIG = {
  network: "testnet",
  hcsTopics: {
    discovery: sdk?.hcsTopics?.discovery ?? "0.0.7940144",
    auditLog: sdk?.hcsTopics?.auditLog ?? "0.0.7940145",
    agentComms: sdk?.hcsTopics?.agentComms ?? "0.0.7940146",
  },
  contracts: {
    auction: (sdk?.contracts?.auctionContract?.evmAddress ?? sdk?.contracts?.auction?.evmAddress) ?? "0x95A0A0e78a32c849526d6AC32e98c6829FB2Cd88",
    subAuction: sdk?.contracts?.subAuction?.evmAddress ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    dataMarketplace: sdk?.contracts?.dataMarketplace?.evmAddress ?? "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    paymentSettlement: sdk?.contracts?.paymentSettlement?.evmAddress ?? "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    agentRegistry: sdk?.contracts?.agentRegistry?.evmAddress ?? "0xe86218b5Bf5C21CA7a69cba04C5be0D3c2Be2303",
    budgetVault: sdk?.contracts?.budgetVault?.evmAddress ?? "0x68780A12b36f3ed04CEF937EFc38b593683c5fCd",
  },
  guardToken: {
    decimals: 8,
  },
  // Data marketplace auto-buy
  dataMarketplace: {
    maxAutoBuyGuard: 1.0, // buy cheap reports automatically
    allowedCategories: ["SCAN_REPORT", "DEPENDENCY_TREE"],
  },
  // Sub-auction defaults (used when orchestrator creates helper tasks)
  subAuction: {
    paymentGuard: 3,          // pay 3 GUARD to dependency agent
    slaSeconds: 15 * 60,      // 15 min SLA
    auctionDurationSeconds: 5 * 60,
  },
  payments: {
    baseGuard: 10,            // legacy single-settlement fallback
    bonusGuard: 0,            // optional bonus
    reportFeeGuard: 0.1,      // report fee for settlement
    totalGuard: 30,           // total pool to split across agents per job
    bonusPerCritical: 2,      // extra per critical finding
  },
  reporting: {
    autoPublishAfterFindings: 3,
    autoPublishTimeoutMs: 120_000, // fallback: auto-publish 2 min after first finding
  },
  alerts: {
    criticalThreshold: 1, // trigger alert if >= critical findings
  },
  stakes: {
    minStake: 25,   // GUARD; configurable
  },
  reputation: {
    minReputation: 0,
    premiumThreshold: 80,
  },
  timeouts: {
    winnerWaitMs: 30_000,
    findingsSlaMs: 90_000,
    pingIntervalMs: 45_000,
    livenessExpiryMs: 120_000,
  },
  demoMode: process.env.DEMO_MODE === "true",
};

export function getOperatorKeys() {
  const accountId = getEnv("OPERATOR_ACCOUNT_ID") ?? getEnv("HEDERA_ACCOUNT_ID");
  const privateKey = getEnv("OPERATOR_PRIVATE_KEY") ?? getEnv("HEDERA_PRIVATE_KEY");
  if (!accountId || !privateKey) {
    throw new Error(
      "Set OPERATOR_ACCOUNT_ID/OPERATOR_PRIVATE_KEY or HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY in .env for orchestrator"
    );
  }
  return { accountId, privateKey };
}
