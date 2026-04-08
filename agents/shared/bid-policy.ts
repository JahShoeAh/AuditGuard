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

/**
 * Extends BidPolicy with a configurable floor expressed as a fraction of the job
 * budget. Agents will not bid below `inviteBudget × maxBidFractionOfBudget` even
 * when undercutting competitors.
 *
 * NOTE: AuditAuction only allows one bid per agent per job. "Competitive bidding"
 * is therefore implemented as a scouting window — the agent observes competitor
 * bids on the HCS auditLog topic before submitting its single on-chain bid.
 */
export interface RebidPolicy extends BidPolicy {
  /**
   * Floor bid as a fraction of job budget (e.g. 0.25 = 25%).
   * Configurable per-agent via the MAX_BID_FRACTION_OF_BUDGET env var.
   */
  maxBidFractionOfBudget: number;
}

/**
 * Compute the optimal bid after a scouting window.
 *
 * If lowestCompetitorBid is provided and lower than the strategy bid, this
 * undercuts that value by 5 %, clamped to floor = budget × maxBidFractionOfBudget.
 * When no competitor data is available, the result is identical to computeLiveBid.
 */
export function computeScoutedBid(
  strategyBid: StrategyBid,
  inviteBudget: unknown,
  lowestCompetitorBid: number | null,
  policy: RebidPolicy
): { bid?: ComputedLiveBid; skip?: BidSkipDecision } {
  const normalizedBudget = safeBudget(inviteBudget);

  // Start from the policy-capped base bid (budget cap + collateral floor).
  const base = computeLiveBid(strategyBid, inviteBudget, policy);
  if (base.skip || !base.bid) return base;

  let amount = base.bid.amount;

  // Floor: budget × fraction, or 0 when budget is unknown.
  const floorFraction = Math.max(0, Math.min(1, policy.maxBidFractionOfBudget));
  const floor =
    normalizedBudget != null && normalizedBudget > 0
      ? roundGuard(normalizedBudget * floorFraction)
      : 0;

  // Undercut lowest observed competitor if they beat us.
  if (
    lowestCompetitorBid != null &&
    lowestCompetitorBid > 0 &&
    lowestCompetitorBid < amount
  ) {
    const undercutAmount = roundGuard(lowestCompetitorBid * 0.95);
    amount = floor > 0 ? Math.max(floor, undercutAmount) : Math.max(0.01, undercutAmount);
  }

  if (amount <= 0) {
    return {
      skip: {
        shouldSkip: true,
        reasonCode: "invalid_bid_amount",
        reason: "Computed scouted bid amount is not positive",
      },
    };
  }

  const minCollateral = roundGuard(
    safeGuard(policy.minCollateralGuard) + safeGuard(policy.collateralBufferGuard)
  );
  const collateral = Math.max(base.bid.collateral, minCollateral);

  return {
    bid: {
      amount,
      collateral,
      estimatedTimeSec: base.bid.estimatedTimeSec,
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
  if (message.includes("insufficient funds for transfer")) return "insufficient_payer_hbar";
  if (message.includes("insufficient payer balance")) return "insufficient_payer_hbar";
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
