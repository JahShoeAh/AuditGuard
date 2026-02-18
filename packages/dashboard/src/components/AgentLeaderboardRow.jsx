import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import { fmt } from '../utils/format';

// ── Tier badge ─────────────────────────────────────────────
const TIER_CONFIG = {
  0: { label: 'COMMODITY', classes: 'bg-gray-700 text-gray-300' },
  1: { label: 'SPECIALIZED', classes: 'bg-cyan-900 text-cyan-300' },
  2: { label: 'PREMIUM', classes: 'bg-amber-900 text-amber-300' },
};

function tierConfig(tier) {
  return TIER_CONFIG[tier] || TIER_CONFIG[0];
}

// ── Reputation color ───────────────────────────────────────
function repColor(rep) {
  if (rep >= 85) return 'text-green-400';
  if (rep >= 70) return 'text-yellow-300';
  if (rep >= 50) return 'text-amber-400';
  return 'text-red-400';
}

// ── Stake status dot ───────────────────────────────────────
function StakeDot({ status }) {
  if (status === 'UNBONDING') return (
    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Unbonding" />
  );
  if (status === 'FROZEN') return (
    <span className="inline-block w-2 h-2 rounded-full bg-red-500" title="Frozen" />
  );
  // Default ACTIVE
  return (
    <span className="inline-block w-2 h-2 rounded-full bg-green-400" title="Active" />
  );
}

// ── Mini sparkline SVG ─────────────────────────────────────
function Sparkline({ history }) {
  if (!history || history.length < 2) {
    return <span className="w-[60px] h-[20px] inline-block opacity-30 text-gray-600 text-[9px] leading-5">no data</span>;
  }
  const pts = history.slice(-10);
  const reps = pts.map((p) => p.reputation || 0);
  const min = Math.min(...reps);
  const max = Math.max(...reps);
  const range = max - min || 1;
  const W = 60, H = 20;
  const xs = pts.map((_, i) => (i / (pts.length - 1)) * W);
  const ys = reps.map((r) => H - ((r - min) / range) * (H - 4) - 2);
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} className="inline-block opacity-80">
      <polyline
        points={xs.map((x, i) => `${x},${ys[i]}`).join(' ')}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Flash overlay ──────────────────────────────────────────
const FLASH_STYLES = {
  slash:    'bg-red-500/20 border-red-500',
  positive: 'bg-yellow-400/20 border-yellow-400',
  negative: 'bg-red-400/20 border-red-500',
};

// ── AgentLeaderboardRow ────────────────────────────────────

export default function AgentLeaderboardRow({ rank, profile, isSelected, onSelect, isFlashing }) {
  const [flash, setFlash] = useState(null);

  // Trigger flash animation on external isFlashing prop change
  useEffect(() => {
    if (!isFlashing) return;
    setFlash(isFlashing);
    const id = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(id);
  }, [isFlashing]);

  const repVal  = profile.reputationScore || profile.reputation || 0;
  const repNum  = Number(repVal) / 100; // bps → 0–100
  const lastDelta = profile.history?.length > 1
    ? (profile.history[profile.history.length - 1]?.delta || 0)
    : null;

  const { label: tierLabel, classes: tierClasses } = tierConfig(profile.tier);
  const stakeStatus = profile.stakeStatus || 'ACTIVE';

  const stakedFormatted = profile.stakedAmount
    ? fmt.guard(profile.stakedAmount)
    : profile.effectiveStake
    ? fmt.guard(profile.effectiveStake)
    : '0.00';

  return (
    <motion.div
      layout
      className={[
        'cursor-pointer rounded border transition-all p-3 mb-1',
        isSelected ? 'border-cyan-400 bg-gray-800' : 'border-gray-700 bg-gray-900 hover:border-gray-500',
        flash ? FLASH_STYLES[flash] || '' : '',
      ].join(' ')}
      onClick={() => onSelect(profile.address)}
    >
      {/* Slash badge */}
      <AnimatePresence>
        {flash === 'slash' && (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="float-right text-xs font-bold bg-red-600 text-white px-1.5 py-0.5 rounded"
          >
            ⚠ SLASHED
          </motion.span>
        )}
      </AnimatePresence>

      {/* Row 1: rank, status dot, name, tier, rep */}
      <div className="flex items-center gap-2 font-mono text-sm">
        <span className="text-gray-500 w-5 text-right text-xs">#{rank}</span>
        <StakeDot status={stakeStatus} />
        <span className="flex-1 text-gray-100 font-semibold truncate">{profile.name || profile.agentId || fmt.address(profile.address)}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${tierClasses}`}>
          {tierLabel}
        </span>
        <span className={`font-bold text-base w-14 text-right ${repColor(repNum)}`}>
          {repNum.toFixed(2)}
        </span>
      </div>

      {/* Row 2: specialization, staked */}
      <div className="flex items-center gap-4 mt-1 text-xs text-gray-400 font-mono pl-7">
        <span>{profile.specialization || profile.agentId || '—'}</span>
        <span className="ml-auto text-amber-400">{stakedFormatted} GUARD staked</span>
      </div>

      {/* Row 3: job stats */}
      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 font-mono pl-7">
        <span>Jobs: {profile.completedJobs || 0}</span>
        <span>│</span>
        <span>Findings: {profile.successfulFindings || 0}</span>
        <span>│</span>
        <span>FP: {profile.falsePositives || 0}</span>
        <span>│</span>
        <span>Slashes: {profile.slashCount || 0}</span>
        {profile.hasActiveAppeals && (
          <span className="ml-1 text-amber-400">⚖ Appeal pending</span>
        )}
        {profile.discount?.eligible && (
          <span className="ml-1 text-yellow-400">✦ Fee Discount</span>
        )}
      </div>

      {/* Row 4: reputation bar + last delta + sparkline */}
      <div className="flex items-center gap-3 mt-2 pl-7">
        {/* Rep bar */}
        <div className="flex-1 h-1.5 rounded bg-gray-700 overflow-hidden max-w-[120px]">
          <div
            className={`h-full rounded transition-all ${repNum >= 85 ? 'bg-green-400' : repNum >= 70 ? 'bg-yellow-300' : repNum >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
            style={{ width: `${Math.min(100, repNum)}%` }}
          />
        </div>
        {/* Last delta */}
        {lastDelta != null && (
          <span className={`text-xs font-mono font-semibold ${lastDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {lastDelta >= 0 ? `↗ +${(lastDelta / 100).toFixed(2)}` : `↘ ${(lastDelta / 100).toFixed(2)}`}
          </span>
        )}
        {/* Sparkline */}
        <Sparkline history={profile.history} />
      </div>
    </motion.div>
  );
}
