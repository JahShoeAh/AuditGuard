import { useMemo } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── Agent color heuristic (matches PaymentFlow / useGuardFlows) ─
function agentColor(name = '') {
  if (name.includes('Static') || name.includes('Scanner')) return '#22c55e';
  if (name.includes('Fuzzer'))                              return '#f59e0b';
  if (name.includes('LLM') || name.includes('Contextual')) return '#a855f7';
  if (name.includes('Dep'))                                 return '#f97316';
  return '#06b6d4';
}

// ── Price bucket definitions (in raw GUARD units, 8 decimals) ──
export const PRICE_RANGES = [
  { label: '0–5',    min: 0,         max: 5e8   },
  { label: '5–15',   min: 5e8,       max: 15e8  },
  { label: '15–30',  min: 15e8,      max: 30e8  },
  { label: '30–50',  min: 30e8,      max: 50e8  },
  { label: '50+',    min: 50e8,      max: Infinity },
];

export const TIER_LABELS = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];

// ── useCompetitionData ────────────────────────────────────────

/**
 * Returns:
 *   agents          — ordered agent list (by total bids desc)
 *   matrix          — NxN array of { count, isDiag, aWins, bWins, sharedJobIds }
 *   maxComp         — max off-diagonal competition count (for color scale)
 *   specs           — unique spec strings
 *   contractTypes   — unique contractType strings
 *   specVsType      — specs.length × contractTypes.length 2D array
 *   tiers           — TIER_LABELS
 *   priceRanges     — PRICE_RANGES
 *   priceDistribution — 3 × 5 2D array (count per tier × bucket)
 *   insights        — string[] of auto-generated market insight bullets
 */
