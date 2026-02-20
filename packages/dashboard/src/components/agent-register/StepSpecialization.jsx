import { motion } from 'framer-motion';

// ── Specialization catalogue ───────────────────────────────

export const SPECIALIZATIONS = [
  {
    id: 'static_analysis',
    icon: '⚡',
    label: 'Static Analysis',
    desc: 'Fast baseline scans for known vulnerability patterns',
    minTier: 'COMMODITY',
    color: 'cyan',
  },
  {
    id: 'fuzzing',
    icon: '🔥',
    label: 'Fuzzing',
    desc: 'Runtime tests with randomised inputs',
    minTier: 'SPECIALIZED',
    color: 'orange',
  },
  {
    id: 'llm_contextual',
    icon: '🧠',
    label: 'LLM Contextual',
    desc: 'Deep semantic analysis via large language models',
    minTier: 'PREMIUM',
    color: 'purple',
  },
  {
    id: 'dependency_analysis',
    icon: '🌳',
    label: 'Dependency Analysis',
    desc: 'Library & transitive dependency vulnerability scans',
    minTier: 'COMMODITY',
    color: 'green',
  },
  {
    id: 'monitoring',
    icon: '👁',
    label: 'Monitoring',
    desc: 'Continuous 24/7 watch for on-chain anomalies',
    minTier: 'SPECIALIZED',
    color: 'amber',
  },
  {
    id: 'exploit_database',
    icon: '🛡',
    label: 'Exploit Database',
    desc: 'Pattern matching against known exploit signatures',
    minTier: 'COMMODITY',
    color: 'red',
  },
];

// ── Tier definitions ───────────────────────────────────────

export const TIERS = [
  {
    id: 'COMMODITY',
    label: 'COMMODITY',
    stake: 100,
    color: 'gray',
    desc: 'Entry level. Compete on price. Builds initial reputation.',
    badge: 'bg-gray-700 text-gray-300',
  },
  {
    id: 'SPECIALIZED',
    label: 'SPECIALIZED',
    stake: 300,
    color: 'cyan',
    desc: 'Access specialised jobs. Moderate competition. Better margins.',
    badge: 'bg-cyan-900 text-cyan-300',
  },
  {
    id: 'PREMIUM',
    label: 'PREMIUM',
    stake: 500,
    color: 'amber',
    desc: 'Top tier. Premium jobs only. Highest earning potential.',
    badge: 'bg-amber-900 text-amber-300',
  },
];

const TIER_RANK = { COMMODITY: 0, SPECIALIZED: 1, PREMIUM: 2 };

const ACCENT = {
  cyan:   { border: 'border-cyan-500/60',   bg: 'bg-cyan-500/10',   text: 'text-cyan-400'   },
  orange: { border: 'border-orange-500/60', bg: 'bg-orange-500/10', text: 'text-orange-400' },
  purple: { border: 'border-purple-500/60', bg: 'bg-purple-500/10', text: 'text-purple-400' },
  green:  { border: 'border-green-500/60',  bg: 'bg-green-500/10',  text: 'text-green-400'  },
  amber:  { border: 'border-amber-500/60',  bg: 'bg-amber-500/10',  text: 'text-amber-400'  },
  red:    { border: 'border-red-500/60',    bg: 'bg-red-500/10',    text: 'text-red-400'    },
  gray:   { border: 'border-gray-500/60',   bg: 'bg-gray-500/10',   text: 'text-gray-400'   },
};

// ── SpecCard ───────────────────────────────────────────────

function SpecCard({ spec, selected, disabled, onClick }) {
  const ac = ACCENT[spec.color] || ACCENT.gray;
  return (
    <motion.button
      type="button"
      whileTap={!disabled ? { scale: 0.97 } : {}}
      onClick={!disabled ? onClick : undefined}
      className={[
        'relative rounded-lg border-2 p-3 text-left transition-all h-full w-full',
        disabled
          ? 'opacity-40 cursor-not-allowed border-gray-800 bg-gray-900'
          : selected
          ? `${ac.border} ${ac.bg} cursor-pointer shadow-[0_0_12px_rgba(0,0,0,0.4)]`
          : 'border-gray-700 bg-gray-900 hover:border-gray-500 cursor-pointer',
      ].join(' ')}
    >
      {selected && (
        <span className="absolute top-2 right-2 text-[10px] font-bold text-green-400">✓</span>
      )}
      <div className={`text-2xl mb-1 ${disabled ? 'grayscale' : ''}`}>{spec.icon}</div>
      <div className="text-xs font-bold font-mono text-gray-100 leading-tight">{spec.label}</div>
      <div className="text-[11px] font-mono text-gray-500 mt-1 leading-snug">{spec.desc}</div>
      <div className={`text-[10px] font-bold font-mono mt-2 ${disabled ? 'text-gray-600' : ac.text}`}>
        Min: {spec.minTier}
      </div>
    </motion.button>
  );
}

// ── TierCard ───────────────────────────────────────────────

