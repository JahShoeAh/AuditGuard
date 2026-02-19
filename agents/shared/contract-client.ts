/**
 * Contract Client — ethers.js wrappers for all AuditGuard smart contracts.
 *
 * Loads real ABIs from packages/sdk/abis/ (Hardhat artifacts).
 * Exposes typed convenience methods for every contract call the agents need.
 *
 * Signatures match the DEPLOYED contracts exactly (as of 2026-02-16).
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./config.js";

// ─── ABI Loader ────────────────────────────────────────────────────────────

const __dirname_resolved = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = join(__dirname_resolved, "..", "..", "packages", "sdk", "abis");

function loadABI(contractName: string): ethers.InterfaceAbi {
  const filePath = join(ABI_DIR, `${contractName}.json`);
  const artifact = JSON.parse(readFileSync(filePath, "utf-8"));
  // Hardhat artifacts store the ABI under the "abi" key
  return artifact.abi || artifact;
}

// Pre-load all ABIs at module level so failures are immediate
const ABIS = {
  agentRegistry: loadABI("AgentRegistry"),
  auction: loadABI("AuditAuction"),
  budgetVault: loadABI("AuditBudgetVault"),
  subAuction: loadABI("SubAuction"),
  dataMarketplace: loadABI("DataMarketplace"),
  paymentSettlement: loadABI("PaymentSettlement"),
};

// ─── Exported ABI loader for tests ─────────────────────────────────────────

export { loadABI, ABIS, ABI_DIR };

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuctionDetails {
  target: string;
  budget: bigint;
  deadline: bigint;
  winnerCount: bigint;
  jobState: number;
}

export interface ListingDetails {
  seller: string;
  price: bigint;
  category: number;
  dataHash: string;
  active: boolean;
}

/**
 * PaymentItem struct to pass into settleJob.
 * Must match PaymentSettlement.PaymentItem in the Solidity contract.
 */
export interface PaymentItem {
  recipient: string;
  basePayment: bigint;
  bonus: bigint;
  reportFee: bigint;
  paymentType: number;   // PaymentType enum: 0=AUDIT, 1=REPORT, 2=SUBAUTION, 3=BOUNTY
  description: string;
}

/**
 * DataMarketplace listing category enum (uint8).
 * Must match the Solidity enum values.
 */
export const ListingCategory = {
  SCAN_REPORT: 0,
  DEPENDENCY_TREE: 1,
  HOT_LEAD: 2,
  VULN_DB: 3,
} as const;

/**
 * DataMarketplace listing type enum (uint8).
 */
export const ListingType = {
  ONE_TIME: 0,
  SUBSCRIPTION: 1,
} as const;

// ─── Contract Client ───────────────────────────────────────────────────────

const HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";

export class ContractClient {
  public readonly auction: ethers.Contract;
  public readonly subAuction: ethers.Contract;
  public readonly dataMarketplace: ethers.Contract;
  public readonly paymentSettlement: ethers.Contract;
  public readonly agentRegistry: ethers.Contract;
  public readonly budgetVault: ethers.Contract;
  public readonly wallet: ethers.Wallet;

  /**
   * Create a ContractClient from an existing ethers.Wallet.
   * Prefer using the static `fromPrivateKey` factory.
   */
  constructor(wallet: ethers.Wallet) {
    this.wallet = wallet;

    this.auction = new ethers.Contract(
      CONFIG.contracts.auction,
      ABIS.auction,
      this.wallet
    );
    this.subAuction = new ethers.Contract(
      CONFIG.contracts.subAuction,
      ABIS.subAuction,
      this.wallet
    );
    this.dataMarketplace = new ethers.Contract(
      CONFIG.contracts.dataMarketplace,
      ABIS.dataMarketplace,
      this.wallet
    );
    this.paymentSettlement = new ethers.Contract(
      CONFIG.contracts.paymentSettlement,
      ABIS.paymentSettlement,
      this.wallet
    );
    this.agentRegistry = new ethers.Contract(
      CONFIG.contracts.agentRegistry,
      ABIS.agentRegistry,
      this.wallet
    );
    this.budgetVault = new ethers.Contract(
      CONFIG.contracts.budgetVault,
      ABIS.budgetVault,
      this.wallet
    );
  }

