import { useMemo } from 'react';
import { useContractRead } from './useContractRead';
import useStore from '../store';

/**
 * Combines event-driven store data with polled contract reads.
 *
 * In mock mode (or when contracts are unavailable) this just returns
 * the store data directly. When live contracts are available, it also
 * polls getActiveJobs() and enriches each auction with on-chain data.
 */
export function useAuctionData() {
  const activeJobs = useStore((s) => s.activeJobs);
  const bids = useStore((s) => s.bids);
  const winners = useStore((s) => s.winners);
  const contracts = useStore((s) => s.contracts);
  const useMockEvents = useStore((s) => s.useMockEvents);

  const auctionContract = contracts?.auctionContract || null;

  // Poll for active job IDs from the contract (live mode only)
  const { data: activeJobIds } = useContractRead(
    useMockEvents ? null : auctionContract,
    'getActiveJobs',
    [],
    { refetchInterval: 10_000 },
  );

  // Merge store data into enriched auction objects
  const auctions = useMemo(() => {
    // Start from store's activeJobs (populated by events or mock)
    const storeJobs = Object.values(activeJobs);

    // If we have on-chain job IDs, ensure we're not missing any
    if (activeJobIds && Array.isArray(activeJobIds)) {
      const storeIds = new Set(storeJobs.map((j) => j.jobId));
      for (const id of activeJobIds) {
        const idStr = id.toString();
        if (!storeIds.has(idStr)) {
          // We know about this job on-chain but don't have event data yet.
          // Add a skeleton so the UI shows it.
          storeJobs.push({
            jobId: idStr,
            contractAddress: null,
            contractType: null,
            initialRiskScore: 0,
            lineCount: 0,
            budgetFormatted: '? GUARD',
            auctionDeadline: null,
          });
        }
      }
    }

    return storeJobs
      .map((job) => ({
        job,
        bids: bids[job.jobId] || [],
        winnerData: winners[job.jobId] || null,
      }))
      .sort((a, b) => {
        // Active first, then by jobId desc
        const aW = a.winnerData ? 1 : 0;
        const bW = b.winnerData ? 1 : 0;
        if (aW !== bW) return aW - bW;
        return Number(b.job.jobId) - Number(a.job.jobId);
      });
  }, [activeJobs, bids, winners, activeJobIds]);

  return {
    auctions,
    isLoading: false,
  };
}
