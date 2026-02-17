import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';
import AuctionCard from './AuctionCard';
import { shortenAddress } from '../services/event-listener';

// ── Gavel empty state ──────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      {/* Stylized gavel icon using CSS */}
      <div className="relative w-16 h-16 flex items-center justify-center">
        {/* Gavel head */}
        <motion.div
          animate={{ rotate: [-8, 8, -8] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute"
          style={{ transformOrigin: 'bottom center' }}
        >
          <div className="w-8 h-3 rounded bg-guard-amber/40" />
          <div className="w-1 h-6 bg-guard-amber/25 mx-auto mt-0.5 rounded-b" />
        </motion.div>
        {/* Base */}
        <div className="absolute bottom-1 w-10 h-1.5 rounded bg-guard-amber/20" />
      </div>
      <div className="text-center">
        <p className="text-xs text-gray-500 font-sans tracking-wider uppercase mb-1">
          Awaiting auction creation...
        </p>
        <p className="text-[10px] text-gray-600 font-mono">
          Orchestrator will post jobs when contracts are discovered
        </p>
      </div>
    </div>
  );
}

// ── Main AuctionFeed ───────────────────────────────────────

export default function AuctionFeed() {
  const activeJobs = useStore((s) => s.activeJobs);
  const bids = useStore((s) => s.bids);
  const winners = useStore((s) => s.winners);
  const config = useStore((s) => s.config);

  const contractAddr = config?.contracts?.auctionContract?.evmAddress;

  // Build sorted auction list (most recent first)
  const auctions = useMemo(() => {
    const jobs = Object.values(activeJobs);
    if (jobs.length === 0) return [];

    return jobs
      .map((job) => ({
        job,
        bids: bids[job.jobId] || [],
        winnerData: winners[job.jobId] || null,
      }))
      .sort((a, b) => {
        // Active auctions (no winners) first, then by jobId desc
        const aHasWinner = a.winnerData ? 1 : 0;
        const bHasWinner = b.winnerData ? 1 : 0;
        if (aHasWinner !== bHasWinner) return aHasWinner - bHasWinner;
        return Number(b.job.jobId) - Number(a.job.jobId);
      });
  }, [activeJobs, bids, winners]);

  // Track recently-arrived bids (within last 3s) for highlight effect
  const recentBidTimestamps = useMemo(() => {
    const now = Date.now();
    const recent = new Set();
    for (const bidList of Object.values(bids)) {
      for (const bid of bidList) {
        if (bid.timestamp && now - bid.timestamp < 3000) {
          recent.add(bid.timestamp);
        }
      }
    }
    return recent;
  }, [bids]);

  return (
    <div className="panel flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-guard-amber animate-pulse-glow" />
          <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-guard-amber">
            Live Auctions
          </h2>
          {auctions.length > 0 && (
            <span className="text-[10px] bg-guard-amber/15 text-guard-amber px-1.5 py-0.5 rounded font-mono font-semibold">
              {auctions.length}
            </span>
          )}
        </div>
        {contractAddr && (
          <span className="text-[9px] text-gray-600 font-mono hidden lg:block">
            via HSCS {shortenAddress(contractAddr)}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 min-h-0">
        <AnimatePresence mode="popLayout">
          {auctions.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="h-full"
            >
              <EmptyState />
            </motion.div>
          ) : (
            auctions.map(({ job, bids: jobBids, winnerData }) => (
              <AuctionCard
                key={job.jobId}
                job={job}
                bids={jobBids}
                winnerData={winnerData}
                recentBidTimestamps={recentBidTimestamps}
              />
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
