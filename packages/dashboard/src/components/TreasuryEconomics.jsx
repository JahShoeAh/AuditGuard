import { useMemo } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── Treasury address ──────────────────────────────────────────
const TREASURY_ADDR = '0xe5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d40005';

// ── Revenue categories (from on-chain FeeSource enum) ────────
const REVENUE_SOURCES = [
  { key: 'auditFees',       label: 'Audit Platform Fee', color: '#d97706' },
  { key: 'marketplaceFees', label: 'Marketplace Fee',    color: '#14b8a6' },
  { key: 'reportFees',      label: 'Report Fee',         color: '#6366f1' },
  { key: 'slashingProceeds',label: 'Slashing Proceeds',  color: '#ef4444' },
  { key: 'subAuctionFees',  label: 'Sub-Auction Fee',    color: '#a855f7' },
];

// ── Distribution config (from Treasury contract) ─────────────
const DISTRIBUTION = [
  { label: 'UCP Validators', pct: 40, color: '#3b82f6' },
  { label: 'Protocol Reserve', pct: 50, color: '#22c55e' },
  { label: 'Burn',            pct: 10, color: '#ef4444' },
];

// ── SVG donut arc helper ─────────────────────────────────────

function arcPath(cx, cy, r, inner, startAngle, endAngle) {
  const cos = Math.cos, sin = Math.sin;
  const x1o = cx + r * cos(startAngle), y1o = cy + r * sin(startAngle);
  const x2o = cx + r * cos(endAngle),   y2o = cy + r * sin(endAngle);
  const x1i = cx + inner * cos(endAngle),   y1i = cy + inner * sin(endAngle);
  const x2i = cx + inner * cos(startAngle), y2i = cy + inner * sin(startAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${x1o.toFixed(2)},${y1o.toFixed(2)}`,
    `A ${r} ${r} 0 ${large} 1 ${x2o.toFixed(2)},${y2o.toFixed(2)}`,
    `L ${x1i.toFixed(2)},${y1i.toFixed(2)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${x2i.toFixed(2)},${y2i.toFixed(2)}`,
    'Z',
  ].join(' ');
}

// ── Derive treasury revenue from guardFlows ──────────────────

function useTreasuryRevenue() {
  const guardFlows   = useStore((s) => s.guardFlows);
  const storeTreasury = useStore((s) => s.treasuryRevenue);
  const slashEvents  = useStore((s) => s.slashEvents);

  return useMemo(() => {
    // Derive from guardFlows (works in both mock and live mode)
    let auditFees = 0, marketplaceFees = 0, reportFees = 0;
    let subAuctionFees = 0;

    const treasuryId = TREASURY_ADDR.toLowerCase();
    for (const f of guardFlows) {
      const to = (f.to || '').toLowerCase();
      if (to !== treasuryId && f.to !== 'treasury') continue;
      const amt = Number(f.amount || 0);
      if      (f.type === 'PLATFORM_FEE' && f.from === 'vault') auditFees       += amt;
      else if (f.type === 'PLATFORM_FEE')                       marketplaceFees += amt;
      else if (f.type === 'REPORT_FEE')                         reportFees      += amt;
      else if (f.type === 'SUB_AUCTION_FEE')                    subAuctionFees  += amt;
    }

    // Slashing proceeds from slash events
    const slashingProceeds = slashEvents.reduce(
      (s, e) => s + Number(e.slashedAmount || 0), 0
    );

    // Merge with any on-chain treasury revenue from the store (live mode)
    const merged = {
      auditFees:        auditFees        || storeTreasury.auditFees || 0,
      marketplaceFees:  marketplaceFees  || storeTreasury.marketplaceFees || 0,
      reportFees:       reportFees       || storeTreasury.reportFees || 0,
      slashingProceeds: slashingProceeds || storeTreasury.slashingProceeds || 0,
      subAuctionFees:   subAuctionFees   || storeTreasury.subAuctionFees || 0,
    };
    merged.total = Object.values(merged).reduce((s, v) => s + v, 0);

    return merged;
  }, [guardFlows, storeTreasury, slashEvents]);
}

// ── TreasuryEconomics ─────────────────────────────────────────

export default function TreasuryEconomics() {
  const revenue = useTreasuryRevenue();

  if (revenue.total === 0) {
    return (
      <div className="w-full h-32 flex items-center justify-center text-gray-600 text-xs font-mono">
        Treasury revenue accumulates as the economy runs...
      </div>
    );
  }

  // Build donut segments
  const R = 70, INNER = 44;
  const CX = 88, CY = 88;
  let angle = -Math.PI / 2; // start from top

  const segments = REVENUE_SOURCES.map((src) => {
    const value = revenue[src.key] || 0;
    const pct   = value / revenue.total;
    const sweep = pct * 2 * Math.PI;
    const start = angle;
    const end   = angle + sweep;
    angle = end;
    return { ...src, value, pct, start, end };
  }).filter((s) => s.value > 0);

  // Distribution totals
  const distTotal = revenue.total;

  return (
    <div className="w-full font-mono text-xs">
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-3 px-3">
        Treasury Economics
      </div>
      <div className="flex gap-6 px-3 flex-wrap">

        {/* ── Left: Revenue Donut ── */}
        <div className="flex gap-4 items-start">
          <div className="relative">
            <svg width={176} height={176}>
              {/* Background ring */}
              <circle cx={CX} cy={CY} r={R} fill="none" stroke="#1f2937" strokeWidth={R - INNER} />

              {/* Donut segments */}
              {segments.map((seg) => (
                <path key={seg.key}
                  d={arcPath(CX, CY, R, INNER, seg.start, seg.end)}
                  fill={seg.color}
                  opacity="0.9"
                />
              ))}

              {/* Center: total */}
              <text x={CX} y={CY - 6} textAnchor="middle"
                fill="#fbbf24" fontSize="11" fontFamily="monospace" fontWeight="bold">
                {fmt.guard(revenue.total)}
              </text>
              <text x={CX} y={CY + 8} textAnchor="middle"
                fill="#6b7280" fontSize="8" fontFamily="monospace">
                GUARD total
              </text>
            </svg>
          </div>

          {/* Donut legend */}
          <div className="space-y-2 pt-2">
            {segments.map((seg) => (
              <div key={seg.key} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: seg.color }} />
                <div>
                  <div className="text-gray-400 text-[10px]">{seg.label}</div>
                  <div className="text-gray-200">{fmt.guard(seg.value)} GUARD</div>
                  <div className="text-gray-600 text-[9px]">
                    {(seg.pct * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: Distribution split ── */}
        <div className="flex-1 min-w-[200px]">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-3">
            Distribution
          </div>

          {/* Stacked horizontal bar */}
          <div className="flex h-5 rounded overflow-hidden mb-3">
            {DISTRIBUTION.map((d) => (
              <div
                key={d.label}
                style={{ width: `${d.pct}%`, backgroundColor: d.color }}
                title={`${d.label}: ${d.pct}%`}
              />
            ))}
          </div>

          {/* Labels */}
          <div className="space-y-1.5">
            {DISTRIBUTION.map((d) => (
              <div key={d.label} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: d.color }} />
                  <span className="text-gray-400">{d.label}</span>
                </div>
                <span className="text-gray-300 tabular-nums">
                  {d.pct}% · {fmt.guard(distTotal * d.pct / 100)} GUARD
                </span>
              </div>
            ))}
          </div>

          {/* Burn total */}
          <div className="mt-4 border-t border-gray-800 pt-3">
            <div className="flex items-center gap-1.5 text-[10px] text-red-400">
              <span>🔥</span>
              <span>Total burned: {fmt.guard(distTotal * 0.10)} GUARD</span>
            </div>
            <div className="text-[10px] text-gray-500 mt-1">
              Pending distribution: {fmt.guard(distTotal)} GUARD
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
