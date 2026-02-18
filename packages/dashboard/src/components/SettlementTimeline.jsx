import { useState } from 'react';
import { useSettlementTimeline, PAYMENT_TYPE_CONFIG, PAYMENT_TYPE_ORDER } from '../hooks/useSettlementTimeline';
import { fmt } from '../utils/format';
import SettlementDetail from './SettlementDetail';

// ── SettlementTimeline ───────────────────────────────────────

export default function SettlementTimeline() {
  const { timelineData, stats, maxBarTotal } = useSettlementTimeline();
  const [selectedSettlement, setSelectedSettlement] = useState(null);
  const [hoveredIdx, setHoveredIdx]         = useState(null);

  if (timelineData.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm font-mono">
        Waiting for settlements — first bar appears at t≈60s.
      </div>
    );
  }

  // ── Chart geometry ──────────────────────────────────────
  const W = 720, H = 200;
  const PAD = { top: 12, right: 20, bottom: 36, left: 52 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const N       = timelineData.length;
  const BAR_GAP = 4;
  const barW    = Math.max(12, Math.min(52, (innerW / N) - BAR_GAP));
  const xOf     = (i) => PAD.left + (i / Math.max(1, N - 1)) * innerW - barW / 2;
  const yOf     = (v) => PAD.top + innerH - (v / maxBarTotal) * innerH;

  // ── Y-axis ticks ─────────────────────────────────────────
  const yMax  = maxBarTotal / 1e8; // convert to GUARD
  const step  = yMax > 100 ? 25 : yMax > 50 ? 10 : 5;
  const yTicks = [];
  for (let v = 0; v <= Math.ceil(yMax / step) * step; v += step) yTicks.push(v);

  // ── Cumulative totals for the running line ───────────────
  let cumulative = 0;
  const cumPoints = timelineData.map((b) => {
    cumulative += b.totalDisbursed;
    return cumulative;
  });
  const cumMax    = cumPoints[cumPoints.length - 1] || 1;
  // Scale cumulative to chart height (independent secondary scale)
  const cumY  = (v) => PAD.top + innerH - (v / cumMax) * innerH;
  const cumPolyline = timelineData.map((_, i) => {
    const bx = PAD.left + (i / Math.max(1, N - 1)) * innerW;
    return `${bx.toFixed(1)},${cumY(cumPoints[i]).toFixed(1)}`;
  }).join(' ');

  return (
    <div className="w-full h-full flex flex-col min-h-0 font-mono text-xs overflow-auto">
      <div className="flex-1 flex gap-4 min-h-0 p-3">

        {/* ── Chart area ── */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">
            Settlement History — GUARD disbursed per job
          </div>

          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            preserveAspectRatio="none"
            style={{ display: 'block', cursor: 'pointer' }}
          >
            {/* Y-axis gridlines */}
            {yTicks.map((v) => {
              const yp = yOf(v * 1e8);
              return (
                <g key={v}>
                  <line x1={PAD.left} y1={yp} x2={W - PAD.right} y2={yp}
                    stroke="#1f2937" strokeWidth="1" />
                  <text x={PAD.left - 4} y={yp} textAnchor="end" dominantBaseline="middle"
                    fill="#4b5563" fontSize="9" fontFamily="monospace">
                    {v}
                  </text>
                </g>
              );
            })}

            {/* Y-axis label */}
            <text
              transform={`translate(10,${PAD.top + innerH / 2}) rotate(-90)`}
              textAnchor="middle" fill="#374151" fontSize="8" fontFamily="monospace"
            >
              GUARD
            </text>

            {/* Stacked bars */}
            {timelineData.map((bar, i) => {
              const bx       = xOf(i);
              const isHovered = hoveredIdx === i;
              let yBottom = PAD.top + innerH;

              return (
                <g key={bar.settlementId}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => setSelectedSettlement(bar.settlement)}
                >
                  {/* Hover highlight */}
                  {isHovered && (
                    <rect x={bx - 2} y={PAD.top} width={barW + 4} height={innerH}
                      fill="rgba(255,255,255,0.04)" rx="2" />
                  )}

                  {/* Stacked segments */}
                  {PAYMENT_TYPE_ORDER.map((type) => {
                    const amount = bar.breakdown[type] || 0;
                    if (amount === 0) return null;
                    const segH = (amount / maxBarTotal) * innerH;
                    const y    = yBottom - segH;
                    yBottom -= segH;
                    return (
                      <rect key={type}
                        x={bx} y={y} width={barW} height={segH}
                        fill={PAYMENT_TYPE_CONFIG[type]?.color || '#6b7280'}
                        opacity={isHovered ? 1 : 0.85}
                        rx={type === PAYMENT_TYPE_ORDER[0] ? 2 : 0}
                      />
                    );
                  })}

                  {/* X-axis label (job #) */}
                  <text
                    x={bx + barW / 2} y={H - 4}
                    textAnchor="middle" fill={isHovered ? '#9ca3af' : '#4b5563'}
                    fontSize="9" fontFamily="monospace"
                  >
                    #{bar.jobId}
                  </text>
                </g>
              );
            })}

            {/* Cumulative total line (secondary, teal) */}
            {timelineData.length >= 2 && (
              <polyline
                points={cumPolyline}
                fill="none"
                stroke="#22d3ee"
                strokeWidth="1.5"
                strokeDasharray="5 3"
                opacity="0.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Hover tooltip */}
            {hoveredIdx != null && (() => {
              const bar = timelineData[hoveredIdx];
              const bx  = xOf(hoveredIdx) + barW / 2;
              const byy = yOf(bar.barTotal) - 8;
              const flip = hoveredIdx > N * 0.65;
              return (
                <g>
                  <rect
                    x={flip ? bx - 118 : bx + 4}
                    y={Math.max(PAD.top + 2, byy - 10)}
                    width={114} height={58}
                    fill="#111827" stroke="#374151" strokeWidth="1" rx="3"
                  />
                  <text x={flip ? bx - 114 : bx + 8} y={Math.max(PAD.top + 2, byy - 10) + 13}
                    fill="#d1d5db" fontSize="9" fontFamily="monospace" fontWeight="bold">
                    Job #{bar.jobId}
                  </text>
                  <text x={flip ? bx - 114 : bx + 8} y={Math.max(PAD.top + 2, byy - 10) + 25}
                    fill="#9ca3af" fontSize="9" fontFamily="monospace">
                    {bar.totalDisbursedFormatted}
                  </text>
                  <text x={flip ? bx - 114 : bx + 8} y={Math.max(PAD.top + 2, byy - 10) + 37}
                    fill="#6b7280" fontSize="8" fontFamily="monospace">
                    {bar.recipientCount} recipients
                  </text>
                  <text x={flip ? bx - 114 : bx + 8} y={Math.max(PAD.top + 2, byy - 10) + 49}
                    fill="#4b5563" fontSize="8" fontFamily="monospace">
                    {fmt.timestamp(bar.timestamp)} · click to detail
                  </text>
                </g>
              );
            })()}
          </svg>

          {/* Payment type legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {PAYMENT_TYPE_ORDER.map((type) => (
              <div key={type} className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: PAYMENT_TYPE_CONFIG[type]?.color || '#6b7280' }} />
                <span className="text-[9px] text-gray-500">
                  {PAYMENT_TYPE_CONFIG[type]?.label || type}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-1">
              <span className="inline-block w-5 border-t border-dashed border-cyan-500" />
              <span className="text-[9px] text-gray-500">Cumulative</span>
            </div>
          </div>
        </div>

        {/* ── Stats sidebar ── */}
        <div className="w-44 flex-shrink-0 border-l border-gray-800 pl-4">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-3">Economy</div>
          <Stat label="Total settled" value={`${stats.totalJobs} jobs`} />
          <Stat
            label="Total disbursed"
            value={`${fmt.guard(stats.totalDisbursed)} GUARD`}
            accent="text-amber-400"
          />
          <Stat
            label="Avg settlement"
            value={`${fmt.guard(stats.avgDisbursed)} GUARD`}
          />
          <Stat
            label="Avg recipients"
            value={stats.avgRecipients.toFixed(1)}
          />
          <Stat
            label="Platform revenue"
            value={`${fmt.guard(stats.platformRevenue)} GUARD`}
            accent="text-gray-400"
          />
          <div className="mt-4 text-[9px] text-gray-600 leading-relaxed">
            Click a bar to view full settlement breakdown
          </div>
        </div>
      </div>

      {/* Settlement detail modal */}
      {selectedSettlement && (
        <SettlementDetail
          settlementId={selectedSettlement.settlementId}
          onClose={() => setSelectedSettlement(null)}
        />
      )}
    </div>
  );
}

// ── Stat row ─────────────────────────────────────────────────

function Stat({ label, value, accent = 'text-gray-200' }) {
  return (
    <div className="mb-3">
      <div className="text-[10px] text-gray-600">{label}</div>
      <div className={`text-sm font-bold ${accent}`}>{value}</div>
    </div>
  );
}
