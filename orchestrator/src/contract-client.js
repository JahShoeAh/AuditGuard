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

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

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

// Hedera testnet minimum gas price (~1010 gwei). The EIP-1559 fee history on
// hashio.io returns near-zero baseFee values which cause ethers.js to submit
// type-2 txs with maxFeePerGas≈200 wei — far below the relay minimum, causing
// silent reverts (status=0, gasUsed=0). Override getFeeData to force type-0
// legacy transactions with the correct network gas price.
const HEDERA_LEGACY_GAS_PRICE = BigInt(
  process.env.HEDERA_LEGACY_GAS_PRICE ?? "1111000000000"
);

function patchProviderFeeData(provider) {
  provider.getFeeData = async () => ({
    gasPrice: HEDERA_LEGACY_GAS_PRICE,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  });
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
    patchProviderFeeData(provider);
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
  patchProviderFeeData(provider);
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
    this.guardToken = new ethers.Contract(assertAddress(CONFIG.guardToken.address, "guardToken"), ERC20_ABI, wallet);
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

    // Treasury — optional; used for fee observability and authorized-source setup
    try {
      if (CONFIG.contracts.treasury) {
        const treasuryAddress = assertAddress(CONFIG.contracts.treasury, "treasury");
        this.treasury = new ethers.Contract(treasuryAddress, loadABI("Treasury"), wallet);
        log.info(`Treasury connected at ${treasuryAddress}`);
      } else {
        this.treasury = null;
        log.info("Treasury address not configured — fee observability disabled");
      }
    } catch (err) {
      this.treasury = null;
      log.warn(`Treasury init failed: ${err.message}`);
    }

    // StakingManager — optional; used for slash event relay to DelegatedStaking
    try {
      if (CONFIG.contracts.stakingManager) {
        const smAddress = assertAddress(CONFIG.contracts.stakingManager, "stakingManager");
        this.stakingManager = new ethers.Contract(smAddress, loadABI("StakingManager"), wallet);
        log.info(`StakingManager connected at ${smAddress}`);
      } else {
        this.stakingManager = null;
        log.info("StakingManager address not configured — slash relay disabled");
      }
    } catch (err) {
      this.stakingManager = null;
      log.warn(`StakingManager init failed: ${err.message}`);
    }

    // DelegatedStaking — optional; receives propagated slashes from StakingManager events
    try {
      if (CONFIG.contracts.delegatedStaking) {
        const dsAddress = assertAddress(CONFIG.contracts.delegatedStaking, "delegatedStaking");
        this.delegatedStaking = new ethers.Contract(dsAddress, loadABI("DelegatedStaking"), wallet);
        log.info(`DelegatedStaking connected at ${dsAddress}`);
      } else {
        this.delegatedStaking = null;
        log.info("DelegatedStaking address not configured — delegated slash relay disabled");
      }
    } catch (err) {
      this.delegatedStaking = null;
      log.warn(`DelegatedStaking init failed: ${err.message}`);
    }

    // GuardExchange — optional; AMM for HBAR ↔ GUARD swaps
    try {
      if (CONFIG.contracts.guardExchange) {
        const gxAddress = assertAddress(CONFIG.contracts.guardExchange, "guardExchange");
        this.guardExchange = new ethers.Contract(gxAddress, loadABI("GuardExchange"), wallet);
        log.info(`GuardExchange connected at ${gxAddress}`);
      } else {
        this.guardExchange = null;
        log.info("GuardExchange address not configured — AMM swap disabled");
      }
    } catch (err) {
      this.guardExchange = null;
      log.warn(`GuardExchange init failed: ${err.message}`);
    }

    // HbarPool — optional; fixed-rate HBAR↔GUARD converter
    try {
      if (CONFIG.contracts.hbarPool) {
        const hpAddress = assertAddress(CONFIG.contracts.hbarPool, "hbarPool");
        this.hbarPool = new ethers.Contract(hpAddress, loadABI("HbarPool"), wallet);
        log.info(`HbarPool connected at ${hpAddress}`);
      } else {
        this.hbarPool = null;
        log.info("HbarPool address not configured — fixed-rate swap disabled");
      }
    } catch (err) {
      this.hbarPool = null;
      log.warn(`HbarPool init failed: ${err.message}`);
    }

    // VaultFactory — optional; registry for audit budget vaults
    try {
      if (CONFIG.contracts.vaultFactory) {
        const vfAddress = assertAddress(CONFIG.contracts.vaultFactory, "vaultFactory");
        this.vaultFactory = new ethers.Contract(vfAddress, loadABI("VaultFactory"), wallet);
        log.info(`VaultFactory connected at ${vfAddress}`);
      } else {
        this.vaultFactory = null;
        log.info("VaultFactory address not configured — vault registry disabled");
      }
    } catch (err) {
      this.vaultFactory = null;
      log.warn(`VaultFactory init failed: ${err.message}`);
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

  async getGuardBalance(address) {
    return this.guardToken.balanceOf(address);
  }

  async getGuardAllowance(owner, spender) {
    return this.guardToken.allowance(owner, spender);
  }

  /**
   * Ensures the orchestrator wallet has approved `spender` to spend at least
   * `minRequired` GUARD. If the existing allowance is sufficient, returns null.
   * Otherwise submits an approve tx and waits for receipt.
   *
   * Hedera HTS ERC-20 frequently rejects MaxUint256 approvals; cap at int64 max
   * while leaving enough headroom for multiple settlements.
   */
  async ensureGuardAllowance(spender, minRequired) {
    const current = await this.getGuardAllowance(this.walletAddress, spender);
    if (current >= minRequired) return null;
    const INT64_MAX = (1n << 63n) - 1n;
    const desired = minRequired * 100n;
    const capped = desired > INT64_MAX ? INT64_MAX : desired;
    const tx = await this._enqueueWrite(() => this.guardToken.approve(spender, capped));
    return tx.wait();
  }

  /**
   * Transfers `amount` GUARD from the orchestrator wallet into the PaymentSettlement
   * contract so that settleJob() can disburse to recipients.
   * Requires ensureGuardAllowance to have been called first.
   */
  async depositSettlementFunds(amount) {
    const tx = await this._enqueueWrite(
      () => this.paymentSettlement.depositSettlementFunds(amount)
    );
    return tx.wait();
  }

  async calculateSettlementPreview(jobId, payments, reportAgent) {
    return this.paymentSettlement.calculateSettlementPreview(jobId, payments, reportAgent);
  }

  async propagateDelegatedSlash(agentAddress, slashBps) {
    if (!this.delegatedStaking) {
      log.warn("propagateDelegatedSlash: DelegatedStaking not connected — skipping");
      return null;
    }
    return this._enqueueWrite(
      async () => this.delegatedStaking.propagateSlash(agentAddress, slashBps)
    );
  }

  /**
   * One-time setup: authorize msg.sender (orchestrator) as a Treasury fee source.
   * Call via the setup-treasury.js script, not at runtime.
   */
  async addTreasuryAuthorizedSource(sourceAddress) {
    if (!this.treasury) throw new Error("Treasury not connected");
    return this._enqueueWrite(
      async () => this.treasury.addAuthorizedSource(sourceAddress)
    );
  }

  /**
   * One-time setup: tell DelegatedStaking who its StakingManager is (the EOA or
   * forwarding contract that is authorized to call propagateSlash).
   * Call via the wire-delegated-staking.js script.
   */
  async setDelegatedStakingStakingManager(stakingManagerAddress) {
    if (!this.delegatedStaking) throw new Error("DelegatedStaking not connected");
    return this._enqueueWrite(
      async () => this.delegatedStaking.setStakingManager(stakingManagerAddress)
    );
  }

  /**
   * One-time setup: tell StakingManager about DelegatedStaking so it can auto-
   * propagate slashes (only works if the deployed StakingManager supports
   * setDelegatedStaking — otherwise use the orchestrator relay instead).
   */
  async setStakingManagerDelegatedStaking(delegatedStakingAddress) {
    if (!this.stakingManager) throw new Error("StakingManager not connected");
    return this._enqueueWrite(
      async () => this.stakingManager.setDelegatedStaking(delegatedStakingAddress)
    );
  }

  /**
   * Subscribe to SlashInitiated events on StakingManager.
   * cb(slashId, agent, slashBasisPoints) — slashId and agent are indexed.
   */
  onSlashInitiated(cb) {
    if (!this.stakingManager) return;
    this.stakingManager.on("SlashInitiated", (slashId, agent, reason, slashedAmount, slashBasisPoints, evidenceHash, jobId, event) => {
      cb(slashId, agent, Number(slashBasisPoints), event);
    });
  }

  /**
   * Subscribe to AppealDenied events on StakingManager.
   * cb(slashId) — slash is confirmed, delegators should be slashed.
   */
  onAppealDenied(cb) {
    if (!this.stakingManager) return;
    this.stakingManager.on("AppealDenied", (slashId, ...rest) => cb(slashId));
  }

  /**
   * Subscribe to AppealExpired events on StakingManager.
   * cb(slashId) — appeal window elapsed with no appeal; slash is final.
   */
  onAppealExpired(cb) {
    if (!this.stakingManager) return;
    this.stakingManager.on("AppealExpired", (slashId, ...rest) => cb(slashId));
  }

  // ── GuardExchange ──────────────────────────────────────────────────────────

  /** Returns [hbarReserve, guardReserve] from the AMM (bigint pair). */
  async getExchangeReserves() {
    if (!this.guardExchange) return null;
    const [hbar, guard] = await this.guardExchange.getReserves();
    return { hbarReserve: hbar, guardReserve: guard };
  }

  /** Returns hbar-per-guard rate (bigint, scaled 1e8). */
  async getExchangeRate() {
    if (!this.guardExchange) return null;
    return this.guardExchange.getRate();
  }

  /** Buy GUARD with HBAR. minGuardOut is bigint (8 decimals). value is HBAR in wei. */
  async buyGuard(minGuardOut, hbarValueWei) {
    if (!this.guardExchange) throw new Error("GuardExchange not configured");
    return this._enqueueWrite(() =>
      this.guardExchange.buyGuard(minGuardOut, { value: hbarValueWei })
    );
  }

  /** Sell GUARD for HBAR. guardIn and minHbarOut are bigint (8 decimals). */
  async sellGuard(guardIn, minHbarOut) {
    if (!this.guardExchange) throw new Error("GuardExchange not configured");
    return this._enqueueWrite(() =>
      this.guardExchange.sellGuard(guardIn, minHbarOut)
    );
  }

  // ── HbarPool ───────────────────────────────────────────────────────────────

  /** Returns [hbarReserve, guardReserve] from the fixed-rate pool (bigint pair). */
  async getHbarPoolReserves() {
    if (!this.hbarPool) return null;
    const [hbar, guard] = await this.hbarPool.getReserves();
    return { hbarReserve: hbar, guardReserve: guard };
  }

  /** Buy GUARD with HBAR via fixed-rate pool. hbarValueWei is HBAR in wei. */
  async hbarToGuard(hbarValueWei) {
    if (!this.hbarPool) throw new Error("HbarPool not configured");
    return this._enqueueWrite(() =>
      this.hbarPool.hbarToGuard({ value: hbarValueWei })
    );
  }

  // ── VaultFactory ──────────────────────────────────────────────────────────

  /** Returns the vault address for a contract, or ZeroAddress if none. */
  async getVaultFor(contractAddress) {
    if (!this.vaultFactory) return null;
    return this.vaultFactory.getVaultFor(contractAddress);
  }

  /** Returns all vault addresses registered in VaultFactory. */
  async getAllVaults() {
    if (!this.vaultFactory) return [];
    return this.vaultFactory.getAllVaults();
  }

  /** Returns vaults whose re-audit interval has elapsed. */
  async getVaultsNeedingReaudit() {
    if (!this.vaultFactory) return [];
    return this.vaultFactory.getVaultsNeedingReaudit();
  }

  /** Creates a new audit budget vault for a contract. config is AuditVault.VaultConfig. */
  async createVault(contractAddress, contractChain, config) {
    if (!this.vaultFactory) throw new Error("VaultFactory not configured");
    return this._enqueueWrite(() =>
      this.vaultFactory.createVault(contractAddress, contractChain, config)
    );
  }

  /** Subscribe to VaultCreated events. cb(contractAddress, vaultAddress, creator, contractChain) */
  onVaultCreated(cb) {
    if (!this.vaultFactory?.on) return;
    this.vaultFactory.on("VaultCreated", (contractAddress, vault, creator, contractChain, event) =>
      cb(contractAddress, vault, creator, contractChain, event)
    );
  }

  /** Subscribe to AutoAuditTriggered events. cb(contractAddress, vaultAddress, reason) */
  onAutoAuditTriggered(cb) {
    if (!this.vaultFactory?.on) return;
    this.vaultFactory.on("AutoAuditTriggered", (contractAddress, vault, reason, event) =>
      cb(contractAddress, vault, reason, event)
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
