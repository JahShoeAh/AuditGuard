/**
 * AuditGuard iNFT Type Definitions
 *
 * These types mirror the JSON schemas in ./schemas/ and define the three
 * core iNFT structures used throughout the AuditGuard autonomous marketplace.
 *
 * Design principle: iNFTs REFERENCE on-chain contract state (AgentRegistry,
 * AuditAuction) by ID/address rather than duplicating it. They ADD:
 *   - State evolution history (contracts only store current values)
 *   - Off-chain data references (0g Labs DA layer)
 *   - Autonomous intelligence parameters (pricing, risk prediction)
 *   - Cross-entity linking (job <-> agent <-> contract health)
 */

// ─── Shared Types ────────────────────────────────────────────────────────────

export type Chain = 'hedera' | 'ethereum' | 'polygon' | 'arbitrum' | 'optimism' | 'bsc';

export interface StateTransition {
  from: string;
  to: string;
  timestamp: string; // ISO 8601
  trigger: string;
  txHash?: string;
}

// ─── Audit Job iNFT ──────────────────────────────────────────────────────────

export type AuditJobState =
  | 'DISCOVERED'
  | 'AUCTION_OPEN'
  | 'BIDDING_CLOSED'
  | 'AUDITING_IN_PROGRESS'
  | 'REPORT_PENDING'
  | 'COMPLETED'
  | 'VULNERABILITIES_ACTIVE'
  | 'REMEDIATION_VERIFIED'
  | 'MONITORING_ACTIVE'
  | 'CANCELLED';

export type DiscoveryTrigger =
  | 'new_deployment'
  | 'code_update'
  | 'tvl_threshold'
  | 'manual_request'
  | 're_audit_schedule';

export type ParticipantRole =
  | 'primary_auditor'
  | 'sub_contractor'
  | 'data_seller'
  | 'scanner'
  | 'report_aggregator';

export type PaymentType =
  | 'main_audit'
  | 'sub_contract'
  | 'data_purchase'
  | 'bonus_speed'
  | 'bonus_unique_finding'
  | 'platform_fee';

export interface AuditJobTarget {
  contractAddress: string;
  chain: Chain;
  contractType?: string;
  lineCount?: number;
  codeHash?: string;
}

export interface AuditJobDiscovery {
  scannerAgentId: string;
  timestamp: string;
  initialRiskScore: number; // 0-100
  hcsMessageId?: string;
  discoveryTrigger?: DiscoveryTrigger;
}

export interface AuditJobParticipant {
  agentAddress: string;
  agentId?: string;
  role: ParticipantRole;
  specialization?: string;
  bidAmount?: number;
  reputationAtBid?: number; // basis points 0-10000
  findingsSubmitted?: number;
  paymentReceived?: number;
}

export interface AgentReport {
  agentAddress: string;
  reportHash: string;
  storageRef?: string; // 0g Labs DA reference
  submittedAt: string;
  validFindings: number;
  falsePositives: number;
  falseNegatives: number;
  accuracyScore: number; // 0-100
}

export interface FindingsSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  total: number;
  duplicatesDetected: number;
}

export interface PaymentBreakdown {
  recipient: string;
  type: PaymentType;
  amount: number;
}

export interface AuditJobINFT {
  schemaVersion: '1.0.0';
  tokenId: string;
  jobId: number;
  target: AuditJobTarget;
  discovery: AuditJobDiscovery;
  state: {
    current: AuditJobState;
    history: StateTransition[];
  };
  auction?: {
    deadline: string;
    budgetGuard: number;
    totalBids: number;
    winningAgents: string[];
    platformFeePaid: number;
  };
  participants: AuditJobParticipant[];
  reports: {
    finalReportHash?: string;
    reportStorageRef?: string; // 0g Labs DA reference
    hcsReportMessageId?: string;
    findings: FindingsSummary;
    agentReports?: AgentReport[];
  };
  payments?: {
    totalPaid: number;
    platformFee: number;
    settlementTxHash?: string;
    settledAt?: string;
    breakdown: PaymentBreakdown[];
  };
  reaudit?: {
    previousAuditJobIds: number[];
    codeChangeDetected: boolean;
    recommendedReauditDate?: string;
    estimatedBudget?: number;
  };
  createdAt: string;
  updatedAt: string;
}

// ─── Agent Profile iNFT ──────────────────────────────────────────────────────

export type AgentTier = 'COMMODITY' | 'SPECIALIZED' | 'PREMIUM';
export type AgentStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'SLASHED';

export type AgentINFTState =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'BUSY'
  | 'COOLDOWN'
  | 'SUSPENDED'
  | 'SLASHED'
  | 'DEREGISTERED';

export type ReputationChangeReason =
  | 'job_completion'
  | 'valid_findings_bonus'
  | 'false_positive_penalty'
  | 'false_negative_penalty'
  | 'slash_penalty'
  | 'sub_contract_completion'
  | 'sub_contract_expired'
  | 'seed_initial';

export interface ReputationChange {
  timestamp: string;
  delta: number; // basis points, can be negative
  newScore: number; // 0-10000
  reason: ReputationChangeReason;
  jobId?: number;
  txHash?: string;
}

export interface SpecialtyScore {
  score: number; // 0-100
  jobsCompleted: number;
  lastUpdated: string;
}

