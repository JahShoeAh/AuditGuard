import { parseUnits } from "ethers";

export interface StrategyBid {
  amount: number;
  collateral: number;
  estimatedTimeSec: number;
}

export interface BidPolicy {
  minCollateralGuard: number;
  collateralBufferGuard: number;
  enforceBudgetCap: boolean;
}

export interface ComputedLiveBid {
  amount: number;
  collateral: number;
  estimatedTimeSec: number;
  amountWei: bigint;
  collateralWei: bigint;
  inviteBudget: number | null;
}

export interface BidSkipDecision {
  shouldSkip: boolean;
  reasonCode?: string;
  reason?: string;
}

function roundGuard(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeGuard(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function safeBudget(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return roundGuard(Math.max(0, n));
}

export function computeLiveBid(
  strategyBid: StrategyBid,
  inviteBudget: unknown,
  policy: BidPolicy
): { bid?: ComputedLiveBid; skip?: BidSkipDecision } {
  const normalizedBudget = safeBudget(inviteBudget);
  let amount = roundGuard(safeGuard(strategyBid.amount));
  let collateral = roundGuard(safeGuard(strategyBid.collateral));
  const minCollateral = roundGuard(
    safeGuard(policy.minCollateralGuard) + safeGuard(policy.collateralBufferGuard)
  );

  if (amount <= 0) {
    return {
      skip: {
        shouldSkip: true,
        reasonCode: "invalid_bid_amount",
        reason: "Computed bid amount is not positive",
      },
    };
  }

  if (policy.enforceBudgetCap && normalizedBudget != null) {
    if (normalizedBudget <= 0) {
      return {
        skip: {
          shouldSkip: true,
          reasonCode: "invalid_budget",
          reason: "Invite budget is zero or missing",
        },
      };
    }
    if (amount > normalizedBudget) {
      amount = normalizedBudget;
    }
  }

  collateral = Math.max(collateral, minCollateral);

  return {
    bid: {
      amount,
      collateral,
      estimatedTimeSec: strategyBid.estimatedTimeSec,
      amountWei: parseUnits(amount.toFixed(2), 8),
      collateralWei: parseUnits(collateral.toFixed(2), 8),
      inviteBudget: normalizedBudget,
    },
  };
}

export function normalizeBidFailureReasonCode(error: unknown): string {
  const message = String(error ?? "").toLowerCase();

  if (message.includes("bid already submitted")) return "duplicate_bid";
  if (message.includes("collateral below minimum")) return "collateral_below_minimum";
  if (message.includes("inactive agent")) return "inactive_agent";
  if (message.includes("bid exceeds budget")) return "bid_exceeds_budget";
  if (message.includes("auction expired")) return "auction_expired";
  if (message.includes("job does not exist")) return "job_not_found";
  if (message.includes("insufficient funds")) return "insufficient_funds";
  if (message.includes("nonce")) return "nonce_conflict";
  if (message.includes("server response 5")) return "network_error";
  if (message.includes("bad gateway")) return "network_error";
  if (message.includes("gateway")) return "network_error";
  if (message.includes("network")) return "network_error";
  if (message.includes("timeout")) return "network_timeout";
  if (message.includes("execution reverted")) return "contract_revert";

  return "unknown_error";
}

export function isRetriableBidFailure(error: unknown): boolean {
  const message = String(error ?? "").toLowerCase();
  const reasonCode = normalizeBidFailureReasonCode(error);

  if (reasonCode === "network_error" || reasonCode === "network_timeout" || reasonCode === "nonce_conflict") {
    return true;
  }

  if (message.includes("502 bad gateway")) return true;
  if (message.includes("503")) return true;
  if (message.includes("504")) return true;
  if (message.includes("server response 5")) return true;
  if (message.includes("temporarily unavailable")) return true;
  if (message.includes("fetch failed")) return true;
  if (message.includes("enotfound")) return true;
  if (message.includes("econnreset")) return true;
  if (message.includes("etimedout")) return true;
  if (message.includes("replacement fee too low")) return true;

  return false;
}
