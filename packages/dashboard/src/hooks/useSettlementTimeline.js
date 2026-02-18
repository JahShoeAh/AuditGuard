import { useMemo } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── Payment type display config ─────────────────────────────
export const PAYMENT_TYPE_CONFIG = {
  MAIN_AUDIT:            { label: 'Main Audit',      color: '#d97706' },
  SUB_CONTRACT:          { label: 'Sub-Contract',    color: '#a855f7' },
  DATA_PURCHASE:         { label: 'Data Purchase',   color: '#14b8a6' },
  BONUS_SPEED:           { label: 'Speed Bonus',     color: '#22c55e' },
  BONUS_UNIQUE_FINDING:  { label: 'Unique Bonus',    color: '#4ade80' },
  PLATFORM_FEE:          { label: 'Platform Fee',    color: '#6b7280' },
  REPORT_FEE:            { label: 'Report Fee',      color: '#6366f1' },
};

// Ordered for consistent stack rendering (largest first at bottom)
export const PAYMENT_TYPE_ORDER = [
  'MAIN_AUDIT',
  'BONUS_UNIQUE_FINDING',
  'BONUS_SPEED',
  'SUB_CONTRACT',
  'DATA_PURCHASE',
  'REPORT_FEE',
  'PLATFORM_FEE',
];

// ── useSettlementTimeline ────────────────────────────────────

/**
 * Returns:
 *   timelineData: TimelineBar[]
 *   stats: { totalJobs, totalDisbursed, avgDisbursed, avgRecipients, platformRevenue }
 *   maxBarTotal: number (for Y-axis scaling)
 *
 * TimelineBar: {
 *   settlementId, jobId, timestamp, totalDisbursed,
 *   breakdown: { [type]: number (raw GUARD) },
 *   settlement: SettlementRecord,
 * }
 */
export function useSettlementTimeline() {
  const settlements = useStore((s) => s.settlements);
  const guardFlows  = useStore((s) => s.guardFlows);

  return useMemo(() => {
    const settlementList = Object.values(settlements);

    if (settlementList.length === 0) {
      return {
        timelineData: [],
        stats: { totalJobs: 0, totalDisbursed: 0, avgDisbursed: 0, avgRecipients: 0, platformRevenue: 0 },
        maxBarTotal: 0,
      };
    }

    // Sort by settlement time
    const sorted = settlementList
      .slice()
      .sort((a, b) => (a.settledAt || a.timestamp || 0) - (b.settledAt || b.timestamp || 0));

    // Build a bar per settlement
    const timelineData = sorted.map((settlement) => {
      const jobFlows = guardFlows.filter((f) => f.jobId === settlement.jobId);

      // Aggregate by payment type
      const breakdown = {};
      for (const flow of jobFlows) {
        const type = flow.type || 'MAIN_AUDIT';
        breakdown[type] = (breakdown[type] || 0) + Number(flow.amount || 0);
      }

      // If no flows recorded yet, fall back to totalDisbursed as MAIN_AUDIT
      if (Object.keys(breakdown).length === 0) {
        breakdown['MAIN_AUDIT'] = Number(settlement.totalDisbursed || 0);
      }

      const barTotal = Object.values(breakdown).reduce((s, v) => s + v, 0);

      return {
        settlementId: settlement.settlementId,
        jobId: settlement.jobId,
        timestamp: settlement.settledAt || settlement.timestamp || 0,
        totalDisbursed: Number(settlement.totalDisbursed || 0),
        totalDisbursedFormatted: settlement.totalDisbursedFormatted || fmt.guardWithSymbol(settlement.totalDisbursed),
        recipientCount: settlement.recipientCount || 0,
        breakdown,
        barTotal,
        settlement,
      };
    });

    // ── Stats ─────────────────────────────────────────────

    const totalDisbursed = timelineData.reduce((s, b) => s + b.totalDisbursed, 0);
    const avgDisbursed   = totalDisbursed / timelineData.length;
    const avgRecipients  = timelineData.reduce((s, b) => s + b.recipientCount, 0) / timelineData.length;

    // Platform revenue = sum of PLATFORM_FEE + REPORT_FEE flows to treasury
    const platformRevenue = guardFlows
      .filter((f) => f.type === 'PLATFORM_FEE' || f.type === 'REPORT_FEE')
      .reduce((s, f) => s + Number(f.amount || 0), 0);

    const maxBarTotal = Math.max(...timelineData.map((b) => b.barTotal), 1);

    return {
      timelineData,
      stats: {
        totalJobs:       timelineData.length,
        totalDisbursed,
        avgDisbursed,
        avgRecipients,
        platformRevenue,
      },
      maxBarTotal,
    };
  }, [settlements, guardFlows]);
}