export function useCompetitionData() {
  const bids        = useStore((s) => s.bids);
  const winners     = useStore((s) => s.winners);
  const activeJobs  = useStore((s) => s.activeJobs);
  const agents      = useStore((s) => s.agents);
  const subJobs     = useStore((s) => s.subJobs);

  return useMemo(() => {
    // ── Collect all agents who ever bid on main auctions ────

    const totalBidCount = {};
    for (const [, jobBids] of Object.entries(bids)) {
      for (const bid of jobBids) {
        const a = bid.agent?.toLowerCase();
        if (a) totalBidCount[a] = (totalBidCount[a] || 0) + 1;
      }
    }

    // Build ordered agent list
    const agentList = Object.entries(totalBidCount)
      .sort((a, b) => b[1] - a[1])
      .map(([addr]) => {
        const profile = agents[addr] || {};
        return {
          address: addr,
          name:           profile.name || profile.agentId || fmt.address(addr),
          specialization: profile.specialization || 'unknown',
          tier:           profile.tier ?? 0,
          color:          agentColor(profile.name || ''),
        };
      });

    // ── Competition matrix (agent × agent) ────────────────

    // coCompetition[key] = # of jobs where both agents bid
    const coCompetition = {};
    // wins[key][addr] = # of those jobs where addr won
    const pairWins = {};

    for (const [jobId, jobBids] of Object.entries(bids)) {
      const bidAgents = [...new Set(jobBids.map((b) => b.agent?.toLowerCase()).filter(Boolean))];
      const jobWinnerSet = new Set((winners[jobId]?.agents || []).map((a) => a.toLowerCase()));

      for (let i = 0; i < bidAgents.length; i++) {
        for (let j = i + 1; j < bidAgents.length; j++) {
          const key = [bidAgents[i], bidAgents[j]].sort().join('|');
          coCompetition[key] = (coCompetition[key] || 0) + 1;
          if (!pairWins[key]) pairWins[key] = {};
          if (jobWinnerSet.has(bidAgents[i])) pairWins[key][bidAgents[i]] = (pairWins[key][bidAgents[i]] || 0) + 1;
          if (jobWinnerSet.has(bidAgents[j])) pairWins[key][bidAgents[j]] = (pairWins[key][bidAgents[j]] || 0) + 1;
        }
      }
    }

    // Build NxN matrix
    const matrix = agentList.map((rowAgent, i) =>
      agentList.map((colAgent, j) => {
        if (i === j) {
          return { count: totalBidCount[rowAgent.address] || 0, isDiag: true };
        }
        const key = [rowAgent.address, colAgent.address].sort().join('|');
        const count = coCompetition[key] || 0;

        // Shared job IDs for click-through
        const sharedJobIds = Object.entries(bids)
          .filter(([, jb]) => {
            const addrs = jb.map((b) => b.agent?.toLowerCase());
            return addrs.includes(rowAgent.address) && addrs.includes(colAgent.address);
          })
          .map(([jobId]) => jobId);

        return {
          count,
          isDiag: false,
          aWins: pairWins[key]?.[rowAgent.address] || 0,
          bWins: pairWins[key]?.[colAgent.address] || 0,
          sharedJobIds,
        };
      })
    );

    const maxComp = Math.max(...Object.values(coCompetition), 1);

    // ── Spec × ContractType matrix ─────────────────────────

    const specs = [...new Set(
      Object.values(bids).flat().map((b) => b.specialization).filter(Boolean)
    )].sort();

    const contractTypes = [...new Set(
      Object.values(activeJobs).map((j) => j.contractType).filter(Boolean)
    )].sort();

    const specVsType = specs.map((spec) =>
      contractTypes.map((type) => {
        let count = 0, totalAmount = 0, wins = 0;
        for (const [jobId, jobBids] of Object.entries(bids)) {
          const job = activeJobs[jobId];
          if (!job || job.contractType !== type) continue;
          const specBids = jobBids.filter((b) => b.specialization === spec);
          count += specBids.length;
          totalAmount += specBids.reduce((s, b) => s + Number(b.bidAmount || 0), 0);
          const jobWinners = new Set((winners[jobId]?.agents || []).map((a) => a.toLowerCase()));
          wins += specBids.filter((b) => jobWinners.has(b.agent?.toLowerCase())).length;
        }
        const avgAmount = count > 0 ? totalAmount / count : 0;
        const winRate   = count > 0 ? wins / count : 0;
        return { count, totalAmount, avgAmount, wins, winRate };
      })
    );

    // ── Price distribution (tier × price bucket) ──────────

    const priceDistribution = TIER_LABELS.map((_, tierIdx) =>
      PRICE_RANGES.map((range) => {
        let count = 0;
        for (const jobBids of Object.values(bids)) {
          for (const bid of jobBids) {
            const addr       = bid.agent?.toLowerCase();
            const agentTier  = agents[addr]?.tier ?? 0;
            if (agentTier !== tierIdx) continue;
            const amount = Number(bid.bidAmount || 0);
            if (amount >= range.min && amount < range.max) count++;
          }
        }
        return count;
      })
    );

    // ── Auto insights ──────────────────────────────────────

    const insights = [];

    // 1. Most competitive pair
    let topPairKey = null, topPairCount = 0;
    for (const [key, count] of Object.entries(coCompetition)) {
      if (count > topPairCount) { topPairCount = count; topPairKey = key; }
    }
    if (topPairKey && topPairCount > 0) {
      const [a1, a2] = topPairKey.split('|');
      const n1 = agentList.find((a) => a.address === a1)?.name || fmt.address(a1);
      const n2 = agentList.find((a) => a.address === a2)?.name || fmt.address(a2);
      const w1 = pairWins[topPairKey]?.[a1] || 0;
      const winPct = Math.round((w1 / topPairCount) * 100);
      insights.push(
        `${n1} and ${n2} compete most (${topPairCount} auctions) — ${n1} wins ${winPct}%.`
      );
    }

    // 2. Most popular contract type
    const typeTotals = contractTypes.map((type, j) => ({
      type,
      total: specs.reduce((s, _, i) => s + (specVsType[i]?.[j]?.count || 0), 0),
    })).sort((a, b) => b.total - a.total);
    if (typeTotals.length >= 2 && typeTotals[0].total > 0 && typeTotals[1].total > 0) {
      const ratio = (typeTotals[0].total / typeTotals[1].total).toFixed(1);
      const label = typeTotals[0].type.replace(/_/g, ' ');
      const label2 = typeTotals[1].type.replace(/_/g, ' ');
      insights.push(`${label} attracts ${ratio}× more bids than ${label2}.`);
    } else if (typeTotals.length === 1 && typeTotals[0].total > 0) {
      insights.push(`Only ${typeTotals[0].type.replace(/_/g, ' ')} auctions so far.`);
    }

    // 3. Avg bid comparison: SPECIALIZED vs COMMODITY
    const tierAvgBids = TIER_LABELS.map((tierLabel, tierIdx) => {
      const allBids = Object.values(bids).flat().filter((b) => {
        const addr = b.agent?.toLowerCase();
        return (agents[addr]?.tier ?? 0) === tierIdx;
      });
      const total = allBids.reduce((s, b) => s + Number(b.bidAmount || 0), 0);
      return { tierLabel, avg: allBids.length > 0 ? total / allBids.length : 0, count: allBids.length };
    });
    const spec = tierAvgBids[1], comm = tierAvgBids[0];
    if (spec.count > 0 && comm.count > 0) {
      insights.push(
        `SPECIALIZED avg: ${fmt.guard(spec.avg)} GUARD/bid vs COMMODITY ${fmt.guard(comm.avg)} GUARD/bid.`
      );
    } else if (spec.count > 0) {
      insights.push(`SPECIALIZED avg bid: ${fmt.guard(spec.avg)} GUARD.`);
    }

    // 4. Sub-contractor detection (no main bids but has sub-contract wins)
    const subContractorWins = {};
    for (const subJob of Object.values(subJobs)) {
      if (subJob.status === 'ACCEPTED' && subJob.selectedAgent) {
        const addr = subJob.selectedAgent.toLowerCase();
        subContractorWins[addr] = (subContractorWins[addr] || 0) + 1;
      }
    }
    for (const [addr, wins_] of Object.entries(subContractorWins)) {
      if (!totalBidCount[addr]) {
        const name = agents[addr]?.name || fmt.address(addr);
        insights.push(`${name}: 0 main auction bids, ${wins_} sub-contract win${wins_ !== 1 ? 's' : ''} (specialist sub-contractor).`);
        break; // show first one only
      }
    }

    if (insights.length === 0) {
      insights.push('Insights build as agents bid and compete...');
    }

    return {
      agents: agentList,
      matrix,
      maxComp,
      specs,
      contractTypes,
      specVsType,
      tiers: TIER_LABELS,
      priceRanges: PRICE_RANGES,
      priceDistribution,
      insights,
    };
  }, [bids, winners, activeJobs, agents, subJobs]);
}
