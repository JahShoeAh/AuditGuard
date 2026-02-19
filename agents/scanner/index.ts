import {
  HCSClient,
  ContractClient,
  ListingCategory,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  randomInt,
  randomChoice,
  randomHex,
  hashOf,
  sleep,
} from "../shared/index.js";
import type { ContractType } from "../shared/types.js";
import { ethers } from "ethers";

// ---- Config ----
const AGENT_ID = "scanner-001";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
const SCAN_INTERVAL_MS = DEMO_MODE ? 30 * 1000 : 300 * 1000; // 30s demo, 5m prod
const HOT_LEAD_RISK_THRESHOLD = 80;
const HOT_LEAD_PRICE = ethers.parseUnits("0.1", 8);   // 0.1 GUARD
const HOT_LEAD_DELAY_MS = DEMO_MODE ? 10 * 1000 : 60 * 1000; // delay before public
const DEFAULT_DISCOVERY_BUDGET_GUARD = Number(process.env.DEFAULT_DISCOVERY_BUDGET_GUARD ?? "100");

const log = createAgentLogger(AGENT_ID, "scanner");

// ---- Discovery Generator ----

export function generateDiscovery() {
  const types: ContractType[] = ["lending", "dex", "staking", "bridge", "vault"];
  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress: `0x${randomHex(20)}`,
      chain: "hedera-testnet",
      deployerAddress: `0x${randomHex(20)}`,
      estimatedLOC: randomInt(500, 10000),
      contractType: randomChoice(types),
      riskScore: randomInt(20, 95),
      budget: DEFAULT_DISCOVERY_BUDGET_GUARD,
      txHash: `0x${randomHex(64)}`,
    },
  };
}

function validateDiscoveryPayload(payload: {
  contractAddress: string;
  estimatedLOC: number;
  riskScore: number;
  budget: number;
}) {
  if (!ethers.isAddress(payload.contractAddress)) {
    throw new Error(`invalid contractAddress: ${payload.contractAddress}`);
  }
  if (!Number.isInteger(payload.estimatedLOC) || payload.estimatedLOC <= 0) {
    throw new Error(`invalid estimatedLOC: ${payload.estimatedLOC}`);
  }
  if (!Number.isInteger(payload.riskScore) || payload.riskScore < 0 || payload.riskScore > 100) {
    throw new Error(`invalid riskScore: ${payload.riskScore}`);
  }
  if (typeof payload.budget !== "number" || !Number.isFinite(payload.budget) || payload.budget <= 0) {
    throw new Error(`invalid budget: ${payload.budget}`);
  }
}

// ---- Main ----

async function main() {
  log.info("Scanner Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");

  const wallet = createAgentWallet("SCANNER");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);

  log.info(`Wallet: ${wallet.evmAddress}`);
  log.info(`Listening interval: ${SCAN_INTERVAL_MS / 1000}s`);
  log.info(`Hot lead threshold: risk > ${HOT_LEAD_RISK_THRESHOLD}`);

  async function scanCycle() {
    const discovery = generateDiscovery();
    const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;
    try {
      validateDiscoveryPayload(discovery.payload);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`Discovery payload rejected: ${reason}`);
      await hcs.publishAuditLog({
        type: "DISCOVERY_REJECTED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          reason,
          strictLive: STRICT_LIVE,
          contractAddress: discovery.payload.contractAddress,
        },
      });
      if (STRICT_LIVE && !DEMO_MODE) return;
    }

    log.info(
      `Discovered: ${contractAddress.slice(0, 12)}... ` +
      `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
    );

    // ── Hot Lead: sell early access on DataMarketplace ──
    if (riskScore > HOT_LEAD_RISK_THRESHOLD) {
      log.info(`HIGH RISK (${riskScore}) — listing as hot lead for 0.1 GUARD`);

      const dataHash = hashOf(discovery.payload);

      try {
      await contracts.createListing(
        0,                                    // parentJobId (no job yet)
          `Hot lead: ${contractType} contract`,  // title
          `Hot lead: ${contractType} contract, risk ${riskScore}`, // description
          ListingCategory.HOT_LEAD,             // category (uint8)
          HOT_LEAD_PRICE,                       // price
          dataHash,                             // contentHash (bytes32)
        );
      log.info("Hot lead listed on DataMarketplace");
    } catch (err) {
      log.warn(`DataMarketplace listing failed (continuing): ${err}`);
      if (STRICT_LIVE && !DEMO_MODE) {
        await hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            phase: "hot_lead_listing",
            strictLive: true,
            error: err instanceof Error ? err.message : String(err),
            contractAddress,
          },
        });
        return;
      }
    }

      log.info(`Delaying public discovery by ${HOT_LEAD_DELAY_MS / 1000}s...`);
      await sleep(HOT_LEAD_DELAY_MS);
    }

    // ── Public Discovery: broadcast to all agents ──
    await hcs.publishDiscovery(discovery);
    log.info(`Published discovery to HCS topic ${CONFIG.hcsTopics.discovery}`);

    await hcs.publishAuditLog({
      type: "AUCTION_CREATED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        contractAddress,
        contractType,
        riskScore,
        estimatedLOC,
      },
    });

    log.info(`Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
  }

  // Run first cycle immediately, then on interval
  await scanCycle();
  setInterval(scanCycle, SCAN_INTERVAL_MS);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
