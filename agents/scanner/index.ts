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
const SCAN_INTERVAL_MS = DEMO_MODE ? 30 * 1000 : 300 * 1000; // 30s demo, 5m prod
const HOT_LEAD_RISK_THRESHOLD = 80;
const HOT_LEAD_PRICE = ethers.parseUnits("0.1", 8);   // 0.1 GUARD
const HOT_LEAD_DELAY_MS = DEMO_MODE ? 10 * 1000 : 60 * 1000; // delay before public

const log = createAgentLogger(AGENT_ID, "scanner");
let discoveryContractIndex = 0;
type DiscoveryContract = { key?: string; address: string; deployer: string };

const FALLBACK_DISCOVERY_CONTRACTS = [
  {
    key: "fallback-vault-1",
    address: "0x0000000000000000000000000000000000000001",
    deployer: "0x0000000000000000000000000000000000000010",
  },
  {
    key: "fallback-vault-2",
    address: "0x0000000000000000000000000000000000000002",
    deployer: "0x0000000000000000000000000000000000000010",
  },
  {
    key: "fallback-vault-3",
    address: "0x0000000000000000000000000000000000000003",
    deployer: "0x0000000000000000000000000000000000000010",
  },
] as const satisfies readonly DiscoveryContract[];

function nextDiscoveryContract(): DiscoveryContract {
  const configured: DiscoveryContract[] = (CONFIG.testContracts ?? [])
    .filter((c) => Boolean(c?.address) && Boolean(c?.deployer))
    .map((c) => ({
      key: c.key || undefined,
      address: String(c.address).toLowerCase(),
      deployer: String(c.deployer).toLowerCase(),
    }));
  const pool: readonly DiscoveryContract[] = configured.length > 0
    ? configured
    : FALLBACK_DISCOVERY_CONTRACTS;
  const pick = pool[discoveryContractIndex % pool.length];
  discoveryContractIndex += 1;
  return pick;
}

// ---- Discovery Generator ----

export function generateDiscovery() {
  const pick = nextDiscoveryContract();
  const isTestMode = process.env.TEST_MODE === "true";
  const types: ContractType[] = ["lending", "dex", "staking", "bridge", "vault"];

  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress: pick.address,
      chain: "hedera-testnet",
      deployerAddress: pick.deployer,
      estimatedLOC: isTestMode ? 150 : randomInt(500, 10000),
      contractType: isTestMode ? "vault" : randomChoice(types),
      riskScore: isTestMode ? 75 : randomInt(20, 95),
      txHash: `0x${randomHex(64)}`,
      sourceRef: pick.key,
    },
  };
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
