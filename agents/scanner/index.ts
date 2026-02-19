import {
  HCSClient,
  ContractClient,
  ListingCategory,
  normalizeBidFailureReasonCode,
  createAgentLogger,
  createAgentWallet,
  CONFIG,
  getAgentEnv,
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
const TEST_MODE = process.env.TEST_MODE === "true";
const STRICT_LIVE = CONFIG.strictLive;
const SCAN_INTERVAL_MS = DEMO_MODE ? 30 * 1000 : 300 * 1000; // 30s demo, 5m prod
const HOT_LEAD_RISK_THRESHOLD = 80;
const HOT_LEAD_PRICE = ethers.parseUnits("0.1", 8);   // 0.1 GUARD
const HOT_LEAD_DELAY_MS = DEMO_MODE ? 10 * 1000 : 60 * 1000; // delay before public
const DEFAULT_BUDGET_GUARD = Number(process.env.SCANNER_DISCOVERY_BUDGET_GUARD ?? "30");
const DEFAULT_DISCOVERY_BUDGET_GUARD = Number(process.env.DEFAULT_DISCOVERY_BUDGET_GUARD ?? "100");
const MIRROR_NODE = process.env.SCANNER_MIRROR_NODE || "https://testnet.mirrornode.hedera.com";
const SCANNER_AUTO_REGISTER_ONCHAIN = (process.env.SCANNER_AUTO_REGISTER_ONCHAIN ?? "true") !== "false";
const SCANNER_ASSOCIATE_REGISTRY_ON_BOOT =
  (process.env.SCANNER_ASSOCIATE_REGISTRY_ON_BOOT ?? "false") === "true";
const SCANNER_REGISTRATION_STAKE_GUARD = Number(process.env.SCANNER_REGISTRATION_STAKE_GUARD ?? "100");
const SCANNER_REGISTRATION_UCP_ENDPOINT =
  process.env.SCANNER_REGISTRATION_UCP_ENDPOINT?.trim() || `hcs://${CONFIG.hcsTopics.agentComms}`;
const CONTRACT_FETCH_LIMIT = Number(process.env.SCANNER_CONTRACT_FETCH_LIMIT ?? "25");
const START_LOOKBACK_SECONDS = Number(
  process.env.SCANNER_START_LOOKBACK_SECONDS ?? (DEMO_MODE ? "900" : "3600")
);
const MIRROR_RETRY_ATTEMPTS = 4;
const MIRROR_RETRY_BASE_MS = 500;
const MIRROR_RETRY_MAX_MS = 6_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const GUARD_DECIMALS = 8;
const DEFAULT_COMMODITY_STAKE_GUARD = 100;
const DEFAULT_SCANNER_SPECIALIZATIONS = ["discovery", "triage", "hot-leads"];
const SCANNER_REGISTRATION_SPECIALIZATIONS = parseCsvList(
  process.env.SCANNER_REGISTRATION_SPECIALIZATIONS,
  DEFAULT_SCANNER_SPECIALIZATIONS
);

const log = createAgentLogger(AGENT_ID, "scanner");

// ---- Mirror-node Discovery ----

type MirrorContract = {
  evm_address?: string | null;
  contract_id?: string | null;
  created_timestamp?: string | null;
  timestamp?: { from?: string; to?: string } | null;
  transaction_hash?: string | null;
  auto_renew_account_id?: string | null;
  bytecode?: string | null;
};

const seenContracts = new Set<string>();
let lastSeenTimestamp: string | null = makeInitialTimestamp();

// Round-robin index for test contract selection.
let _testContractIndex = 0;

function nextDiscoveryContract(): { key: string; address: string; deployer: string } {
  const contracts = CONFIG.testContracts;
  if (!contracts || contracts.length === 0) {
    return { key: "unknown", address: `0x${randomHex(40)}`, deployer: `0x${randomHex(40)}` };
  }
  const pick = contracts[_testContractIndex % contracts.length];
  _testContractIndex += 1;
  return {
    key: pick.key,
    address: pick.address.toLowerCase(),
    deployer: pick.deployer.toLowerCase(),
  };
}

// Backward-compatible helper for tests that import generateDiscovery().
// Runtime scanning now uses mirror-node discovery instead.
export function generateDiscovery() {
  const pick = nextDiscoveryContract();
  const isTestMode = process.env.TEST_MODE === "true";
  const types: ContractType[] = ["lending", "dex", "staking", "bridge", "vault"];
  const riskScore = isTestMode ? 75 : randomInt(20, 95);
  const estimatedLOC = isTestMode ? 150 : randomInt(500, 10000);
  const discoveryTimestamp = Math.floor(Date.now() / 1000);

  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress: pick.address,
      chain: "hedera-testnet",
      deployerAddress: pick.deployer,
      estimatedLOC,
      estimatedLineCount: estimatedLOC,
      contractType: isTestMode ? "vault" : randomChoice(types),
      riskScore,
      initialRiskScore: riskScore,
      budget: DEFAULT_BUDGET_GUARD,
      discoveryTimestamp,
      txHash: `0x${randomHex(64)}`,
      sourceRef: pick.key,
    },
  };
}

