import { useState, useRef, useCallback } from 'react';
import { fmt } from '../utils/format';

// ── Event type config ──────────────────────────────────────
const EVENT_CONFIG = {
  FINDING:        { color: '#4ade80', radius: 5, label: 'Valid Finding' },
  FALSE_POSITIVE: { color: '#f59e0b', radius: 5, label: 'False Positive' },
  JOB_COMPLETED:  { color: '#60a5fa', radius: 5, label: 'Job Completed' },
  SLASH:          { color: '#ef4444', radius: 6, label: 'Slash' },
};

function getEventConfig(eventType) {
  return EVENT_CONFIG[eventType] || { color: '#94a3b8', radius: 4, label: eventType || 'Update' };
}

// ── Trend arrow ────────────────────────────────────────────
function trendArrow(history) {
  if (!history || history.length < 2) return { icon: '→', color: 'text-gray-500', label: 'Stable' };
  const last5 = history.slice(-5);
  const slope = (last5[last5.length - 1].reputation - last5[0].reputation) / Math.max(1, last5.length - 1);
  if (slope > 20)  return { icon: '↗', color: 'text-green-400',  label: 'Rising'  };
  if (slope < -20) return { icon: '↘', color: 'text-red-400',    label: 'Falling' };
  return             { icon: '→', color: 'text-gray-400',  label: 'Stable'  };
}

// ── ReputationGraph ────────────────────────────────────────

