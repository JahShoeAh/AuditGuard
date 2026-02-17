// ── Enum lookup tables ─────────────────────────────────────

const DATA_CATEGORIES = [
  'SCAN_REPORT', 'DEPENDENCY_ANALYSIS', 'EXPLOIT_DATABASE',
  'HOT_LEAD', 'FUZZING_SEEDS', 'THREAT_INTEL',
];
const LISTING_TYPES   = ['ONE_TIME', 'SUBSCRIPTION', 'TIP'];
const PAYMENT_TYPES   = [
  'MAIN_AUDIT', 'BONUS_SPEED', 'BONUS_UNIQUE_FINDING',
  'PLATFORM_FEE', 'REPORT_FEE', 'REFUND',
];

// ── Core formatter object ──────────────────────────────────

export const fmt = {
  /**
   * Convert raw 8-decimal GUARD BigInt/number to "15.00" (no symbol).
   * Handles null → "0.00".
   */
  guard(raw) {
    if (raw == null) return '0.00';
    const n = typeof raw === 'bigint' ? raw : BigInt(Math.abs(Math.floor(Number(raw))));
    const whole   = n / 100_000_000n;
    const frac    = n % 100_000_000n;
    const fracStr = frac.toString().padStart(8, '0').slice(0, 2);
    return `${whole}.${fracStr}`;
  },

  /** "15.00 GUARD" */
  guardWithSymbol(raw) {
    return `${fmt.guard(raw)} GUARD`;
  },

  /** "0x1234…abcd" — 4+4 truncation */
  address(addr) {
    if (!addr || addr.length < 10) return addr || '???';
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  },

  addressFull: (addr) => addr || '',

  /**
   * HH:MM:SS from a unix-ms timestamp, ISO string, or Unix-seconds number.
   */
  timestamp(unix) {
    if (!unix) return '--';
    let d;
    if (typeof unix === 'string') {
      d = new Date(unix);
    } else if (typeof unix === 'number' && unix < 1e12) {
      d = new Date(unix * 1000); // seconds → ms
    } else {
      d = new Date(unix);
    }
    return d.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  },

  /** "12s ago" / "3m ago" / "2h ago" */
  relativeTime(unix) {
    if (!unix) return '--';
    let ms;
    if (typeof unix === 'string') {
      ms = new Date(unix).getTime();
    } else if (typeof unix === 'number' && unix < 1e12) {
      ms = unix * 1000;
    } else {
      ms = unix;
    }
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 60_000) return `${Math.round(diff / 1_000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    return `${Math.round(diff / 3_600_000)}h ago`;
  },

  /** Returns { text, color } for a risk score 0-100 */
  risk(score) {
    const n = Math.min(100, Math.max(0, score || 0));
    let color = 'var(--accent-green)';
    if (n >= 70) color = 'var(--accent-red)';
    else if (n >= 40) color = 'var(--accent-amber)';
    return { text: `${n}/100`, color };
  },

  /** 9400 → "94.00" */
  reputation(bps) {
    if (bps == null) return '0.00';
    return (Number(bps) / 100).toFixed(2);
  },

  /** 3500 → "3,500" */
  lineCount(n) {
    if (n == null) return '--';
    return Number(n).toLocaleString();
  },

  /** 500000 → "$500K" */
  tvl(n) {
    if (!n && n !== 0) return '--';
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
    return `$${n}`;
  },

  /** 720 → "12 min" */
  duration(seconds) {
    if (!seconds) return '--';
    const n = Number(seconds);
    if (n < 60)    return `${n}s`;
    if (n < 3_600) return `${Math.floor(n / 60)} min`;
    return `${(n / 3_600).toFixed(1)} hr`;
  },

  /** Enum int → "MAIN_AUDIT" etc. */
  paymentType: (v) => PAYMENT_TYPES[Number(v)] || String(v),
  category:    (v) => DATA_CATEGORIES[Number(v)] || String(v),
  listingType: (v) => LISTING_TYPES[Number(v)]   || String(v),
};