function makeInitialTimestamp() {
  const initialFromEnv = process.env.SCANNER_START_TIMESTAMP?.trim();
  if (initialFromEnv) return initialFromEnv;
  const startMs = Date.now() - START_LOOKBACK_SECONDS * 1000;
  const seconds = Math.floor(startMs / 1000);
  const nanos = (startMs % 1000) * 1_000_000;
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

function toConsensusBigInt(ts?: string | null): bigint | null {
  if (!ts || !ts.includes(".")) return null;
  const [secRaw, nanoRaw] = ts.split(".");
  if (!secRaw || !nanoRaw) return null;
  const sec = BigInt(secRaw);
  const nanos = BigInt((nanoRaw + "000000000").slice(0, 9));
  return sec * 1_000_000_000n + nanos;
}

function isRetriableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MIRROR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok && isRetriableStatus(res.status)) {
        throw new Error(`Mirror node responded ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= MIRROR_RETRY_ATTEMPTS) break;
      const jitter = Math.floor(Math.random() * 150);
      const backoff = Math.min(
        MIRROR_RETRY_MAX_MS,
        MIRROR_RETRY_BASE_MS * (2 ** (attempt - 1))
      );
      await sleep(backoff + jitter);
    }
  }

  throw lastError ?? new Error("Mirror node request failed");
}

function extractCreatedTimestamp(c: MirrorContract): string | null {
  return c.created_timestamp ?? c.timestamp?.from ?? null;
}

function inferContractType(c: MirrorContract): ContractType {
  // Mirror-node metadata does not expose Solidity source, so keep type conservative.
  // Downstream agents can refine this via static analysis after discovery.
  void c;
  return "unknown";
}

function estimateLoc(c: MirrorContract): number {
  const bytecode = typeof c.bytecode === "string" ? c.bytecode : "";
  if (bytecode.startsWith("0x") && bytecode.length > 2) {
    const byteLength = (bytecode.length - 2) / 2;
    return Math.max(200, Math.min(12_000, Math.round(byteLength * 1.6)));
  }
  return 1200;
}

function deriveRiskScore(contractAddress: string): number {
  const digest = ethers.keccak256(ethers.toUtf8Bytes(contractAddress.toLowerCase()));
  const seed = Number.parseInt(digest.slice(2, 4), 16);
  return 20 + (seed % 76); // 20..95
}

function createDiscoveryFromMirror(contract: MirrorContract) {
  const contractAddress = (contract.evm_address || "").toLowerCase();
  const createdTs = extractCreatedTimestamp(contract) || String(Date.now());
  const txHash = contract.transaction_hash || hashOf({
    contractAddress,
    createdTs,
    source: "hedera-mirror",
  });

  return {
    type: "CONTRACT_DISCOVERED" as const,
    agentId: AGENT_ID,
    timestamp: Date.now(),
    payload: {
      contractAddress,
      chain: "hedera-testnet",
      deployerAddress: ZERO_ADDRESS, // mirror endpoint does not directly expose EVM deployer
      estimatedLOC: estimateLoc(contract),
      contractType: inferContractType(contract),
      riskScore: deriveRiskScore(contractAddress),
      budget: DEFAULT_DISCOVERY_BUDGET_GUARD,
      txHash,
    },
  };
}

async function fetchNewContractsSinceCursor() {
  const base = `${MIRROR_NODE}/api/v1/contracts?order=desc&limit=${CONTRACT_FETCH_LIMIT}`;
  const cursorUrl = lastSeenTimestamp
    ? `${base}&timestamp=gt:${encodeURIComponent(lastSeenTimestamp)}`
    : base;

  let res = await fetchWithRetry(cursorUrl);

  // Some mirror-node versions reject timestamp filtering on this endpoint.
  if (res.status === 400 && lastSeenTimestamp) {
    res = await fetchWithRetry(base);
  }

  if (!res.ok) {
    throw new Error(`Mirror node responded ${res.status}`);
  }

  const body = await res.json() as { contracts?: MirrorContract[] };
  const contracts = body.contracts || [];
  const cursorTs = toConsensusBigInt(lastSeenTimestamp);

  return contracts
    .filter((c) => typeof c.evm_address === "string" && ethers.isAddress(c.evm_address))
    .filter((c) => {
      if (!cursorTs) return true;
      const ts = toConsensusBigInt(extractCreatedTimestamp(c));
      return ts !== null && ts > cursorTs;
    })
    .sort((a, b) => {
      const ta = toConsensusBigInt(extractCreatedTimestamp(a)) || 0n;
      const tb = toConsensusBigInt(extractCreatedTimestamp(b)) || 0n;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
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

function parseCsvList(raw: string | undefined, fallback: string[]): string[] {
  const values = String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function formatGuardUnits(amountWei: bigint): string {
  return Number(ethers.formatUnits(amountWei, GUARD_DECIMALS)).toFixed(2);
}

function isHtsTransferFailure(error: string): boolean {
  return error.toLowerCase().includes("hts transfer failed");
}

// ---- Main ----

async function main() {
  log.info("Scanner Agent starting...");
  if (DEMO_MODE) log.info("DEMO MODE — compressed timers");
  if (TEST_MODE) log.info("TEST MODE — emitting mock discoveries");

  const wallet = createAgentWallet("SCANNER");
  const hcs = new HCSClient(wallet.hederaClient);
  const contracts = new ContractClient(wallet.evmWallet);
  let fallbackHcs: HCSClient | null = null;
  let fallbackAccountId = "";
  let hotLeadListingEnabled = true;

  function isInsufficientPayerBalance(err: unknown): boolean {
    const status = String((err as { status?: unknown })?.status ?? "");
    const message = String((err as { message?: unknown })?.message ?? err ?? "");
    return (
      status.toUpperCase() === "INSUFFICIENT_PAYER_BALANCE" ||
      message.toUpperCase().includes("INSUFFICIENT_PAYER_BALANCE")
    );
  }

  try {
    const operatorAccountId = getAgentEnv("OPERATOR").accountId;
    if (operatorAccountId && operatorAccountId !== wallet.accountId) {
      fallbackHcs = new HCSClient("OPERATOR");
      fallbackAccountId = operatorAccountId;
      log.info(`HCS fallback payer enabled via OPERATOR account ${operatorAccountId}`);
    }
  } catch {
    // Optional fallback; ignore when operator creds are unavailable.
  }

  async function publishAuditLogSafe(message: any): Promise<boolean> {
    try {
      await hcs.publishAuditLog(message);
      return true;
    } catch (err) {
      if (fallbackHcs && isInsufficientPayerBalance(err)) {
        log.warn(
          `Primary scanner payer ${wallet.accountId} has insufficient balance; ` +
          `retrying auditLog publish with operator ${fallbackAccountId}`
        );
        try {
          await fallbackHcs.publishAuditLog(message);
          return true;
        } catch (fallbackErr) {
          log.error(`Fallback auditLog publish failed: ${fallbackErr}`);
          return false;
        }
      }
      log.error(`AuditLog publish failed: ${err}`);
      return false;
    }
  }

  async function publishDiscoverySafe(message: any): Promise<boolean> {
    try {
      await hcs.publishDiscovery(message);
      return true;
    } catch (err) {
      if (fallbackHcs && isInsufficientPayerBalance(err)) {
        log.warn(
          `Primary scanner payer ${wallet.accountId} has insufficient balance; ` +
          `retrying discovery publish with operator ${fallbackAccountId}`
        );
        try {
          await fallbackHcs.publishDiscovery(message);
          return true;
        } catch (fallbackErr) {
          log.error(`Fallback discovery publish failed: ${fallbackErr}`);
          return false;
        }
      }
      log.error(`Discovery publish failed: ${err}`);
      return false;
    }
  }

  log.info(`Wallet: ${wallet.evmAddress}`);
  log.info(`Listening interval: ${SCAN_INTERVAL_MS / 1000}s`);
  log.info(`Hot lead threshold: risk > ${HOT_LEAD_RISK_THRESHOLD}`);
  log.info(`Mirror node: ${MIRROR_NODE}`);
  if (SCANNER_AUTO_REGISTER_ONCHAIN) {
    log.info("On-chain auto-registration for scanner is enabled");
  }
  if (lastSeenTimestamp) {
    log.info(`Initial contract cursor: ${lastSeenTimestamp}`);
  }

  async function ensureMarketplaceListingReady(): Promise<boolean> {
    let active = false;
    try {
      active = await contracts.isActiveAgent(wallet.evmAddress);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: active-agent check failed: ${error}`);
      return false;
    }

    if (active) return true;

    log.warn("Startup preflight: wallet is not an active on-chain agent");
    if (!SCANNER_AUTO_REGISTER_ONCHAIN || TEST_MODE) {
      return false;
    }

    let minCommodityStakeWei = ethers.parseUnits(
      DEFAULT_COMMODITY_STAKE_GUARD.toFixed(2),
      GUARD_DECIMALS
    );
    try {
      minCommodityStakeWei = await contracts.getCommodityMinStake();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: failed to read commodity min stake, using default: ${error}`);
    }

    const configuredStakeGuard = Number.isFinite(SCANNER_REGISTRATION_STAKE_GUARD) &&
      SCANNER_REGISTRATION_STAKE_GUARD > 0
      ? SCANNER_REGISTRATION_STAKE_GUARD
      : DEFAULT_COMMODITY_STAKE_GUARD;
    let stakeWei = ethers.parseUnits(configuredStakeGuard.toFixed(2), GUARD_DECIMALS);
    if (stakeWei < minCommodityStakeWei) {
      log.warn(
        `Configured scanner stake ${configuredStakeGuard.toFixed(2)} GUARD is below minimum ` +
        `${formatGuardUnits(minCommodityStakeWei)} GUARD; using protocol minimum`
      );
      stakeWei = minCommodityStakeWei;
    }

    try {
      const guardBalance = await contracts.getGuardBalance(wallet.evmAddress);
      if (guardBalance < stakeWei) {
        log.warn(
          `Startup preflight: cannot auto-register scanner, GUARD balance ` +
          `${formatGuardUnits(guardBalance)} is below required ${formatGuardUnits(stakeWei)}`
        );
        return false;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: failed to read GUARD balance before registration: ${error}`);
    }

    try {
      const register = async () => {
        const tx = await contracts.registerAgent(
          AGENT_ID,
          SCANNER_REGISTRATION_UCP_ENDPOINT,
          SCANNER_REGISTRATION_SPECIALIZATIONS,
          stakeWei
        );
        await tx.wait?.();
      };

      try {
        await register();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (!isHtsTransferFailure(error) || !SCANNER_ASSOCIATE_REGISTRY_ON_BOOT) {
          throw err;
        }

        log.warn(
          "Startup preflight: registration hit HTS transfer failure; " +
          "SCANNER_ASSOCIATE_REGISTRY_ON_BOOT=true so attempting registry GUARD association"
        );
        try {
          const ownerAddress = String(await contracts.agentRegistry.owner());
          if (ownerAddress.toLowerCase() !== wallet.evmAddress.toLowerCase()) {
            throw new Error(
              `scanner wallet is not AgentRegistry owner (${ownerAddress}), cannot associate token`
            );
          }
          const associationTx = await contracts.agentRegistry.associateGuardToken();
          await associationTx.wait?.();
          log.info("Startup preflight: AgentRegistry GUARD association transaction confirmed");
        } catch (associateErr) {
          const associationError = associateErr instanceof Error
            ? associateErr.message
            : String(associateErr);
          throw new Error(`AgentRegistry association failed: ${associationError}`);
        }

        await register();
      }

      log.info(
        `Startup preflight: registered scanner on-chain with ` +
        `${formatGuardUnits(stakeWei)} GUARD stake`
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: auto-registration failed: ${error}`);
      return false;
    }

    try {
      const activeAfterRegistration = await contracts.isActiveAgent(wallet.evmAddress);
      if (!activeAfterRegistration) {
        log.warn("Startup preflight: scanner registration submitted but wallet is still inactive");
      }
      return activeAfterRegistration;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Startup preflight: post-registration active check failed: ${error}`);
      return false;
    }
  }

  hotLeadListingEnabled = await ensureMarketplaceListingReady();
  if (!hotLeadListingEnabled) {
    log.warn("Hot lead listing disabled: scanner wallet is not an active marketplace agent");
    await publishAuditLogSafe({
      type: "LISTING_DISABLED",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      payload: {
        phase: "hot_lead_listing",
        reasonCode: "inactive_agent",
        strictLive: STRICT_LIVE,
        evmAddress: wallet.evmAddress,
      },
    });
  }

  async function scanCycle() {
    if (TEST_MODE) {
      const discovery = generateDiscovery();
      const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

      try {
        validateDiscoveryPayload(discovery.payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`Mock discovery payload rejected: ${reason}`);
        await publishAuditLogSafe({
          type: "DISCOVERY_REJECTED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            reason,
            strictLive: STRICT_LIVE,
            contractAddress,
          },
        });
        return;
      }

      const publishedDiscovery = await publishDiscoverySafe(discovery);
      if (!publishedDiscovery) return;
      await publishAuditLogSafe({
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
      log.info(
        `Published mock discovery: ${contractAddress.slice(0, 12)}... ` +
        `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
      );
      log.info(`Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
      return;
    }

    let discoveredContracts: MirrorContract[] = [];
    try {
      discoveredContracts = await fetchNewContractsSinceCursor();
    } catch (err) {
      log.warn(`Mirror-node scan failed: ${err}`);
      await publishAuditLogSafe({
        type: "DISCOVERY_FETCH_FAILED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          error: err instanceof Error ? err.message : String(err),
          mirrorNode: MIRROR_NODE,
        },
      });
      return;
    }

    if (discoveredContracts.length === 0) {
      log.info(`No new deployed contracts found. Next scan in ${SCAN_INTERVAL_MS / 1000}s...`);
      return;
    }

    for (const c of discoveredContracts) {
      const discovery = createDiscoveryFromMirror(c);
      const { contractAddress, contractType, riskScore, estimatedLOC } = discovery.payload;

      if (seenContracts.has(contractAddress)) continue;
      seenContracts.add(contractAddress);

      try {
        validateDiscoveryPayload(discovery.payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error(`Discovery payload rejected: ${reason}`);
        await publishAuditLogSafe({
          type: "DISCOVERY_REJECTED",
          agentId: AGENT_ID,
          timestamp: Date.now(),
          payload: {
            reason,
            strictLive: STRICT_LIVE,
            contractAddress,
          },
        });
        if (STRICT_LIVE && !DEMO_MODE) continue;
      }

      log.info(
        `Discovered deployed contract: ${contractAddress.slice(0, 12)}... ` +
        `type=${contractType} risk=${riskScore} loc=${estimatedLOC}`
      );

      // ── Hot Lead: sell early access on DataMarketplace ──
      if (riskScore > HOT_LEAD_RISK_THRESHOLD) {
        if (!hotLeadListingEnabled) {
          log.info(
            `HIGH RISK (${riskScore}) — skipping hot lead listing (scanner is not active on-chain)`
          );
        } else {
          log.info(`HIGH RISK (${riskScore}) — listing as hot lead for 0.1 GUARD`);

          const dataHash = hashOf(discovery.payload);

          try {
            await contracts.createListing(
              0,                                        // parentJobId (no job yet)
              `Hot lead: ${contractType} contract`,     // title
              `Hot lead: ${contractType} contract, risk ${riskScore}`, // description
              ListingCategory.HOT_LEAD,                 // category (uint8)
              HOT_LEAD_PRICE,                           // price
              dataHash,                                 // contentHash (bytes32)
            );
            log.info("Hot lead listed on DataMarketplace");
            log.info(`Delaying public discovery by ${HOT_LEAD_DELAY_MS / 1000}s...`);
            await sleep(HOT_LEAD_DELAY_MS);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const reasonCode = normalizeBidFailureReasonCode(error);
            log.warn(`DataMarketplace listing failed (continuing): ${error}`);
            if (reasonCode === "inactive_agent") {
              hotLeadListingEnabled = false;
              log.warn("Disabling hot lead listing for this run: scanner wallet is inactive on-chain");
            }
            await publishAuditLogSafe({
              type: "ONCHAIN_TX_FAILED",
              agentId: AGENT_ID,
              timestamp: Date.now(),
              payload: {
                phase: "hot_lead_listing",
                strictLive: STRICT_LIVE && !DEMO_MODE,
                reasonCode,
                error,
                contractAddress,
              },
            });
            if (STRICT_LIVE && !DEMO_MODE && reasonCode !== "inactive_agent") {
              continue;
            }
          }
        }
      }

      // ── Public Discovery: broadcast to all agents ──
      const publishedDiscovery = await publishDiscoverySafe(discovery);
      if (!publishedDiscovery) {
        continue;
      }
      log.info(`Published discovery to HCS topic ${CONFIG.hcsTopics.discovery}`);

      await publishAuditLogSafe({
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

      const createdTs = extractCreatedTimestamp(c);
      if (createdTs) lastSeenTimestamp = createdTs;
    }

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
