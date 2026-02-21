import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Countdown from './Countdown';
import BidRow from './BidRow';
import SubContractTree from './SubContractTree';
import { shortenAddress, parseGuardAmount } from '../services/event-listener';
import { hashscan } from '../utils/hashscan';
import { auctionTypeColor, auctionTypeLabel, normalizeAuctionType } from '../utils/auction-type';

const BID_LIFECYCLE_STYLE = {
  invite_sent: 'text-cyan-300 border-cyan-400/30 bg-cyan-500/10',
  submitted: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
  skipped: 'text-amber-300 border-amber-400/30 bg-amber-500/10',
  failed: 'text-red-300 border-red-400/30 bg-red-500/10',
};

const LLM_INFERENCE_STYLE = {
  started: 'text-cyan-300 border-cyan-400/30 bg-cyan-500/10',
  succeeded: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
  failed: 'text-red-300 border-red-400/30 bg-red-500/10',
};

function bidLifecycleLabel(status) {
  if (status === 'invite_sent') return 'Invite Sent';
  if (status === 'submitted') return 'Bid Submitted';
  if (status === 'skipped') return 'Bid Skipped';
  if (status === 'failed') return 'Bid Failed';
  return status || 'Unknown';
};

function llmInferenceLabel(status) {
  if (status === 'started') return 'LLM Inference Started';
  if (status === 'succeeded') return 'LLM Inference OK';
  if (status === 'failed') return 'LLM Inference Failed';
  return status || 'Unknown';
}

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

export default function AuctionCard({
  job,
  bids,
  bidLifecycle = [],
  llmInference = [],
  winnerData,
  recentBidTimestamps,
}) {
  const state = resolveState(job, winnerData);
  const canonicalType = normalizeAuctionType(job.contractType);
  const accentColor = auctionTypeColor(canonicalType);
  const typeLabel = auctionTypeLabel(canonicalType);

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
  const lifecyclePreview = useMemo(() => {
    const latestByAgent = new Map();
    for (const item of bidLifecycle) {
      const key = item.evmAddress || item.agentId || `unknown-${item.timestamp || 0}`;
      const prev = latestByAgent.get(key);
      if (!prev || Number(item.timestamp || 0) >= Number(prev.timestamp || 0)) {
        latestByAgent.set(key, item);
      }
    }
    // Suppress invite-only noise in card view; keep actionable lifecycle states.
    return Array.from(latestByAgent.values())
      .filter((item) => item?.status !== 'invite_sent')
      .slice(0, 6);
  }, [bidLifecycle]);
  const llmPreview = useMemo(() => {
    const latestByAgent = new Map();
    for (const item of llmInference) {
      const key = item.agentId || item.providerAddress || `llm-${item.timestamp || 0}`;
      const prev = latestByAgent.get(key);
      if (!prev || Number(item.timestamp || 0) >= Number(prev.timestamp || 0)) {
        latestByAgent.set(key, item);
      }
    }
    return Array.from(latestByAgent.values()).slice(0, 4);
  }, [llmInference]);
  const strictWarning = llmPreview.find((item) => item.status === 'succeeded' && item.usedFallback);

  const isWinnerState = state === STATE_WINNERS;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.96 }}
      animate={{
        opacity: 1, y: 0, scale: 1,
        boxShadow: isWinnerState
          ? ['0 0 0px rgba(16,185,129,0)', '0 0 18px rgba(16,185,129,0.35)', '0 0 8px rgba(16,185,129,0.12)']
          : '0 0 0px rgba(0,0,0,0)',
      }}
      exit={{ opacity: 0, scale: 0.95, height: 0 }}
      transition={{ type: 'spring', stiffness: 350, damping: 30,
        boxShadow: isWinnerState ? { duration: 0.8, times: [0, 0.4, 1] } : undefined,
      }}
      className="card mb-3 relative overflow-hidden"
      style={{
        borderColor: isWinnerState ? 'rgba(16, 185, 129, 0.3)' : undefined,
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
      <div className="px-3 py-1.5 border-b border-white/[0.04] flex items-center justify-between">
        <span className="text-[10px] font-mono text-gray-500">
          {shortenAddress(job.contractAddress)}
        </span>
        {job.contractAddress && (
          <a
            href={hashscan.contract(job.contractAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono text-gray-700 hover:text-guard-cyan transition-colors"
          >
            HashScan↗
          </a>
        )}
      </div>

      {/* ── Bids section ── */}
      <div className="px-2 py-2">
        <div className="flex items-center justify-between px-1 mb-1.5">
          <span className="text-[10px] text-gray-500 font-sans uppercase tracking-wider">
            Bids ({sortedBids.length})
          </span>
        </div>

        {lifecyclePreview.length > 0 && (
          <div className="mb-2 px-1 space-y-1">
            {lifecyclePreview.map((item, idx) => {
              const status = item.status || 'unknown';
              const style = BID_LIFECYCLE_STYLE[status] || 'text-gray-300 border-gray-700 bg-gray-800/40';
              return (
                <div key={`${item.agentId || item.evmAddress || 'agent'}-${idx}`} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-gray-400 font-mono truncate">{item.agentId || shortenAddress(item.evmAddress) || 'unknown-agent'}</span>
                  <span className={`px-1.5 py-0.5 rounded border font-semibold font-mono ${style}`}>
                    {bidLifecycleLabel(status)}
                  </span>
                  <span className="text-gray-500 font-mono truncate text-right max-w-[45%]">
                    {item.reason || '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {llmPreview.length > 0 && (
          <div className="mb-2 px-1 space-y-1">
            {llmPreview.map((item, idx) => {
              const style = LLM_INFERENCE_STYLE[item.status] || 'text-gray-300 border-gray-700 bg-gray-800/40';
              return (
                <div key={`${item.agentId || item.providerAddress || 'llm'}-${idx}`} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-gray-400 font-mono truncate">
                    {item.agentId || 'llm-contextual-003'}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border font-semibold font-mono ${style}`}>
                    {llmInferenceLabel(item.status)}
                  </span>
                  <span className="text-gray-500 font-mono truncate text-right max-w-[45%]">
                    {item.reason || item.reasonCode || item.model || '—'}
                  </span>
                </div>
              );
            })}
            {strictWarning && (
              <div className="text-[10px] font-mono text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-1">
                Strict live warning: LLM reported fallback output for this job.
              </div>
            )}
          </div>
        )}

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
                  index={i}
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

      {/* ── Sub-contract tree (Day 2) ── */}
      <SubContractTree parentJobId={job.jobId} />
    </motion.div>
  );
}
