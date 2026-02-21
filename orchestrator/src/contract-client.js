import { ethers } from "ethers";
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
  constructor(wallet) {
    this.wallet = wallet;
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
    this._writeQueue = Promise.resolve();

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
    const wallet = new ethers.Wallet(pk, provider);
    log.info(
      `Using orchestrator wallet ${wallet.address} ` +
      `(RPC candidates: ${rpcCandidates.join(", ")})`
    );
    return new ContractClient(wallet);
  }

  getAddress() {
    return this.wallet.address;
  }

  async _enqueueWrite(sendFn) {
    const previous = this._writeQueue;
    let releaseQueue = () => { };
    this._writeQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await previous.catch(() => { });
    try {
      return await sendFn();
    } finally {
      releaseQueue();
    }
  }

  async createAuditJob(...args) {
    return this._enqueueWrite(async () => this.auction.createAuditJob(...args));
  }

  async selectWinners(jobId, winningBidIndices) {
    const tx = await this._enqueueWrite(async () =>
      this.auction.selectWinners(jobId, winningBidIndices)
    );
    const receipt = await tx.wait();
    return receipt;
  }

  async cancelJob(jobId) {
    const tx = await this._enqueueWrite(async () => this.auction.cancelJob(jobId));
    const receipt = await tx.wait();
    return receipt;
  }

  async purchaseData(listingId) {
    return this._enqueueWrite(async () => this.dataMarketplace.purchaseData(listingId));
  }

  async createSubAuction(...args) {
    return this._enqueueWrite(async () => this.subAuction.createSubAuction(...args));
  }

  async acceptSubResult(subAuctionId) {
    return this._enqueueWrite(async () => this.subAuction.acceptResult(subAuctionId));
  }

  async settleJob(jobId, payments, reportAgent) {
    return this._enqueueWrite(async () =>
      this.paymentSettlement.settleJob(jobId, payments, reportAgent)
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
