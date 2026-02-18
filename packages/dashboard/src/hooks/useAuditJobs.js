import { useMemo } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';

/**
 * Derives an enriched list of audit jobs from multiple store slices.
 * State machine mapping:
 *   JobPosted (no bids)  → AUCTION_OPEN   (stage 1)
 *   Has bids, no winners → AUCTION_OPEN   (stage 1, bidding active)
 *   Has winners          → AUDITING       (stage 2)
 *   Has settlement       → COMPLETED      (stage 3)
 */
export function useAuditJobs() {
  const activeJobs     = useStore((s) => s.activeJobs);
  const bids           = useStore((s) => s.bids);
  const winners        = useStore((s) => s.winners);
  const parentSubJobs  = useStore((s) => s.parentSubJobs);
  const jobListings    = useStore((s) => s.jobListings);
  const jobSettlements = useStore((s) => s.jobSettlements);
  const settlements    = useStore((s) => s.settlements);
  const discoveries    = useStore((s) => s.discoveries);
  const agents         = useStore((s) => s.agents);

  const jobs = useMemo(() => {
    return Object.values(activeJobs)
      .map((job) => {
        const jobId        = job.jobId;
        const jobBids      = bids[jobId] || [];
        const jobWinners   = winners[jobId] || null;
        const subJobIds    = parentSubJobs[jobId] || [];
        const listingIds   = jobListings[jobId] || [];
        const settlementId = jobSettlements[jobId] || null;
        const settlement   = settlementId ? settlements[settlementId] : null;

        // Resolve winner agent names from bids or store
        const winnerAddrs = jobWinners?.agents || [];
        const winnerNames = winnerAddrs.map((addr) => {
          const a = agents[addr];
          return a?.name || a?.agentId || fmt.address(addr);
        });

        // Derive state + stage
        let state = 'AUCTION_OPEN';
        let currentStage = 1;
        if (settlement) {
          state = 'COMPLETED';
          currentStage = 3;
        } else if (jobWinners) {
          state = 'AUDITING_IN_PROGRESS';
          currentStage = 2;
        }

        // Discovery cross-reference
        const disc = discoveries.find(
          (d) => d.contractAddress?.toLowerCase() === job.contractAddress?.toLowerCase()
        );

        return {
          jobId,
          contractAddress: job.contractAddress,
          contractChain:   job.contractChain || 'hedera',
          contractType:    job.contractType   || disc?.contractType || 'UNKNOWN',
          budgetFormatted: job.budgetFormatted || '—',
          initialRiskScore: job.initialRiskScore || 0,
          lineCount:       job.lineCount || 0,
          state,
          currentStage,
          bids:            jobBids,
          bidCount:        jobBids.length,
          winners:         jobWinners,
          winnerNames,
          subJobCount:     subJobIds.length,
          listingCount:    listingIds.length,
          settlementId,
          settlement,
          totalDisbursed:  settlement?.totalDisbursedFormatted || null,
          discoveredAt:    job.discoveredAt || disc?.timestamp || null,
          postedAt:        job.postedAt || null,
          winnersAt:       job.winnersAt || jobWinners?.winnersAt || null,
          settledAt:       job.settledAt || settlement?.settledAt || settlement?.timestamp || null,
        };
      })
      .sort((a, b) => Number(b.jobId) - Number(a.jobId)); // newest first
  }, [activeJobs, bids, winners, parentSubJobs, jobListings, jobSettlements, settlements, discoveries, agents]);

  return { jobs };
}
