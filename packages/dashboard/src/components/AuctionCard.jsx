import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Countdown from './Countdown';
import BidRow from './BidRow';
import { shortenAddress, parseGuardAmount } from '../services/event-listener';

// ── Contract type styling ──────────────────────────────────

const TYPE_LABELS = {
  lending_protocol: 'LENDING',
  dex: 'DEX',
  staking_pool: 'STAKING',
  yield_aggregator: 'YIELD AGG',
};

const TYPE_COLORS = {
  lending_protocol: 'var(--accent-cyan)',
  dex: 'var(--accent-amber)',
  staking_pool: 'var(--accent-purple)',
  yield_aggregator: 'var(--accent-green)',
};

// ── Risk mini-bar (compact for card header) ────────────────

function RiskMini({ score }) {
  const pct = Math.min(100, Math.max(0, score || 0));
  let color = 'var(--accent-green)';
  if (pct >= 70) color = 'var(--accent-red)';
  else if (pct >= 40) color = 'var(--accent-amber)';

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-gray-500 font-sans">Risk</span>
      <div className="w-8 h-1 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>
        {score || 0}
      </span>
    </div>
  );
}

// ── Auction states ─────────────────────────────────────────

const STATE_OPEN = 'open';
const STATE_WINNERS = 'winners';
const STATE_COMPLETED = 'completed';

function resolveState(job, winnerData) {
  if (winnerData) return STATE_WINNERS;
  // Check if deadline has passed
  if (job.auctionDeadline) {
    const dl = typeof job.auctionDeadline === 'bigint'
      ? Number(job.auctionDeadline) : Number(job.auctionDeadline);
    if (dl > 0 && dl < Math.floor(Date.now() / 1000)) return STATE_COMPLETED;
  }
  return STATE_OPEN;
}

// ── Main AuctionCard ───────────────────────────────────────

export default function AuctionCard({ job, bids, winnerData, recentBidTimestamps }) {
  const state = resolveState(job, winnerData);
  const accentColor = TYPE_COLORS[job.contractType] || 'var(--accent-cyan)';
  const typeLabel = TYPE_LABELS[job.contractType] || job.contractType?.toUpperCase() || 'UNKNOWN';

  const winnerAddresses = useMemo(() => {
    if (!winnerData?.agents) return new Set();
    return new Set(winnerData.agents.map((a) => a.toLowerCase()));
  }, [winnerData]);

  // Sort bids: by score desc if available, otherwise by arrival order
  const sortedBids = useMemo(() => {
    if (!bids || bids.length === 0) return [];
    const copy = [...bids];
    copy.sort((a, b) => {
      if (a.score != null && b.score != null) return Number(b.score) - Number(a.score);
      return 0; // preserve arrival order
    });
    return copy;
  }, [bids]);

  const budgetDisplay = job.budgetFormatted
    || (job.budgetAvailable ? parseGuardAmount(job.budgetAvailable) : '? GUARD');

  // STATE C — Completed: collapsed summary line
  if (state === STATE_COMPLETED && !winnerData) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0.7 }}
        animate={{ opacity: 0.4 }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.5 }}
        className="card px-3 py-2 mb-2 text-[11px] font-mono text-gray-500 flex items-center gap-2"
      >
        <span>Job #{job.jobId}</span>
        <span className="text-gray-600">&mdash;</span>
        <span style={{ color: accentColor }}>{typeLabel}</span>
        <span className="text-gray-600">&mdash;</span>
        <span>{sortedBids.length} bids</span>
        <span className="text-gray-600">&mdash;</span>
        <span style={{ color: 'var(--accent-gold)' }}>{budgetDisplay}</span>
        <span className="text-gray-600">&mdash;</span>
        <span className="text-guard-red">EXPIRED</span>
      </motion.div>
    );
  }

  const isWinnerState = state === STATE_WINNERS;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, height: 0 }}
      transition={{ type: 'spring', stiffness: 350, damping: 30 }}
      className="card mb-3 relative overflow-hidden"
      style={{
        borderColor: isWinnerState ? 'rgba(16, 185, 129, 0.25)' : undefined,
      }}
    >
      {/* Winner celebration flash */}
      {isWinnerState && (
        <motion.div
          initial={{ opacity: 0.2 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 2 }}
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.1) 0%, transparent 50%)' }}
        />
      )}

      {/* ── Header row: risk | lines | budget | countdown ── */}
      <div className="px-3 py-2.5 border-b border-white/[0.04] flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Job ID + type */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: accentColor }}
            />
            <span className="text-[10px] font-semibold tracking-wider uppercase font-sans" style={{ color: accentColor }}>
              {typeLabel}
            </span>
            <span className="text-[10px] text-gray-500 font-mono">
              #{job.jobId}
            </span>
          </div>

          <RiskMini score={job.initialRiskScore} />

          <span className="text-[10px] text-gray-500 font-sans">
            Lines: <span className="text-gray-400 font-mono">{job.lineCount?.toLocaleString() || '--'}</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Budget */}
          <span className="text-xs font-mono font-semibold" style={{ color: 'var(--accent-gold)' }}>
            {budgetDisplay}
          </span>

          {/* Countdown or status */}
          {isWinnerState ? (
            <span className="text-xs font-sans font-semibold text-guard-green flex items-center gap-1">
              WINNERS SELECTED
            </span>
          ) : (
            <Countdown deadline={job.auctionDeadline} />
          )}
        </div>
      </div>

      {/* ── Contract address ── */}
      <div className="px-3 py-1.5 border-b border-white/[0.04]">
        <span className="text-[10px] font-mono text-gray-500">
          {shortenAddress(job.contractAddress)}
        </span>
      </div>

      {/* ── Bids section ── */}
      <div className="px-2 py-2">
        <div className="flex items-center justify-between px-1 mb-1.5">
          <span className="text-[10px] text-gray-500 font-sans uppercase tracking-wider">
            Bids ({sortedBids.length})
          </span>
        </div>

        {sortedBids.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-[11px] text-gray-600 font-mono">Awaiting agent bids...</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {sortedBids.map((bid, i) => {
              const isWinner = winnerAddresses.has(bid.agent?.toLowerCase());
              const isDimmed = isWinnerState && !isWinner;
              const bidTs = bid.timestamp || bid.blockNumber;
              const isNew = recentBidTimestamps?.has(bidTs);

              return (
                <BidRow
                  key={`${bid.agent}-${bid.jobId}-${i}`}
                  bid={bid}
                  isWinner={isWinner}
                  isDimmed={isDimmed}
                  isNew={isNew}
                />
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* ── Winner summary footer ── */}
      {isWinnerState && winnerData && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="px-3 py-2 border-t border-guard-green/20 bg-guard-green/[0.03] text-[11px] font-mono flex items-center justify-between"
        >
          <span className="text-gray-400">
            Escrowed: <span style={{ color: 'var(--accent-gold)' }}>
              {winnerData.totalEscrowedFormatted || '?'}
            </span>
          </span>
          <span className="text-gray-500">
            Platform Fee: <span className="text-gray-400">
              {winnerData.platformFeeFormatted || '?'}
            </span>
          </span>
        </motion.div>
      )}
    </motion.div>
  );
}