export interface PricingStrategy {
  baseBidMultiplier: number; // 0.1-5.0
  reputationDiscountThreshold: number; // basis points
  discountPercent: number; // 0-50
  premiumMarkup: number; // 0-100
  maxConcurrentJobs: number;
}

export interface PortfolioState {
  activeJobs: number[];
  pendingBids: number[];
  preferredContractTypes: string[];
}

export interface JobHistoryEntry {
  jobId: number;
  role: 'primary_auditor' | 'sub_contractor' | 'data_seller';
  completedAt: string;
  payment: number;
  validFindings: number;
  reputationDelta: number;
}

export interface AgentProfileINFT {
  schemaVersion: '1.0.0';
  tokenId: string;
  agentAddress: string;
  agentId: string;
  identity: {
    ucpEndpoint: string;
    specializations: string[];
    tier: AgentTier;
    status?: AgentStatus;
    registeredAt?: string;
  };
  reputation: {
    current: number; // 0-10000 basis points
    history: ReputationChange[];
    trend?: 'rising' | 'stable' | 'declining';
    peakScore?: number;
    specialtyScores?: Record<string, SpecialtyScore>;
  };
  performance: {
    completedJobs: number;
    successfulFindings: number;
    falsePositives: number;
    falseNegatives: number;
    accuracyRate?: number; // 0-100
    averageCompletionTime?: number; // seconds
    auctionsWon: number;
    auctionsParticipated: number;
    winRate?: number; // 0-100
    subContractsCompleted?: number;
    dataListingsSold?: number;
    jobHistory?: JobHistoryEntry[];
  };
  economics: {
    stakedAmount: number;
    totalEarned: number;
    totalSlashed: number;
    pricing?: PricingStrategy;
    portfolio?: PortfolioState;
  };
  state: {
    current: AgentINFTState;
    history?: StateTransition[];
  };
  createdAt: string;
  updatedAt: string;
}

// ─── Contract Health iNFT ────────────────────────────────────────────────────

export type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type VulnerabilityCategory =
  | 'reentrancy'
  | 'access_control'
  | 'integer_overflow'
  | 'logic_error'
  | 'oracle_manipulation'
  | 'front_running'
  | 'denial_of_service'
  | 'flash_loan'
  | 'storage_collision'
  | 'uninitialized_proxy'
  | 'other';

export type VulnerabilityStatus =
  | 'open'
  | 'acknowledged'
  | 'remediated'
  | 'accepted_risk'
  | 'false_positive';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'minimal';

export type ContractHealthState =
  | 'UNAUDITED'
  | 'AUDIT_IN_PROGRESS'
  | 'AUDITED'
  | 'MONITORING_ACTIVE'
  | 'AT_RISK'
  | 'COMPROMISED';

export type RiskFactor =
  | 'code_change_velocity'
  | 'time_since_audit'
  | 'tvl_increase'
  | 'ecosystem_exploit_trend'
  | 'dependency_vulnerability'
  | 'unresolved_critical_vuln';

export interface Vulnerability {
  id: string; // e.g., AG-VULN-001
  severity: VulnerabilitySeverity;
  category: VulnerabilityCategory;
  title: string;
  status: VulnerabilityStatus;
  discoveredAt: string;
  discoveredByAgent?: string;
  discoveredInJobId?: number;
  remediatedAt?: string;
  detailsStorageRef?: string; // 0g Labs DA reference
}

export interface AuditHistoryEntry {
  jobId: number;
  auditJobTokenId?: string;
  completedAt: string;
  agentsInvolved: string[];
  findingsCount: number;
  criticalFindings: number;
  securityScoreBefore: number;
  securityScoreAfter: number;
  totalCostGuard: number;
  reportHash?: string;
}

export interface ContractHealthINFT {
  schemaVersion: '1.0.0';
  tokenId: string;
  contract: {
    contractAddress: string;
    chain: Chain;
    contractType?: string;
    deployer?: string;
    deployedAt?: string;
    currentCodeHash?: string;
  };
  health: {
    securityScore: number; // 0-100
    scoreHistory: Array<{
      score: number;
      timestamp: string;
      jobId: number;
      delta?: number;
    }>;
    riskLevel: RiskLevel;
    lastAuditTimestamp?: string;
    totalAuditsCompleted: number;
  };
  vulnerabilities: {
    summary: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      informational: number;
      total: number;
      remediated: number;
      open: number;
    };
    catalog: Vulnerability[];
  };
  auditHistory: AuditHistoryEntry[];
  monitoring: {
    isActive: boolean;
    monitoringAgent?: string;
    weeklyBudgetGuard?: number;
    monitoringSince?: string;
    lastCheckIn?: string;
  };
  intelligence?: {
    predictedRiskChange?: number;
    riskFactors?: Array<{
      factor: RiskFactor;
      weight: number; // 0-1
      value: string;
    }>;
    autoReauditTriggered: boolean;
    nextRecommendedAudit?: string;
  };
  budget?: {
    vaultAddress: string;
    currentBalance: number;
    totalDeposited: number;
    totalSpent: number;
  };
  state: {
    current: ContractHealthState;
    history?: StateTransition[];
  };
  createdAt: string;
  updatedAt: string;
}