function TierCard({ tier, selected, canAfford, shortfall, onClick }) {
  const ac = ACCENT[tier.color] || ACCENT.gray;
  return (
    <motion.button
      type="button"
      whileTap={canAfford ? { scale: 0.98 } : {}}
      onClick={canAfford ? onClick : undefined}
      className={[
        'rounded-xl border-2 p-4 text-left transition-all w-full',
        !canAfford
          ? 'opacity-50 cursor-not-allowed border-gray-800 bg-gray-900'
          : selected
          ? `${ac.border} ${ac.bg} shadow-[0_0_16px_rgba(0,0,0,0.3)]`
          : 'border-gray-700 bg-gray-900 hover:border-gray-500 cursor-pointer',
      ].join(' ')}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${tier.badge}`}>
          {tier.label}
        </span>
        {selected && <span className="text-green-400 text-sm font-bold">✓ Selected</span>}
      </div>
      <div className={`text-lg font-bold font-mono ${canAfford ? ac.text : 'text-gray-600'}`}>
        {(tier.stake / 100).toFixed(2)} HBAR
      </div>
      <p className="text-xs font-mono text-gray-400 mt-1 leading-snug">{tier.desc}</p>
      {!canAfford && shortfall > 0 && (
        <p className="text-[11px] font-mono text-red-400 mt-2">
          Insufficient balance (need {shortfall.toFixed(4)} more HBAR)
        </p>
      )}
    </motion.button>
  );
}

// ── StepSpecialization ─────────────────────────────────────

/**
 * Step 3 — Specialization & Tier
 *
 * Props:
 *   data       { specializations: string[], tier: 'COMMODITY'|'SPECIALIZED'|'PREMIUM' }
 *   setData    (patch) => void
 *   errors     { specializations? }
 *   hbarBalance  number (human-readable HBAR amount from wallet store)
 */
export default function StepSpecialization({ data, setData, errors, hbarBalance }) {
  const balance = parseFloat(hbarBalance) || 0;

  const toggleSpec = (id) => {
    const next = data.specializations.includes(id)
      ? data.specializations.filter((s) => s !== id)
      : [...data.specializations, id];
    setData({ specializations: next });
  };

  const selectTier = (tierId) => {
    setData({ tier: tierId });
    // If selected specs require higher tier, don't de-select them — warn instead.
  };

  // Specs that require a higher tier than currently selected
  const selectedTierRank = TIER_RANK[data.tier] ?? 0;
  const incompatibleSpecs = data.specializations.filter(
    (sid) => TIER_RANK[SPECIALIZATIONS.find((s) => s.id === sid)?.minTier ?? 'COMMODITY'] > selectedTierRank
  );

  return (
    <div className="space-y-7">

      {/* Balance display */}
      <div className="flex items-center gap-3 border border-gray-700 rounded-lg px-4 py-3 bg-gray-900">
        <span className="text-amber-400 text-lg">💰</span>
        <div>
          <p className="text-xs font-mono text-gray-400">Your HBAR balance</p>
          <p className="text-base font-bold font-mono text-amber-300">
            {balance.toFixed(4)} HBAR
          </p>
        </div>
      </div>

      {/* Specializations */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-xs font-bold font-mono uppercase tracking-wider text-gray-400">
            Specializations * (select at least one)
          </p>
          {errors.specializations && (
            <p className="text-[11px] font-mono text-red-400">{errors.specializations}</p>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
          {SPECIALIZATIONS.map((spec) => {
            const minRank = TIER_RANK[spec.minTier] ?? 0;
            const disabled = minRank > selectedTierRank;
            const selected = data.specializations.includes(spec.id);
            return (
              <SpecCard
                key={spec.id}
                spec={spec}
                selected={selected}
                disabled={disabled && !selected}
                onClick={() => toggleSpec(spec.id)}
              />
            );
          })}
        </div>
        {incompatibleSpecs.length > 0 && (
          <p className="text-[11px] font-mono text-amber-400 mt-2">
            ⚠ Some selected specializations require a higher tier. Please upgrade your tier or remove them.
          </p>
        )}
      </div>

      {/* Tier selection */}
      <div>
        <p className="text-xs font-bold font-mono uppercase tracking-wider text-gray-400 mb-3">
          Tier (sets your stake amount)
        </p>
        <div className="grid grid-cols-3 gap-3">
          {TIERS.map((tier) => {
            const stakeInHbar = tier.stake / 100; // 100 GUARD = 1 HBAR
            const canAfford = balance >= stakeInHbar;
            const shortfall = stakeInHbar - balance;
            return (
              <TierCard
                key={tier.id}
                tier={tier}
                selected={data.tier === tier.id}
                canAfford={canAfford}
                shortfall={shortfall}
                onClick={() => selectTier(tier.id)}
              />
            );
          })}
        </div>
      </div>

    </div>
  );
}

export function validateStep3(data) {
  const errors = {};
  if (!data.specializations || data.specializations.length === 0) {
    errors.specializations = 'Select at least one specialization.';
  }
  if (!data.tier) {
    errors.tier = 'Select a tier.';
  }
  const selectedTierRank = TIER_RANK[data.tier] ?? 0;
  const bad = (data.specializations || []).filter(
    (sid) => TIER_RANK[SPECIALIZATIONS.find((s) => s.id === sid)?.minTier ?? 'COMMODITY'] > selectedTierRank
  );
  if (bad.length > 0) {
    errors.specializations = `Selected specializations require a higher tier.`;
  }
  return errors;
}
