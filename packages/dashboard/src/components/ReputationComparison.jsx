import { useState } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── Per-agent accent colors ─────────────────────────────────
const PALETTE = ['#22d3ee', '#a855f7', '#fde047', '#f97316', '#4ade80', '#f87171'];

// ── ReputationComparison ────────────────────────────────────

export default function ReputationComparison() {
  const agents            = useStore((s) => s.agents);
  const reputationHistory = useStore((s) => s.reputationHistory);
  const [hidden, setHidden] = useState(new Set());

  // Build per-agent entries (only include agents that have history)
  const agentList = Object.entries(agents)
    .map(([addr, profile], i) => ({
      addr,
      name:       profile.name || profile.agentId || fmt.address(addr),
      history:    reputationHistory[addr] || [],
      currentRep: (profile.reputationScore || profile.reputation || 0) / 100,
      color:      profile.color || PALETTE[i % PALETTE.length],
    }))
    .filter((a) => a.history.length > 0);

  if (agentList.length === 0) {
    return (
      <div className="w-full h-[60px] flex items-center justify-center text-gray-600 text-xs font-mono">
        No agent history yet.
      </div>
    );
  }

  const toggleAgent = (addr) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(addr) ? next.delete(addr) : next.add(addr);
      return next;
    });

  // ── Chart geometry ──────────────────────────────────────
  const W = 600, H = 150;
  const PAD = { top: 10, right: 16, bottom: 22, left: 36 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const visible = agentList.filter((a) => !hidden.has(a.addr));
  const allPts  = visible.flatMap((a) => a.history);

  if (allPts.length === 0) {
    return (
      <div className="w-full">
        <LegendRow agents={agentList} hidden={hidden} onToggle={toggleAgent} />
        <div className="h-[60px] flex items-center justify-center text-gray-600 text-xs font-mono">
          All agents hidden.
        </div>
      </div>
    );
  }

  const minT = Math.min(...allPts.map((p) => p.timestamp));
  const maxT = Math.max(...allPts.map((p) => p.timestamp));
  const tRange = maxT - minT || 1;

  const allReps  = allPts.map((p) => p.reputation || 0);
  const rawMin   = Math.min(...allReps);
  const rawMax   = Math.max(...allReps);
  const step     = (rawMax - rawMin) > 1000 ? 200 : 100;
  const minRep   = Math.max(0,     Math.floor(rawMin / step) * step - step);
  const maxRep   = Math.min(10000, Math.ceil(rawMax  / step) * step + step);
  const repRange = maxRep - minRep || 1;

  const xOf = (t) => PAD.left + ((t - minT) / tRange) * innerW;
  const yOf = (r) => PAD.top  + innerH - ((r - minRep) / repRange) * innerH;

  // Y-axis ticks
  const yTicks = [];
  for (let r = Math.ceil(minRep / step) * step; r <= maxRep; r += step) {
    yTicks.push(r);
  }

  return (
    <div className="w-full font-mono text-xs">
      {/* Legend toggles */}
      <LegendRow agents={agentList} hidden={hidden} onToggle={toggleAgent} />

      {/* SVG chart */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {/* Y-axis gridlines + labels */}
        {yTicks.map((r) => (
          <g key={r}>
            <line
              x1={PAD.left} y1={yOf(r)} x2={W - PAD.right} y2={yOf(r)}
              stroke="#1f2937" strokeWidth="1"
            />
            <text
              x={PAD.left - 4} y={yOf(r)}
              textAnchor="end" dominantBaseline="middle"
              fill="#4b5563" fontSize="9" fontFamily="monospace"
            >
              {(r / 100).toFixed(0)}
            </text>
          </g>
        ))}

        {/* One polyline per visible agent */}
        {visible.map((agent) => {
          const pts = agent.history
            .slice()
            .sort((a, b) => a.timestamp - b.timestamp);
          if (pts.length < 2) return null;
          const points = pts
            .map((p) => `${xOf(p.timestamp).toFixed(1)},${yOf(p.reputation || 0).toFixed(1)}`)
            .join(' ');
          return (
            <polyline
              key={agent.addr}
              points={points}
              fill="none"
              stroke={agent.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
          );
        })}

        {/* Terminal dot for each visible agent */}
        {visible.map((agent) => {
          const pts = agent.history.slice().sort((a, b) => a.timestamp - b.timestamp);
          const last = pts[pts.length - 1];
          if (!last) return null;
          return (
            <circle
              key={agent.addr + '-dot'}
              cx={xOf(last.timestamp)}
              cy={yOf(last.reputation || 0)}
              r="4"
              fill={agent.color}
              stroke="#111827"
              strokeWidth="1.5"
            />
          );
        })}

        {/* X-axis labels */}
        {allPts.length >= 2 && (
          <>
            <text
              x={PAD.left} y={H - 4}
              textAnchor="start" fill="#374151" fontSize="9" fontFamily="monospace"
            >
              {fmt.timestamp(minT)}
            </text>
            <text
              x={W - PAD.right} y={H - 4}
              textAnchor="end" fill="#374151" fontSize="9" fontFamily="monospace"
            >
              {fmt.timestamp(maxT)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

// ── Legend row ──────────────────────────────────────────────

function LegendRow({ agents, hidden, onToggle }) {
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {agents.map((agent) => {
        const isHidden = hidden.has(agent.addr);
        return (
          <button
            key={agent.addr}
            onClick={() => onToggle(agent.addr)}
            className={[
              'flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold transition-opacity font-mono',
              isHidden ? 'opacity-30 border-gray-700 text-gray-500' : 'border-current',
            ].join(' ')}
            style={{ color: isHidden ? undefined : agent.color }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 2,
                backgroundColor: agent.color,
                borderRadius: 1,
                verticalAlign: 'middle',
              }}
            />
            {agent.name}
            <span className="text-gray-400 ml-0.5">{agent.currentRep.toFixed(2)}</span>
          </button>
        );
      })}
    </div>
  );
}
