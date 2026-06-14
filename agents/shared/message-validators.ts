import { ethers } from "ethers";
import type {
  HCSMessage,
  ContractDiscoveryEvent,
  SubAuctionPostedEvent,
  DataListingCreatedEvent,
  FindingsSubmittedEvent,
  SubResultDeliveredEvent,
  ContractType,
  SubTaskType,
  DataCategory,
} from "./types.js";

// ============================================================
// Validation Utilities
// ============================================================

function isValidEVMAddress(address: unknown): address is string {
  return typeof address === "string" && ethers.isAddress(address);
}

function isValidNumber(value: unknown, min?: number, max?: number): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function isValidString(value: unknown, maxLength = 1000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isValidContractType(value: unknown): value is ContractType {
  const validTypes: ContractType[] = [
    "lending",
    "dex",
    "staking",
    "bridge",
    "vault",
    "derivatives",
    "oracle",
    "governance",
    "nft",
    "unknown",
  ];
  return typeof value === "string" && validTypes.includes(value as ContractType);
}

function isValidSubTaskType(value: unknown): value is SubTaskType {
  const validTypes: SubTaskType[] = [
    "dependency_analysis",
    "exploit_db_lookup",
    "gas_optimization",
  ];
  return typeof value === "string" && validTypes.includes(value as SubTaskType);
}

function isValidDataCategory(value: unknown): value is DataCategory {
  const validCategories: DataCategory[] = [
    "SCAN_REPORT",
    "DEPENDENCY_TREE",
    "HOT_LEAD",
    "VULN_DB",
  ];
  return typeof value === "string" && validCategories.includes(value as DataCategory);
}

// ============================================================
// Message Type Guards
// ============================================================

export interface AuctionInvitePayload {
  jobId: string | number;
  contractAddress: string;
  deployerAddress?: string;
  contractType?: ContractType;
  riskScore?: number;
  estimatedLOC?: number;
  estimatedLineCount?: number;
  budget?: number;
  auctionDeadlineSec?: number;
  eligibleAgentIds?: string[];
  eligibleEvmAddresses?: string[];
  minBidCollateralGuard?: number;
}

export function parseAuctionInvite(msg: unknown): AuctionInvitePayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "AUCTION_INVITE") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { jobId, contractAddress } = payload;

  // Required fields
  if (jobId === undefined || jobId === null) return null;
  if (!isValidEVMAddress(contractAddress)) return null;

  // Optional fields with validation
  const deployerAddress = payload.deployerAddress;
  if (deployerAddress !== undefined && !isValidEVMAddress(deployerAddress)) {
    return null;
  }

  const contractType = payload.contractType;
  if (contractType !== undefined && !isValidContractType(contractType)) {
    return null;
  }

  const riskScore = payload.riskScore;
  if (riskScore !== undefined && !isValidNumber(riskScore, 0, 100)) {
    return null;
  }

  const estimatedLOC = payload.estimatedLOC;
  if (estimatedLOC !== undefined && !isValidNumber(estimatedLOC, 0, 10_000_000)) {
    return null;
  }

  const estimatedLineCount = payload.estimatedLineCount;
  if (estimatedLineCount !== undefined && !isValidNumber(estimatedLineCount, 0, 10_000_000)) {
    return null;
  }

  const budget = payload.budget;
  if (budget !== undefined && !isValidNumber(budget, 0)) {
    return null;
  }

  const auctionDeadlineSec = payload.auctionDeadlineSec;
  if (auctionDeadlineSec !== undefined && !isValidNumber(auctionDeadlineSec, 0)) {
    return null;
  }

  const minBidCollateralGuard = payload.minBidCollateralGuard;
  if (minBidCollateralGuard !== undefined && !isValidNumber(minBidCollateralGuard, 0)) {
    return null;
  }

  // Array fields
  const eligibleAgentIds = payload.eligibleAgentIds;
  if (eligibleAgentIds !== undefined && !Array.isArray(eligibleAgentIds)) {
    return null;
  }

  const eligibleEvmAddresses = payload.eligibleEvmAddresses;
  if (eligibleEvmAddresses !== undefined && !Array.isArray(eligibleEvmAddresses)) {
    return null;
  }

  return {
    jobId,
    contractAddress,
    deployerAddress: deployerAddress as string | undefined,
    contractType: contractType as ContractType | undefined,
    riskScore: riskScore as number | undefined,
    estimatedLOC: estimatedLOC as number | undefined,
    estimatedLineCount: estimatedLineCount as number | undefined,
    budget: budget as number | undefined,
    auctionDeadlineSec: auctionDeadlineSec as number | undefined,
    eligibleAgentIds: eligibleAgentIds as string[] | undefined,
    eligibleEvmAddresses: eligibleEvmAddresses as string[] | undefined,
    minBidCollateralGuard: minBidCollateralGuard as number | undefined,
  };
}

