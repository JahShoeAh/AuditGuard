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

function loadABI(name) {
  const p = join(ABI_DIR, `${name}.json`);
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  return raw.abi || raw;
}

export class ContractClient {
  constructor(wallet) {
    this.wallet = wallet;
    this.auction = new ethers.Contract(CONFIG.contracts.auction, loadABI("AuditAuction"), wallet);
    this.subAuction = new ethers.Contract(CONFIG.contracts.subAuction, loadABI("SubAuction"), wallet);
    this.dataMarketplace = new ethers.Contract(CONFIG.contracts.dataMarketplace, loadABI("DataMarketplace"), wallet);
    this.paymentSettlement = new ethers.Contract(CONFIG.contracts.paymentSettlement, loadABI("PaymentSettlement"), wallet);
    this.agentRegistry = new ethers.Contract(CONFIG.contracts.agentRegistry, loadABI("AgentRegistry"), wallet);
    this.budgetVault = new ethers.Contract(CONFIG.contracts.budgetVault, loadABI("AuditBudgetVault"), wallet);

    // AuditScheduler — optional; only active after deploy:audit-scheduler has run
    try {
      if (CONFIG.contracts.auditScheduler) {
        this.auditScheduler = new ethers.Contract(
          CONFIG.contracts.auditScheduler,
          loadABI("AuditScheduler"),
          wallet
        );
        log.info(`AuditScheduler connected at ${CONFIG.contracts.auditScheduler}`);
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
    const provider = new ethers.JsonRpcProvider(HEDERA_TESTNET_RPC);
    const pk = hexKey.startsWith("0x") ? hexKey : `0x${hexKey}`;
    const wallet = new ethers.Wallet(pk, provider);
    log.info(`Using orchestrator wallet ${wallet.address}`);
    return new ContractClient(wallet);
  }

  getAddress() {
    return this.wallet.address;
  }
}
