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
const demoMode = process.env.DEMO_MODE === "true";
const strictLiveDefault = demoMode ? false : true;

function getEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function getPositiveIntEnv(name, fallback) {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const winnerWaitMs = getPositiveIntEnv(
  "ORCHESTRATOR_WINNER_WAIT_MS",
  getPositiveIntEnv("ORCHESTRATOR_AUCTION_DURATION_MS", 120_000)
);
const fastWinnerPathEnabled = getEnv("ORCHESTRATOR_FAST_WINNER_PATH_ENABLED") === "true";
const minAuctionDurationMs = getPositiveIntEnv("ORCHESTRATOR_MIN_AUCTION_DURATION_MS", 30_000);
const auctionDurationMs = Math.max(
  getPositiveIntEnv("ORCHESTRATOR_AUCTION_DURATION_MS", winnerWaitMs),
  minAuctionDurationMs
);
const bidFinalityGraceMs = getPositiveIntEnv(
  "ORCHESTRATOR_BID_FINALITY_GRACE_MS",
  fastWinnerPathEnabled ? 2_000 : 10_000
);
const createRetryMaxAttempts = getPositiveIntEnv("ORCHESTRATOR_CREATE_RETRY_MAX_ATTEMPTS", 6);
const createRetryBackoffMs = getPositiveIntEnv("ORCHESTRATOR_CREATE_RETRY_BACKOFF_MS", 500);
const createRetryMaxBackoffMs = getPositiveIntEnv("ORCHESTRATOR_CREATE_RETRY_MAX_BACKOFF_MS", 10_000);
const writeQueueMaxHighStreak = getPositiveIntEnv("ORCHESTRATOR_WRITE_QUEUE_MAX_HIGH_STREAK", 3);

export const CONFIG = {
  network: "testnet",
  strictLive: (process.env.STRICT_LIVE ?? String(strictLiveDefault)) === "true",
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
    auditScheduler: sdk?.contracts?.auditScheduler?.evmAddress ?? "",  // set after deploy:audit-scheduler
    treasury: sdk?.contracts?.treasury?.evmAddress ?? "",
    stakingManager: sdk?.contracts?.stakingManager?.evmAddress ?? "",
    delegatedStaking: sdk?.contracts?.delegatedStaking?.evmAddress ?? "",
    guardExchange: sdk?.contracts?.guardExchange?.evmAddress ?? "",
    hbarPool: sdk?.contracts?.hbarPool?.evmAddress ?? "",
    vaultFactory: sdk?.contracts?.vaultFactory?.evmAddress ?? "",
  },
  guardToken: {
    address: sdk?.guardTokenEvmAddress ?? "0x000000000000000000000000000000000079b9d9",
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
    auctionDurationSeconds: getPositiveIntEnv("ORCHESTRATOR_SUB_AUCTION_DURATION_SECONDS", 5 * 60),
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
    winnerWaitMs,
    auctionDurationMs,
    bidFinalityGraceMs,
    minAuctionDurationMs,
    findingsSlaMs: 90_000,
    pingIntervalMs: 45_000,
    livenessExpiryMs: 120_000,
  },
  createRetry: {
    maxAttempts: createRetryMaxAttempts,
    backoffMs: createRetryBackoffMs,
    maxBackoffMs: createRetryMaxBackoffMs,
  },
  queue: {
    writeQueueMaxHighStreak,
  },
  demoMode,
};

export function getOperatorKeys() {
  // Prefer dedicated orchestrator creds, then Hedera operator creds.
  // Keep HEDERA_* as a final fallback for older setups.
  const accountId =
    getEnv("ORCHESTRATOR_ACCOUNT_ID") ??
    getEnv("OPERATOR_ACCOUNT_ID") ??
    getEnv("HEDERA_ACCOUNT_ID");
  const privateKey =
    getEnv("ORCHESTRATOR_PRIVATE_KEY") ??
    getEnv("OPERATOR_PRIVATE_KEY") ??
    getEnv("HEDERA_PRIVATE_KEY");
  if (!accountId || !privateKey) {
    throw new Error(
      "Set ORCHESTRATOR_ACCOUNT_ID/ORCHESTRATOR_PRIVATE_KEY, HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY, or OPERATOR_ACCOUNT_ID/OPERATOR_PRIVATE_KEY in .env for orchestrator"
    );
  }
  return { accountId, privateKey };
}
