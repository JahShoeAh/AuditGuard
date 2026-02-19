import { ethers } from "ethers";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("contracts");
const __dirname = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = join(__dirname, "..", "..", "packages", "sdk", "abis");
const HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";
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
    // Disable batching to avoid "eth_newFilter is not permitted as part of batch requests"
    const provider = new ethers.JsonRpcProvider(HEDERA_TESTNET_RPC, HEDERA_NETWORK, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
    provider.pollingInterval = 5000; // Poll every 5s

    const pk = hexKey.startsWith("0x") ? hexKey : `0x${hexKey}`;
    const wallet = new ethers.Wallet(pk, provider);
    log.info(`Using orchestrator wallet ${wallet.address}`);
    return new ContractClient(wallet);
  }

  getAddress() {
    return this.wallet.address;
  }
}