  /**
   * Create a ContractClient from a raw private key hex string.
   */
  static fromPrivateKey(privateKey: string): ContractClient {
    const provider = new ethers.JsonRpcProvider(HEDERA_TESTNET_RPC, undefined, { batchMaxCount: 1 });
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(key, provider);
    return new ContractClient(wallet);
  }

  getAddress(): string {
    return this.wallet.address;
  }

  // ─── Auction Convenience Methods ───────────────────────────────────────

  /**
   * submitBid(uint256 jobId, uint256 bidAmount, uint256 collateralAmount,
   *           uint256 estimatedCompletionTime, string specialization)
   */
  async submitBid(
    jobId: number,
    amount: bigint,
    collateral: bigint,
    estimatedTime: number,
    specialization: string = ""
  ): Promise<ethers.ContractTransactionResponse> {
    return this.auction.submitBid(jobId, amount, collateral, estimatedTime, specialization);
  }

  async getAuction(jobId: number): Promise<AuctionDetails> {
    return this.auction.getJob(jobId);
  }

  /**
   * Event: JobPosted(uint256 jobId, address contractAddress, string contractChain,
   *                  string contractType, uint256 budgetAvailable, uint256 auctionDeadline,
   *                  uint256 initialRiskScore, uint256 lineCount)
   */
  onAuctionCreated(
    callback: (jobId: bigint, contractAddress: string, contractChain: string, contractType: string, budget: bigint, event: ethers.EventLog) => void
  ): void {
    this.auction.on("JobPosted", callback);
  }

  /**
   * Event: WinnersSelected(uint256 jobId, address[] winners, uint256 totalEscrowed, uint256 platformFee)
   */
  onWinnerSelected(
    callback: (jobId: bigint, winners: string[], totalEscrowed: bigint, platformFee: bigint) => void
  ): void {
    this.auction.on("WinnersSelected", callback);
  }

  // ─── SubAuction Convenience Methods ────────────────────────────────────

  /**
   * createSubAuction(uint256 parentJobId, string taskDescription,
   *                  string requiredSpecialization, uint256 paymentAmount,
   *                  uint256 slaDurationSeconds, uint256 auctionDurationSeconds)
   */
  async createSubAuction(
    parentJobId: number,
    taskDescription: string,
    requiredSpecialization: string,
    paymentAmount: bigint,
    slaDuration: number,
    auctionDuration: number = 300 // default 5 min auction window
  ): Promise<ethers.ContractTransactionResponse> {
    return this.subAuction.createSubAuction(
      parentJobId,
      taskDescription,
      requiredSpecialization,
      paymentAmount,
      slaDuration,
      auctionDuration
    );
  }

  /**
   * submitSubBid(uint256 subJobId, uint256 proposedPrice, uint256 estimatedTime, uint256 collateralAmount)
   */
  async submitSubBid(
    subJobId: number,
    proposedPrice: bigint,
    estimatedTime: number = 300,
    collateralAmount: bigint = BigInt(0)
  ): Promise<ethers.ContractTransactionResponse> {
    return this.subAuction.submitSubBid(subJobId, proposedPrice, estimatedTime, collateralAmount);
  }

  /**
   * deliverResult(uint256 subJobId, bytes32 resultHash)
   */
  async deliverResult(
    subJobId: number,
    resultHash: string
  ): Promise<ethers.ContractTransactionResponse> {
    return this.subAuction.deliverResult(subJobId, resultHash);
  }

  /**
   * acceptResult(uint256 subJobId)
   */
  async acceptResult(
    subJobId: number
  ): Promise<ethers.ContractTransactionResponse> {
    return this.subAuction.acceptResult(subJobId);
  }

  /**
   * Event: SubAuctionCreated(uint256 subJobId, uint256 parentJobId, address requester,
   *                          string taskDescription, string requiredSpecialization,
   *                          uint256 paymentAmount, uint256 slaDeadline, uint256 auctionDeadline)
   */
  onSubAuctionCreated(
    callback: (subJobId: bigint, parentJobId: bigint, requester: string, taskDesc: string, spec: string, payment: bigint, slaDeadline: bigint, auctionDeadline: bigint) => void
  ): void {
    this.subAuction.on("SubAuctionCreated", callback);
  }

