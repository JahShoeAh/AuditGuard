// ============================================================
// HCS Message Envelope — every message on any topic uses this
// ============================================================

export interface HCSMessage {
  type: string;
  agentId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// ============================================================
// Discovery Topic Messages
// ============================================================

export interface ContractDiscoveryEvent extends HCSMessage {
  type: "CONTRACT_DISCOVERED";
  payload: {
    contractAddress: string;
    chain: string;
    deployerAddress: string;
    estimatedLOC: number;
    contractType: ContractType;
    riskScore: number;
    budget: number;
    txHash: string;
    sourceRef?: string;
    // ── New fields ──
    evmType?: string;
    standards?: string[];
    contractName?: string | null;
    isProxy?: boolean;
    proxyTarget?: string | null;
    riskSource?: "0g" | "claude" | "heuristic";
    riskModel?: string;
    riskDimensions?: Record<string, number> | null;
    riskRationale?: string;
    topRiskFactors?: string[];
  };
}

export type ContractType =
  | "lending"      // Lending / borrowing protocols (Aave, Compound, MakerDAO)
  | "dex"          // Decentralised exchanges (Uniswap, Curve, SushiSwap)
  | "staking"      // Staking & liquid-staking (Lido, Rocket Pool)
  | "bridge"       // Cross-chain bridges (Hop, Stargate, Across)
  | "vault"        // Yield aggregators / vaults (Yearn, Beefy)
  | "derivatives"  // Perpetuals, options, futures (GMX, dYdX, Synthetix)
  | "oracle"       // Price oracles (Chainlink, Pyth, Band)
  | "governance"   // DAO governance (Governor Bravo, OpenZeppelin Governor)
  | "nft";         // NFT tokens / marketplaces (ERC-721, ERC-1155)

// ============================================================
// AgentComms Topic Messages
// ============================================================

export interface SubAuctionPostedEvent extends HCSMessage {
  type: "SUB_AUCTION_POSTED";
  payload: {
    subAuctionId: string;
    taskType: SubTaskType;
    paymentAmount: number;
    slaDurationSec: number;
    parentJobId: string;
  };
}

export type SubTaskType = "dependency_analysis" | "exploit_db_lookup" | "gas_optimization";

export interface DataListingCreatedEvent extends HCSMessage {
  type: "DATA_LISTING_CREATED";
  payload: {
    listingId: string;
    category: DataCategory;
    price: number;
    description: string;
    jobId: string;
  };
}

export type DataCategory = "SCAN_REPORT" | "DEPENDENCY_TREE" | "HOT_LEAD" | "VULN_DB";

export interface FindingsSubmittedEvent extends HCSMessage {
  type: "FINDINGS_SUBMITTED";
  payload: {
    jobId: string;
    findingsHash: string;
    findingsCount: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    inferenceSource?: "0g" | "mock";
    providerAddress?: string;
    model?: string;
    requestId?: string;
    usedFallback?: boolean;
  };
}

export interface SubResultDeliveredEvent extends HCSMessage {
  type: "SUB_RESULT_DELIVERED";
  payload: {
    subAuctionId: string;
    resultHash: string;
    deliveredBy: string;
  };
}

// ============================================================
// AuditLog Topic Messages
// ============================================================

export type AuditLogType =
  | "AUCTION_CREATED"
  | "BID_SUBMITTED"
  | "BID_SKIPPED"
  | "BID_SUBMISSION_FAILED"
  | "AUCTION_INVITE_SUMMARY"
  | "LLM_PROVIDER_READY"
  | "LLM_PROVIDER_UNHEALTHY"
  | "LLM_INFERENCE_STARTED"
  | "LLM_INFERENCE_SUCCEEDED"
  | "LLM_INFERENCE_FAILED"
  | "WINNER_SELECTED"
  | "SUB_AUCTION_CREATED"
  | "SUB_BID_SUBMITTED"
  | "SUB_WINNER_SELECTED"
  | "SUB_RESULT_DELIVERED"
  | "SUB_RESULT_ACCEPTED"
  | "DATA_LISTED"
  | "DATA_PURCHASED"
  | "PAYMENT_SETTLED"
  | "REPORT_PUBLISHED"
  | "REPUTATION_UPDATED"
  | "ALERT_FIRED";

export interface AuditLogEntry extends HCSMessage {
  type: AuditLogType;
  payload: Record<string, unknown>;
}

// ============================================================
// Agent Definitions
// ============================================================

export type AgentRole =
  | "scanner"
  | "static_analysis"
  | "fuzzer"
  | "llm_contextual"
  | "dependency"
  | "report"
  | "alert";

export type AgentTier = "COMMODITY" | "SPECIALIZED" | "PREMIUM";

export interface AgentProfile {
  id: string;
  role: AgentRole;
  tier: AgentTier;
  reputation: number;         // 0-100
  specializations: ContractType[];
  stakedGuard: number;
  completedJobs: number;
  accuracyRate: number;       // 0-1
}

// ============================================================
// Findings & Reports
// ============================================================

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  confidence: number;         // 0-1
  agentId: string;
  timestamp: number;
}

export interface AuditReport {
  jobId: string;
  contractAddress: string;
  findings: Finding[];
  totalFindings: number;
  duplicatesDetected: number;
  agentScores: Record<string, number>;  // agentId -> accuracy
  reportHash: string;
  timestamp: number;
}

// ============================================================
// Bidding
// ============================================================

export interface BidParams {
  jobId: string;
  amount: number;             // GUARD tokens
  collateral: number;         // GUARD staked
  estimatedTimeSec: number;
  agentId: string;
}

// ============================================================
// On-chain event types (from contract events)
// ============================================================

export interface AuctionCreatedEvent {
  jobId: string;
  contractAddress: string;
  budget: number;
  deadline: number;
}

export interface WinnerSelectedEvent {
  jobId: string;
  winners: string[];          // agent addresses
  amounts: number[];          // payment amounts
}

export interface PaymentSettledEvent {
  jobId: string;
  recipients: string[];
  amounts: number[];
  bonuses: number[];
}
