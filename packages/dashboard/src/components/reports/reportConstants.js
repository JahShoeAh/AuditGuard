// ── Human-visible category config ─────────────────────────
// EXPLOIT_DATABASE (2), HOT_LEAD (3), FUZZING_SEEDS (4) are
// agent-to-agent data products — hidden from the human marketplace.

export const HUMAN_CATEGORY_IDS = new Set([0, 1, 5, 6, 7]);

export const CATEGORY_META = {
  0: { key: 'SCAN_REPORT',          label: 'Scan Report',       icon: '📄', color: 'cyan'   },
  1: { key: 'DEPENDENCY_ANALYSIS',  label: 'Dependency',        icon: '🌳', color: 'green'  },
  2: { key: 'EXPLOIT_DATABASE',     label: 'Exploit DB',        icon: '🛡', color: 'red'    },
  3: { key: 'HOT_LEAD',             label: 'Hot Lead',          icon: '📡', color: 'amber'  },
  4: { key: 'FUZZING_SEEDS',        label: 'Fuzzing Seeds',     icon: '🐛', color: 'orange' },
  5: { key: 'THREAT_INTEL',         label: 'Threat Intel',      icon: '⚠',  color: 'amber'  },
  6: { key: 'AUDIT_FINDING',        label: 'Audit Finding',     icon: '🔍', color: 'purple' },
  7: { key: 'OTHER',                label: 'Other',             icon: '📁', color: 'gray'   },
};

export const LISTING_TYPE_META = {
  0: { label: 'ONE-TIME',     color: 'cyan'   },
  1: { label: 'SUBSCRIPTION', color: 'purple' },
  2: { label: 'TIP',          color: 'amber'  },
};

export const CAT_COLOR_CLASSES = {
  cyan:   { border: 'border-cyan-500/50',   bg: 'bg-cyan-500/10',   text: 'text-cyan-300'   },
  green:  { border: 'border-green-500/50',  bg: 'bg-green-500/10',  text: 'text-green-300'  },
  red:    { border: 'border-red-500/50',    bg: 'bg-red-500/10',    text: 'text-red-300'    },
  amber:  { border: 'border-amber-500/50',  bg: 'bg-amber-500/10',  text: 'text-amber-300'  },
  orange: { border: 'border-orange-500/50', bg: 'bg-orange-500/10', text: 'text-orange-300' },
  purple: { border: 'border-purple-500/50', bg: 'bg-purple-500/10', text: 'text-purple-300' },
  gray:   { border: 'border-gray-500/50',   bg: 'bg-gray-500/10',   text: 'text-gray-400'   },
};

export const HUMAN_FILTER_TABS = [
  { id: null, label: 'All',            icon: '◈',  key: 'ALL'                },
  { id: 0,    label: 'Scan Reports',   icon: '📄', key: 'SCAN_REPORT'        },
  { id: 1,    label: 'Dependency',     icon: '🌳', key: 'DEPENDENCY_ANALYSIS'},
  { id: 5,    label: 'Threat Intel',   icon: '⚠',  key: 'THREAT_INTEL'       },
  { id: 6,    label: 'Audit Findings', icon: '🔍', key: 'AUDIT_FINDING'      },
];

export const GUARD_DECIMALS = 8;
export const PLATFORM_FEE_BPS = 300; // 3%

/** Format raw 8-decimal BigInt/number as "0.50" */
export function fmtGuard(raw) {
  if (raw == null) return '0.00';
  try {
    const n = typeof raw === 'bigint' ? raw : BigInt(Math.abs(Math.floor(Number(raw))));
    const whole = n / 100_000_000n;
    const frac  = (n % 100_000_000n).toString().padStart(8, '0').slice(0, 2);
    return `${whole}.${frac}`;
  } catch { return '0.00'; }
}

/** Compute platform fee (raw BigInt) */
export function platformFee(priceBig) {
  const p = typeof priceBig === 'bigint' ? priceBig : BigInt(Math.floor(Number(priceBig || 0)));
  return (p * BigInt(PLATFORM_FEE_BPS)) / 10_000n;
}

/** Star rating component data */
export function starsFromRating(avg) {
  const full  = Math.floor(avg);
  const half  = avg - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return { full, half, empty };
}