export interface BidSubmittedPayload {
  jobId: string | number;
  agentId: string;
  bidAmount: number;
  collateral?: number;
  estimatedTimeSec?: number;
}

export function parseBidSubmitted(msg: unknown): BidSubmittedPayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "BID_SUBMITTED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { jobId, agentId, bidAmount, collateral, estimatedTimeSec } = payload;

  if (jobId === undefined || jobId === null) return null;
  if (!isValidString(agentId, 100)) return null;
  if (!isValidNumber(bidAmount, 0)) return null;

  if (collateral !== undefined && !isValidNumber(collateral, 0)) return null;
  if (estimatedTimeSec !== undefined && !isValidNumber(estimatedTimeSec, 0)) return null;

  return {
    jobId,
    agentId,
    bidAmount,
    collateral: collateral as number | undefined,
    estimatedTimeSec: estimatedTimeSec as number | undefined,
  };
}

export function parseContractDiscovery(msg: unknown): ContractDiscoveryEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<ContractDiscoveryEvent>;
  if (m.type !== "CONTRACT_DISCOVERED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { contractAddress, chain, deployerAddress, estimatedLOC, contractType, riskScore, budget, txHash } = payload;

  // Required fields
  if (!isValidEVMAddress(contractAddress)) return null;
  if (!isValidString(chain, 50)) return null;
  if (!isValidEVMAddress(deployerAddress)) return null;
  if (!isValidNumber(estimatedLOC, 0, 10_000_000)) return null;
  if (!isValidContractType(contractType)) return null;
  if (!isValidNumber(riskScore, 0, 100)) return null;
  if (!isValidNumber(budget, 0)) return null;
  if (!isValidString(txHash, 200)) return null;

  return {
    type: "CONTRACT_DISCOVERED",
    agentId: m.agentId ?? "",
    timestamp: m.timestamp ?? Date.now(),
    payload: {
      contractAddress,
      chain,
      deployerAddress,
      estimatedLOC,
      contractType,
      riskScore,
      budget,
      txHash,
      sourceRef: payload.sourceRef as string | undefined,
      evmType: payload.evmType as string | undefined,
      standards: Array.isArray(payload.standards) ? payload.standards as string[] : undefined,
      contractName: payload.contractName as string | null | undefined,
      isProxy: typeof payload.isProxy === "boolean" ? payload.isProxy : undefined,
      proxyTarget: payload.proxyTarget as string | null | undefined,
      riskSource: payload.riskSource as "0g" | "claude" | "heuristic" | undefined,
      riskModel: payload.riskModel as string | undefined,
      riskDimensions: payload.riskDimensions as Record<string, number> | null | undefined,
      riskRationale: payload.riskRationale as string | undefined,
      topRiskFactors: Array.isArray(payload.topRiskFactors) ? payload.topRiskFactors as string[] : undefined,
    },
  };
}

export function parseSubAuctionPosted(msg: unknown): SubAuctionPostedEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<SubAuctionPostedEvent>;
  if (m.type !== "SUB_AUCTION_POSTED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { subAuctionId, taskType, paymentAmount, slaDurationSec, parentJobId } = payload;

  if (!isValidString(subAuctionId, 200)) return null;
  if (!isValidSubTaskType(taskType)) return null;
  if (!isValidNumber(paymentAmount, 0)) return null;
  if (!isValidNumber(slaDurationSec, 0)) return null;
  if (!isValidString(parentJobId, 200)) return null;

  return {
    type: "SUB_AUCTION_POSTED",
    agentId: m.agentId ?? "",
    timestamp: m.timestamp ?? Date.now(),
    payload: {
      subAuctionId,
      taskType,
      paymentAmount,
      slaDurationSec,
      parentJobId,
    },
  };
}

export function parseDataListingCreated(msg: unknown): DataListingCreatedEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<DataListingCreatedEvent>;
  if (m.type !== "DATA_LISTING_CREATED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { listingId, category, price, description, jobId } = payload;

  if (!isValidString(listingId, 200)) return null;
  if (!isValidDataCategory(category)) return null;
  if (!isValidNumber(price, 0)) return null;
  if (!isValidString(description, 2000)) return null;
  if (!isValidString(jobId, 200)) return null;

  return {
    type: "DATA_LISTING_CREATED",
    agentId: m.agentId ?? "",
    timestamp: m.timestamp ?? Date.now(),
    payload: {
      listingId,
      category,
      price,
      description,
      jobId,
    },
  };
}

