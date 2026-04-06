import { ethers } from "ethers";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
// PollingEventSubscriber is not in ethers' package exports map — require the CJS build directly.
// This forces eth_getLogs polling instead of eth_newFilter on Hedera JSON-RPC relays.
const { PollingEventSubscriber } = _require("../../node_modules/ethers/lib.commonjs/providers/subscriber-polling.js");
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("contracts");
const __dirname = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = join(__dirname, "..", "..", "packages", "sdk", "abis");
const DEFAULT_HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";
const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };

function loadABI(name) {
  const p = join(ABI_DIR, `${name}.json`);
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  return raw.abi || raw;
}

function assertAddress(value, label) {
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid ${label} address: ${value}`);
  }
  return value;
}

function parseRpcCandidates() {
  const primary =
    process.env.HEDERA_JSON_RPC_URL ||
    process.env.HEDERA_RPC_URL ||
    DEFAULT_HEDERA_TESTNET_RPC;
  const fallbackRaw = process.env.HEDERA_JSON_RPC_FALLBACK_URLS || "";
  const fallbacks = fallbackRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set([primary, ...fallbacks]));
}

function buildProviderWithFallback() {
  const rpcCandidates = parseRpcCandidates();
  const providers = rpcCandidates.map((rpcUrl) => {
    const provider = new ethers.JsonRpcProvider(rpcUrl, HEDERA_NETWORK, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
    provider.pollingInterval = 5000;
    // Hedera JSON-RPC relays don't support eth_newFilter / eth_getFilterChanges.
    // Force eth_getLogs-based polling for all event subscriptions.
    const _orig = provider._getSubscriber.bind(provider);
    provider._getSubscriber = (sub) => {
      if (sub.type === "event") return new PollingEventSubscriber(provider, sub.filter);
      return _orig(sub);
    };
    return provider;
  });

  if (providers.length === 1) {
    return { provider: providers[0], rpcCandidates };
  }

  const fallbackConfigs = providers.map((provider, index) => ({
    provider,
    priority: index + 1,
    weight: 1,
    stallTimeout: 2500,
  }));

  const provider = new ethers.FallbackProvider(fallbackConfigs, HEDERA_NETWORK, {
    quorum: 1,
    pollingInterval: 5000,
  });
  return { provider, rpcCandidates };
}

export class ContractClient {
  constructor(wallet, walletAddress = null) {
    this.wallet = wallet;
    this.walletAddress = typeof walletAddress === "string" ? walletAddress : "";
    const auctionAddress = assertAddress(CONFIG.contracts.auction, "auction");
    const subAuctionAddress = assertAddress(CONFIG.contracts.subAuction, "subAuction");
    const dataMarketplaceAddress = assertAddress(CONFIG.contracts.dataMarketplace, "dataMarketplace");
    const paymentSettlementAddress = assertAddress(CONFIG.contracts.paymentSettlement, "paymentSettlement");
    const agentRegistryAddress = assertAddress(CONFIG.contracts.agentRegistry, "agentRegistry");
    const budgetVaultAddress = assertAddress(CONFIG.contracts.budgetVault, "budgetVault");

    this.auction = new ethers.Contract(auctionAddress, loadABI("AuditAuction"), wallet);
    this.subAuction = new ethers.Contract(subAuctionAddress, loadABI("SubAuction"), wallet);
    this.dataMarketplace = new ethers.Contract(dataMarketplaceAddress, loadABI("DataMarketplace"), wallet);
    this.paymentSettlement = new ethers.Contract(paymentSettlementAddress, loadABI("PaymentSettlement"), wallet);
    this.agentRegistry = new ethers.Contract(agentRegistryAddress, loadABI("AgentRegistry"), wallet);
    this.budgetVault = new ethers.Contract(budgetVaultAddress, loadABI("AuditBudgetVault"), wallet);
    this.fastWinnerPathEnabled = (process.env.ORCHESTRATOR_FAST_WINNER_PATH_ENABLED ?? "false") === "true";
    const configuredMaxHighStreak = Number(CONFIG.queue?.writeQueueMaxHighStreak ?? 3);
    this.writeQueueMaxHighStreak =
      Number.isFinite(configuredMaxHighStreak) && configuredMaxHighStreak > 0
        ? Math.floor(configuredMaxHighStreak)
        : 3;
    this._writeQueue = [];
    this._writeQueueRunning = false;
    this._highPriorityStreak = 0;

    // AuditScheduler — optional; only active after deploy:audit-scheduler has run
    try {
      if (CONFIG.contracts.auditScheduler) {
        const schedulerAddress = assertAddress(CONFIG.contracts.auditScheduler, "auditScheduler");
        this.auditScheduler = new ethers.Contract(
          schedulerAddress,
          loadABI("AuditScheduler"),
          wallet
        );
        log.info(`AuditScheduler connected at ${schedulerAddress}`);
      } else {
        this.auditScheduler = null;
        log.info("AuditScheduler address not configured — scheduled audits disabled");
      }
    } catch (err) {
      this.auditScheduler = null;
      log.warn(`AuditScheduler init failed (ABI missing?): ${err.message}`);
    }
  }

  static fromOperatorKey(hexKey) {
    const { provider, rpcCandidates } = buildProviderWithFallback();

    const pk = hexKey.startsWith("0x") ? hexKey : `0x${hexKey}`;
    const baseWallet = new ethers.Wallet(pk, provider);
    const wallet = new ethers.NonceManager(baseWallet);
    log.info(
      `Using orchestrator wallet ${baseWallet.address} ` +
      `(RPC candidates: ${rpcCandidates.join(", ")})`
    );
    return new ContractClient(wallet, baseWallet.address);
  }

  getAddress() {
    return this.walletAddress;
  }

  async _enqueueWrite(sendFn) {
    return this._enqueueWriteWithPriority(sendFn, "normal");
  }

  async _enqueueWriteWithPriority(sendFn, priority = "normal") {
    const normalizedPriority = priority === "high" ? "high" : "normal";
    return new Promise((resolve, reject) => {
      const task = { sendFn, resolve, reject, priority: normalizedPriority };
      if (this.fastWinnerPathEnabled && normalizedPriority === "high") {
        const firstNormalIndex = this._writeQueue.findIndex((entry) => entry.priority !== "high");
        if (firstNormalIndex === -1) {
          this._writeQueue.push(task);
        } else {
          this._writeQueue.splice(firstNormalIndex, 0, task);
        }
      } else {
        this._writeQueue.push(task);
      }
      this._drainWriteQueue().catch((err) => {
        log.warn(`write queue drain failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  async _drainWriteQueue() {
    if (this._writeQueueRunning) return;
    this._writeQueueRunning = true;
    try {
      while (this._writeQueue.length > 0) {
        const task = this._dequeueNextWriteTask();
        if (!task) continue;
        try {
          const result = await task.sendFn();
          task.resolve(result);
          if (task.priority === "high") {
            this._highPriorityStreak += 1;
          } else {
            this._highPriorityStreak = 0;
          }
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      this._writeQueueRunning = false;
    }
  }

  _dequeueNextWriteTask() {
    if (this._writeQueue.length === 0) return null;
    if (
      this.fastWinnerPathEnabled &&
      this.writeQueueMaxHighStreak > 0 &&
      this._highPriorityStreak >= this.writeQueueMaxHighStreak
    ) {
      const normalIndex = this._writeQueue.findIndex((entry) => entry.priority !== "high");
      if (normalIndex >= 0) {
        const [task] = this._writeQueue.splice(normalIndex, 1);
        return task ?? null;
      }
    }
    return this._writeQueue.shift() ?? null;
  }

  async createAuditJob(...args) {
    return this._enqueueWriteWithPriority(async () => this.auction.createAuditJob(...args), "normal");
  }

  async selectWinners(jobId, winningBidIndices, options = {}) {
    const priority = options?.priority === "high" ? "high" : "normal";
    const tx = await this._enqueueWriteWithPriority(
      async () => this.auction.selectWinners(jobId, winningBidIndices),
      priority
    );
    const receipt = await tx.wait();
    return receipt;
  }

  async cancelJob(jobId, options = {}) {
    const priority = options?.priority === "high" ? "high" : "normal";
    const tx = await this._enqueueWriteWithPriority(async () => this.auction.cancelJob(jobId), priority);
    const receipt = await tx.wait();
    return receipt;
  }

  async purchaseData(listingId) {
    return this._enqueueWriteWithPriority(
      async () => this.dataMarketplace.purchaseData(listingId),
      "normal"
    );
  }

  async createSubAuction(...args) {
    return this._enqueueWriteWithPriority(
      async () => this.subAuction.createSubAuction(...args),
      "normal"
    );
  }

  async acceptSubResult(subAuctionId) {
    return this._enqueueWriteWithPriority(
      async () => this.subAuction.acceptResult(subAuctionId),
      "normal"
    );
  }

  async settleJob(jobId, payments, reportAgent) {
    return this._enqueueWriteWithPriority(
      async () => this.paymentSettlement.settleJob(jobId, payments, reportAgent),
      "normal"
    );
  }

  async getActiveJobs() {
    return this.auction.getActiveJobs();
  }

  async getJob(jobId) {
    return this.auction.getJob(jobId);
  }

  async isActiveAgent(agentAddress) {
    return this.agentRegistry.isActiveAgent(agentAddress);
  }

  async getAllAgents() {
    return this.agentRegistry.getAllAgents();
  }

  async getAgent(agentAddress) {
    return this.agentRegistry.getAgent(agentAddress);
  }
}
