import { memo, useState, useEffect } from 'react';
import { motion } from 'framer-motion';

// ── Agent accent colors by specialization ──────────────────

const AGENT_COLORS = {
  static_analysis: 'var(--accent-green)',
  fuzzing: 'var(--accent-amber)',
  llm_contextual: 'var(--accent-purple)',
  dependency_analysis: 'var(--accent-cyan)',
};

function getAgentColor(specialization) {
  return AGENT_COLORS[specialization] || 'var(--text-primary)';
}

// ── Format seconds to human-readable ───────────────────────

function formatETA(secs) {
  if (!secs) return '--';
  const n = Number(secs);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)} min`;
  return `${(n / 3600).toFixed(1)} hr`;
}

// ── Reputation mini-bar ────────────────────────────────────

function RepBar({ score }) {
  // score is 0–10000, display as 0–100
  const display = typeof score === 'number' ? Math.round(score / 100) : 0;
  const pct = Math.min(100, Math.max(0, display));

  let color = 'var(--accent-green)';
  if (pct < 50) color = 'var(--accent-red)';
  else if (pct < 75) color = 'var(--accent-amber)';

  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] font-mono w-5 text-right" style={{ color }}>
        {display}
      </span>
    </div>
  );
}

// ── BidRow ─────────────────────────────────────────────────

const BidRow = memo(function BidRow({ bid, isWinner, isDimmed, isNew }) {
  const agentColor = getAgentColor(bid.specialization);
  const [showFlash, setShowFlash] = useState(isNew);

  useEffect(() => {
    if (isNew) {
      const t = setTimeout(() => setShowFlash(false), 3000);
      return () => clearTimeout(t);
    }
  }, [isNew]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 20 }}
      animate={{
        opacity: isDimmed ? 0.35 : 1,
        x: 0,
      }}
      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
      className="relative rounded px-2.5 py-2 mb-1"
      style={{
        borderLeft: isWinner ? '2px solid var(--accent-green)' : '2px solid transparent',
        background: showFlash
          ? `linear-gradient(90deg, ${agentColor}12 0%, transparent 70%)`
          : 'transparent',
      }}
    >
      {/* Flash highlight for new bids */}
      {showFlash && (
        <motion.div
          initial={{ opacity: 0.25 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 3 }}
          className="absolute inset-0 rounded pointer-events-none"
          style={{
            background: `linear-gradient(90deg, ${agentColor}18 0%, transparent 60%)`,
          }}
        />
      )}

      {/* Main row */}
      <div className="flex items-center justify-between gap-2">
        {/* Left: agent identity */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: agentColor }}
          />
          <span
            className="text-xs font-semibold truncate font-sans"
            style={{ color: agentColor }}
          >
            {bid.agentName || '???'}
          </span>
        </div>

        {/* Center: bid amount */}
        <span className="text-xs font-mono font-semibold flex-shrink-0" style={{ color: 'var(--accent-gold)' }}>
          {bid.bidFormatted || '?'}
        </span>

        {/* Right: reputation */}
        <div className="flex-shrink-0">
          <RepBar score={bid.reputationAtBid} />
        </div>
      </div>

      {/* Detail row */}
      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500 pl-4">
        <span className="font-mono">
          ETA {formatETA(bid.estimatedCompletionTime)}
        </span>
        {bid.collateralFormatted && (
          <span className="font-mono">
            collateral: {bid.collateralFormatted}
          </span>
        )}
        {bid.score != null && (
          <span className="font-mono text-gray-400">
            score: {bid.score}
          </span>
        )}
        {bid.score === undefined && (
          <span className="font-mono text-gray-600">
            score: ...
          </span>
        )}
      </div>
    </motion.div>
  );
});

export default BidRow;