  // ─── DataMarketplace Convenience Methods ───────────────────────────────

  /**
   * createListing(uint256 parentJobId, string title, string description,
   *               uint8 category, uint8 listingType, uint256 price,
   *               uint256 subscriptionPeriod, bytes32 contentHash,
   *               uint256 maxBuyers, uint256 durationSeconds)
   */
  async createListing(
    parentJobId: number,
    title: string,
    description: string,
    category: number,
    price: bigint,
    contentHash: string,
    listingType: number = ListingType.ONE_TIME,
    subscriptionPeriod: number = 0,
    maxBuyers: number = 100,
    durationSeconds: number = 86400, // 24 hours default
  ): Promise<ethers.ContractTransactionResponse> {
    return this.dataMarketplace.createListing(
      parentJobId,
      title,
      description,
      category,
      listingType,
      price,
      subscriptionPeriod,
      contentHash,
      maxBuyers,
      durationSeconds
    );
  }

  /**
   * purchaseData(uint256 listingId)
   */
  async purchaseData(
    listingId: number
  ): Promise<ethers.ContractTransactionResponse> {
    return this.dataMarketplace.purchaseData(listingId);
  }

  async getListing(listingId: number): Promise<ListingDetails> {
    return this.dataMarketplace.getListing(listingId);
  }

  /**
   * Event: DataListed(uint256 listingId, address seller, uint256 parentJobId,
   *                   string title, uint8 category, uint8 listingType,
   *                   uint256 price, bytes32 contentHash)
   */
  onListingCreated(
    callback: (listingId: bigint, seller: string, parentJobId: bigint, title: string, category: number, listingType: number, price: bigint, contentHash: string) => void
  ): void {
    this.dataMarketplace.on("DataListed", callback);
  }

  /**
   * Event: DataPurchased(uint256 listingId, address buyer, address seller,
   *                      uint256 pricePaid, uint256 platformFee)
   */
  onDataPurchased(
    callback: (listingId: bigint, buyer: string, seller: string, pricePaid: bigint, platformFee: bigint) => void
  ): void {
    this.dataMarketplace.on("DataPurchased", callback);
  }

  // ─── PaymentSettlement Convenience Methods ─────────────────────────────

  /**
   * settleJob(uint256 jobId, PaymentItem[] payments, address reportAgent)
   *
   * PaymentItem = {
   *   address recipient, uint256 basePayment, uint256 bonus,
   *   uint256 reportFee, uint8 paymentType, string description
   * }
   */
  async settleJob(
    jobId: number,
    payments: PaymentItem[],
    reportAgent: string
  ): Promise<ethers.ContractTransactionResponse> {
    return this.paymentSettlement.settleJob(jobId, payments, reportAgent);
  }

  async getReportFeeBase(): Promise<bigint> {
    return this.paymentSettlement.reportFeeBase();
  }

  async getReportFeeDiscounted(): Promise<bigint> {
    return this.paymentSettlement.reportFeeDiscounted();
  }

  // ─── AgentRegistry Convenience Methods ─────────────────────────────────

  /**
   * registerAgent(string agentId, string ucpEndpoint, string[] specializations, uint256 stakeAmount)
   *
   * NOTE: The TDD does not require agent registration.
   * This is provided for completeness but agents will skip if it fails.
   */
  async registerAgent(
    agentId: string,
    ucpEndpoint: string,
    specializations: string[],
    stakeAmount: bigint
  ): Promise<ethers.ContractTransactionResponse> {
    return this.agentRegistry.registerAgent(
      agentId,
      ucpEndpoint,
      specializations,
      stakeAmount
    );
  }

  async getAgent(agentAddress: string): Promise<unknown> {
    return this.agentRegistry.getAgent(agentAddress);
  }

  async isActiveAgent(agentAddress: string): Promise<boolean> {
    return this.agentRegistry.isActiveAgent(agentAddress);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  removeAllListeners(): void {
    this.auction.removeAllListeners();
    this.subAuction.removeAllListeners();
    this.dataMarketplace.removeAllListeners();
    this.paymentSettlement.removeAllListeners();
    this.agentRegistry.removeAllListeners();
    this.budgetVault.removeAllListeners();
  }
}
