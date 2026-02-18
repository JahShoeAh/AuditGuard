import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── StakingChart ────────────────────────────────────────────
// Shows staking history for a single agent address.
// Green area = available stake, amber area = locked stake.
// Red vertical lines = slash events.

export default function StakingChart({ addr }) {
  const history    = useStore((s) => s.stakeHistory[addr] || []);
  const slashEvents = useStore((s) => s.slashEvents);

  const mySlashes = slashEvents.filter(
    (e) => e.agent?.toLowerCase() === addr?.toLowerCase()
  );

  if (history.length < 2) {
    return (
      <div className="w-full h-[90px] flex items-center justify-center text-gray-600 text-[10px] font-mono">
        No staking history yet.
      </div>
    );
  }

  // ── Chart geometry ──────────────────────────────────────
  const W = 400, H = 90;
  const PAD = { top: 8, right: 16, bottom: 20, left: 48 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const pts = history.slice().sort((a, b) => a.timestamp - b.timestamp);

  const maxStake = Math.max(...pts.map((p) => p.stakeAmount || 0), 1);
  const yScale   = innerH / maxStake;

  const xOf = (i) => PAD.left + (i / Math.max(1, pts.length - 1)) * innerW;
  const yOf = (v) => PAD.top + innerH - (v || 0) * yScale;

  // ── Build SVG area paths ────────────────────────────────

  // Total stake area (green background): trace top edge, then back along bottom
  const totalAreaD = [
    `M ${xOf(0)},${PAD.top + innerH}`,
    ...pts.map((p, i) => `L ${xOf(i)},${yOf(p.stakeAmount || 0)}`),
    `L ${xOf(pts.length - 1)},${PAD.top + innerH}`,
    'Z',
  ].join(' ');

  // Locked area (amber, stacked from baseline up to locked amount)
  const lockedAreaD = [
    `M ${xOf(0)},${PAD.top + innerH}`,
    ...pts.map((p, i) => `L ${xOf(i)},${yOf(p.lockedAmount || 0)}`),
    `L ${xOf(pts.length - 1)},${PAD.top + innerH}`,
    'Z',
  ].join(' ');

  // Total stake polyline points
  const totalPoly = pts.map((p, i) => `${xOf(i)},${yOf(p.stakeAmount || 0)}`).join(' ');
  const lockedPoly = pts.map((p, i) => `${xOf(i)},${yOf(p.lockedAmount || 0)}`).join(' ');

  // ── Slash markers: find nearest history index per slash ──
  const slashXs = mySlashes.map((slash) => {
    const ts = slash.timestamp || 0;
    let best = 0, bestDiff = Infinity;
    pts.forEach((p, i) => {
      const diff = Math.abs((p.timestamp || 0) - ts);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    return xOf(best);
  });

  // ── Y-axis ticks (0, 50%, 100%) ──────────────────────────
  const yTicks = [0, maxStake * 0.5, maxStake];

  return (
    <div className="w-full font-mono">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {/* Y-axis gridlines + labels */}
        {yTicks.map((v, ti) => (
          <g key={ti}>
            <line
              x1={PAD.left} y1={yOf(v)} x2={W - PAD.right} y2={yOf(v)}
              stroke="#1f2937" strokeWidth="1"
            />
            <text
              x={PAD.left - 4} y={yOf(v)}
              textAnchor="end" dominantBaseline="middle"
              fill="#4b5563" fontSize="8" fontFamily="monospace"
            >
              {fmt.guard(Math.round(v))}
            </text>
          </g>
        ))}

        {/* Green area: available (total minus locked) */}
        <path d={totalAreaD} fill="rgba(74,222,128,0.15)" />

        {/* Amber area: locked stake */}
        <path d={lockedAreaD} fill="rgba(245,158,11,0.3)" />

        {/* Total stake line */}
        <polyline
          points={totalPoly}
          fill="none"
          stroke="#4ade80"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Locked stake line (dashed amber) */}
        <polyline
          points={lockedPoly}
          fill="none"
          stroke="#f59e0b"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Slash event markers */}
        {slashXs.map((x, i) => (
          <line
            key={i}
            x1={x} y1={PAD.top}
            x2={x} y2={PAD.top + innerH}
            stroke="#ef4444"
            strokeWidth="1.5"
            opacity="0.75"
          />
        ))}

        {/* X-axis labels: first and last timestamp */}
        {pts.length >= 2 && (
          <>
            <text
              x={PAD.left} y={H - 4}
              textAnchor="start" fill="#374151" fontSize="8" fontFamily="monospace"
            >
              {fmt.timestamp(pts[0].timestamp)}
            </text>
            <text
              x={W - PAD.right} y={H - 4}
              textAnchor="end" fill="#374151" fontSize="8" fontFamily="monospace"
            >
              {fmt.timestamp(pts[pts.length - 1].timestamp)}
            </text>
          </>
        )}
      </svg>

      {/* Legend */}
      <div className="flex gap-3 text-[10px] mt-0.5">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1.5 bg-green-400 rounded" />
          Available
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1.5 bg-amber-400 rounded" />
          Locked
        </span>
        {mySlashes.length > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <span className="inline-block w-px h-3 bg-red-400" />
            Slash ({mySlashes.length})
          </span>
        )}
      </div>
    </div>
  );
}