export function parseFindingsSubmitted(msg: unknown): FindingsSubmittedEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<FindingsSubmittedEvent>;
  if (m.type !== "FINDINGS_SUBMITTED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const {
    jobId,
    findingsHash,
    findingsCount,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  } = payload;

  if (!isValidString(jobId, 200)) return null;
  if (!isValidString(findingsHash, 200)) return null;
  if (!isValidNumber(findingsCount, 0, 10000)) return null;
  if (!isValidNumber(criticalCount, 0, 10000)) return null;
  if (!isValidNumber(highCount, 0, 10000)) return null;
  if (!isValidNumber(mediumCount, 0, 10000)) return null;
  if (!isValidNumber(lowCount, 0, 10000)) return null;

  return {
    type: "FINDINGS_SUBMITTED",
    agentId: m.agentId ?? "",
    timestamp: m.timestamp ?? Date.now(),
    payload: {
      jobId,
      findingsHash,
      findingsCount,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      isMock: typeof payload.isMock === "boolean" ? payload.isMock : undefined,
      inferenceSource: payload.inferenceSource as "0g" | "mock" | undefined,
      providerAddress: payload.providerAddress as string | undefined,
      model: payload.model as string | undefined,
      requestId: payload.requestId as string | undefined,
      usedFallback: typeof payload.usedFallback === "boolean" ? payload.usedFallback : undefined,
    },
  };
}

export function parseSubResultDelivered(msg: unknown): SubResultDeliveredEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<SubResultDeliveredEvent>;
  if (m.type !== "SUB_RESULT_DELIVERED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { subAuctionId, resultHash, deliveredBy } = payload;

  if (!isValidString(subAuctionId, 200)) return null;
  if (!isValidString(resultHash, 200)) return null;
  if (!isValidString(deliveredBy, 100)) return null;

  return {
    type: "SUB_RESULT_DELIVERED",
    agentId: m.agentId ?? "",
    timestamp: m.timestamp ?? Date.now(),
    payload: {
      subAuctionId,
      resultHash,
      deliveredBy,
    },
  };
}

export interface ReportPublishedPayload {
  jobId: string;
  contractAddress: string;
  reportHash: string;
  totalFindings: number;
  duplicatesDetected: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export function parseReportPublished(msg: unknown): ReportPublishedPayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "REPORT_PUBLISHED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const {
    jobId,
    contractAddress,
    reportHash,
    totalFindings,
    duplicatesDetected,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  } = payload;

  if (!isValidString(jobId, 200)) return null;
  if (!isValidEVMAddress(contractAddress)) return null;
  if (!isValidString(reportHash, 200)) return null;
  if (!isValidNumber(totalFindings, 0, 10000)) return null;
  if (!isValidNumber(duplicatesDetected, 0, 10000)) return null;
  if (!isValidNumber(criticalCount, 0, 10000)) return null;
  if (!isValidNumber(highCount, 0, 10000)) return null;
  if (!isValidNumber(mediumCount, 0, 10000)) return null;
  if (!isValidNumber(lowCount, 0, 10000)) return null;

  return {
    jobId,
    contractAddress,
    reportHash,
    totalFindings,
    duplicatesDetected,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}

export interface PingPayload {
  nonce?: string;
  timestamp?: number;
}

export function parsePing(msg: unknown): PingPayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "PING") return null;

  // PING can have empty or minimal payload
  return {
    nonce: typeof m.payload?.nonce === "string" ? m.payload.nonce : undefined,
    timestamp: typeof m.payload?.timestamp === "number" ? m.payload.timestamp : undefined,
  };
}

export interface WinnersSelectedPayload {
  jobId: string | number;
  selectedAgents: string[];
  finalPrices?: number[];
}

export function parseWinnersSelected(msg: unknown): WinnersSelectedPayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "WINNERS_SELECTED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { jobId, selectedAgents, finalPrices } = payload;

  if (jobId === undefined || jobId === null) return null;
  if (!Array.isArray(selectedAgents)) return null;

  if (finalPrices !== undefined && !Array.isArray(finalPrices)) return null;

  return {
    jobId,
    selectedAgents,
    finalPrices: finalPrices as number[] | undefined,
  };
}

export interface JobCancelledPayload {
  jobId: string | number;
  reason?: string;
}

export function parseJobCancelled(msg: unknown): JobCancelledPayload | null {
  if (!msg || typeof msg !== "object") return null;

  const m = msg as Partial<HCSMessage>;
  if (m.type !== "JOB_CANCELLED") return null;

  const payload = m.payload as Record<string, unknown>;
  if (!payload) return null;

  const { jobId, reason } = payload;

  if (jobId === undefined || jobId === null) return null;

  return {
    jobId,
    reason: typeof reason === "string" ? reason : undefined,
  };
}