export default function ReputationGraph({ history, currentReputation }) {
  const svgRef = useRef(null);
  const [hoveredIdx, setHoveredIdx] = useState(null);

  const pts = history || [];
  if (pts.length === 0) {
    return (
      <div className="w-full h-[180px] flex items-center justify-center text-gray-600 text-xs font-mono">
        No reputation history yet.
      </div>
    );
  }

  // ── Chart geometry ──────────────────────────────────────
  const W = 400, H = 160;
  const PAD = { top: 12, right: 16, bottom: 24, left: 36 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const reps = pts.map((p) => p.reputation || 0);
  const minRep = Math.max(0,   Math.floor(Math.min(...reps) / 100) * 100 - 100);
  const maxRep = Math.min(10000, Math.ceil(Math.max(...reps) / 100) * 100 + 100);
  const repRange = maxRep - minRep || 1;

  const xOf = (i) => PAD.left + (i / Math.max(1, pts.length - 1)) * innerW;
  const yOf = (rep) => PAD.top + innerH - ((rep - minRep) / repRange) * innerH;

  // ── Build colored line segments ─────────────────────────
  const segments = pts.slice(1).map((pt, i) => ({
    x1: xOf(i),   y1: yOf(pts[i].reputation),
    x2: xOf(i+1), y2: yOf(pt.reputation),
    positive: (pt.delta || 0) >= 0,
  }));

  // ── Slash zones (red background regions) ───────────────
  const slashZones = pts
    .map((pt, i) => ({ ...pt, i }))
    .filter((pt) => pt.eventType === 'SLASH' || pt.eventType === 'FALSE_POSITIVE');

  // ── Y-axis labels ───────────────────────────────────────
  const yTicks = [];
  for (let r = Math.ceil(minRep / 100) * 100; r <= maxRep; r += 100) {
    yTicks.push(r);
  }

  // ── Mouse tracking for tooltip ──────────────────────────
  const handleMouseMove = useCallback((e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || pts.length < 2) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const svgX = relX * W;
    const chartX = svgX - PAD.left;
    const idx = Math.round((chartX / innerW) * (pts.length - 1));
    setHoveredIdx(Math.max(0, Math.min(pts.length - 1, idx)));
  }, [pts.length, innerW]);

  const handleMouseLeave = useCallback(() => setHoveredIdx(null), []);

  const hoveredPt   = hoveredIdx != null ? pts[hoveredIdx] : null;
  const hoveredX    = hoveredIdx != null ? xOf(hoveredIdx) : null;
  const hoveredY    = hoveredPt  ? yOf(hoveredPt.reputation) : null;
  const evCfg       = hoveredPt  ? getEventConfig(hoveredPt.eventType) : null;

  // ── Stats ───────────────────────────────────────────────
  const allTimeHigh = Math.max(...reps);
  const allTimeLow  = Math.min(...reps);
  const deltas      = pts.filter((p) => p.delta != null).map((p) => p.delta);
  const avgDelta    = deltas.length > 0
    ? (deltas.reduce((a, b) => a + b, 0) / deltas.length)
    : 0;
  const trend = trendArrow(pts);
  const repNum = (currentReputation || (pts[pts.length - 1]?.reputation) || 0) / 100;

  const repColor = repNum >= 85 ? '#4ade80' : repNum >= 70 ? '#fde047' : repNum >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="w-full font-mono text-xs">
      {/* ── Stats row ── */}
      <div className="flex items-end gap-4 mb-2">
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Reputation</div>
          <div className="text-2xl font-bold" style={{ color: repColor }}>{repNum.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Trend</div>
          <div className={`text-xl font-bold ${trend.color}`}>{trend.icon}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">All-time High</div>
          <div className="text-green-400">{(allTimeHigh / 100).toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">All-time Low</div>
          <div className="text-red-400">{(allTimeLow / 100).toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Avg Δ/event</div>
          <div className={avgDelta >= 0 ? 'text-green-400' : 'text-red-400'}>
            {avgDelta >= 0 ? '+' : ''}{(avgDelta / 100).toFixed(2)}
          </div>
        </div>
      </div>

      {/* ── SVG chart ── */}
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ cursor: 'crosshair' }}
        >
          {/* Slash zones */}
          {slashZones.map((pt, i) => (
            <rect key={i}
              x={Math.max(PAD.left, xOf(pt.i) - 8)}
              y={PAD.top}
              width={16}
              height={innerH}
              fill="rgba(239,68,68,0.08)"
            />
          ))}

          {/* Y-axis gridlines + labels */}
          {yTicks.map((r) => (
            <g key={r}>
              <line
                x1={PAD.left} y1={yOf(r)} x2={W - PAD.right} y2={yOf(r)}
                stroke="#1f2937" strokeWidth="1"
              />
              <text x={PAD.left - 4} y={yOf(r)} textAnchor="end" dominantBaseline="middle"
                fill="#4b5563" fontSize="9" fontFamily="monospace">
                {(r / 100).toFixed(0)}
              </text>
            </g>
          ))}

          {/* Colored line segments */}
          {segments.map((seg, i) => (
            <line key={i}
              x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
              stroke={seg.positive ? '#4ade80' : '#ef4444'}
              strokeWidth="2"
              strokeLinecap="round"
            />
          ))}

          {/* Event annotation dots */}
          {pts.map((pt, i) => {
            const cfg = getEventConfig(pt.eventType);
            if (!pt.eventType) return null;
            return (
              <circle key={i}
                cx={xOf(i)} cy={yOf(pt.reputation)}
                r={cfg.radius}
                fill={cfg.color}
                stroke="#111827" strokeWidth="1.5"
                opacity="0.9"
              />
            );
          })}

          {/* Hover crosshair */}
          {hoveredIdx != null && hoveredX != null && (
            <>
              <line x1={hoveredX} y1={PAD.top} x2={hoveredX} y2={H - PAD.bottom}
                stroke="#60a5fa" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
              <circle cx={hoveredX} cy={hoveredY} r="5"
                fill="#60a5fa" stroke="#111827" strokeWidth="2" />
            </>
          )}

          {/* X-axis time labels (first and last) */}
          {pts.length >= 2 && (
            <>
              <text x={PAD.left} y={H - 4} textAnchor="start"
                fill="#374151" fontSize="9" fontFamily="monospace">
                {fmt.timestamp(pts[0].timestamp)}
              </text>
              <text x={W - PAD.right} y={H - 4} textAnchor="end"
                fill="#374151" fontSize="9" fontFamily="monospace">
                {fmt.timestamp(pts[pts.length - 1].timestamp)}
              </text>
            </>
          )}
        </svg>

        {/* Tooltip */}
        {hoveredPt && hoveredX != null && (
          <div
            className="absolute z-10 pointer-events-none bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-[10px] shadow-lg"
            style={{
              left: `${(hoveredX / W) * 100}%`,
              top: '4px',
              transform: hoveredIdx > pts.length * 0.7 ? 'translateX(-105%)' : 'translateX(8px)',
            }}
          >
            <div className="font-bold" style={{ color: evCfg?.color || '#94a3b8' }}>
              {evCfg?.label || 'Update'}
              {hoveredPt.label && <span className="ml-1 text-gray-400">— {hoveredPt.label}</span>}
            </div>
            <div className="text-gray-300 mt-0.5">
              Rep: <span className="font-bold">{(hoveredPt.reputation / 100).toFixed(2)}</span>
            </div>
            {hoveredPt.delta != null && (
              <div className={hoveredPt.delta >= 0 ? 'text-green-400' : 'text-red-400'}>
                Δ {hoveredPt.delta >= 0 ? '+' : ''}{(hoveredPt.delta / 100).toFixed(2)}
              </div>
            )}
            {hoveredPt.jobId && (
              <div className="text-gray-600 mt-0.5">Job #{hoveredPt.jobId}</div>
            )}
            <div className="text-gray-600">{fmt.relativeTime(hoveredPt.timestamp)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
