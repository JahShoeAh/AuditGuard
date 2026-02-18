import { useEffect, useRef, useState, useCallback } from 'react';
import { useNetworkGraph } from '../hooks/useNetworkGraph';
import { FLOW_COLORS } from '../hooks/useGuardFlows';
import { fmt } from '../utils/format';

// ── Force simulation ─────────────────────────────────────────

function initPositions(nodes, existingPos, W, H) {
  const pos = {};

  // Copy existing stable positions
  for (const [id, p] of Object.entries(existingPos)) {
    pos[id] = { x: p.x, y: p.y, vx: 0, vy: 0, pinned: p.pinned || false };
  }

  // Preset special nodes (pinned)
  if (!pos['vault'])    pos['vault']    = { x: W * 0.50, y: 55,      vx: 0, vy: 0, pinned: true };
  if (!pos['treasury']) pos['treasury'] = { x: W * 0.82, y: H - 55,  vx: 0, vy: 0, pinned: true };

  // Place new agent nodes in a circle
  const agentNodes = nodes.filter((n) => n.type === 'agent' && !pos[n.id]);
  agentNodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, agentNodes.length) - Math.PI / 2;
    pos[n.id] = {
      x: W * 0.44 + 130 * Math.cos(angle),
      y: H * 0.52 + 100 * Math.sin(angle),
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      pinned: false,
    };
  });

  return pos;
}

function runSimulation(nodes, edges, existingPos, W, H, iterations = 180) {
  const pos = initPositions(nodes, existingPos, W, H);
  const ids = nodes.map((n) => n.id);

  const REPULSION = 9000;
  const IDEAL_LEN = 155;
  const SPRING_K  = 0.038;
  const GRAVITY   = 0.006;
  const DAMPING   = 0.72;

  for (let iter = 0; iter < iterations; iter++) {
    const acc = {};
    for (const id of ids) acc[id] = { ax: 0, ay: 0 };

    // Repulsion between all pairs
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos[ids[i]], b = pos[ids[j]];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy || 0.01;
        const dist  = Math.sqrt(dist2);
        const force = REPULSION / dist2;
        acc[ids[i]].ax -= force * dx / dist;
        acc[ids[i]].ay -= force * dy / dist;
        acc[ids[j]].ax += force * dx / dist;
        acc[ids[j]].ay += force * dy / dist;
      }
    }

    // Spring attraction along edges
    for (const edge of edges) {
      const a = pos[edge.source], b = pos[edge.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const spring = SPRING_K * (dist - IDEAL_LEN);
      if (!a.pinned) { acc[edge.source].ax += spring * dx / dist; acc[edge.source].ay += spring * dy / dist; }
      if (!b.pinned) { acc[edge.target].ax -= spring * dx / dist; acc[edge.target].ay -= spring * dy / dist; }
    }

    // Center gravity (applied to agent nodes)
    const cx = W * 0.44, cy = H * 0.52;
    for (const id of ids) {
      if (!pos[id] || pos[id].pinned) continue;
      acc[id].ax += (cx - pos[id].x) * GRAVITY;
      acc[id].ay += (cy - pos[id].y) * GRAVITY;
    }

    // Integrate + damp + clamp
    for (const id of ids) {
      const p = pos[id];
      if (!p || p.pinned) continue;
      p.vx = (p.vx + acc[id].ax) * DAMPING;
      p.vy = (p.vy + acc[id].ay) * DAMPING;
      p.x  = Math.max(40, Math.min(W - 40, p.x + p.vx));
      p.y  = Math.max(40, Math.min(H - 40, p.y + p.vy));
    }
  }

  return pos;
}

// ── Edge path (curved quadratic bezier) ─────────────────────

function edgePath(x1, y1, x2, y2, curvature = 0.22, offset = 0) {
  const dx = x2 - x1, dy = y2 - y1;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // Control point: perpendicular to midpoint + optional parallel offset
  const cx = mx - dy * curvature + dx * offset / len;
  const cy = my + dx * curvature + dy * offset / len;
  return `M ${x1.toFixed(1)},${y1.toFixed(1)} Q ${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

// ── Tier ring ────────────────────────────────────────────────

function TierRings({ cx, cy, r, tier }) {
  if (tier <= 0) return null;
  return (
    <>
      <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      {tier >= 2 && (
        <circle cx={cx} cy={cy} r={r + 9} fill="none" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      )}
    </>
  );
}

// ── Edge type legend config ──────────────────────────────────

const LEGEND_EDGES = [
  { type: 'MAIN_AUDIT',    label: 'Main Audit'     },
  { type: 'SUB_CONTRACT',  label: 'Sub-Contract'   },
  { type: 'DATA_PURCHASE', label: 'Data Purchase'  },
  { type: 'PLATFORM_FEE',  label: 'Platform Fee'   },
  { type: 'REPORT_FEE',    label: 'Report Fee'     },
];

// ── NetworkGraph ─────────────────────────────────────────────

export default function NetworkGraph() {
  const { nodes, edges } = useNetworkGraph();

  const W = 760, H = 460;

  // Stable positions across data updates
  const posRef    = useRef({});
  const [positions, setPositions] = useState({});

  // Hover state
  const [hoveredNode, setHoveredNode] = useState(null);
  const [hoveredEdge, setHoveredEdge] = useState(null);
  const [tooltipPos,  setTooltipPos]  = useState({ x: 0, y: 0 });

  // Flash effect for newly-added edges
  const prevEdgeIdsRef = useRef(new Set());
  const [flashEdges, setFlashEdges] = useState(new Set());

  // Rebuild simulation when topology changes
  const nodeKey = nodes.map((n) => n.id).sort().join(',');
  const edgeKey = edges.map((e) => e.id).sort().join(',');

  useEffect(() => {
    if (nodes.length === 0) return;
    const newPos = runSimulation(nodes, edges, posRef.current, W, H);
    posRef.current = newPos;
    setPositions({ ...newPos });
  }, [nodeKey, edgeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect new edges → flash
  useEffect(() => {
    const current = new Set(edges.map((e) => e.id));
    const added   = new Set([...current].filter((id) => !prevEdgeIdsRef.current.has(id)));
    prevEdgeIdsRef.current = current;
    if (added.size > 0) {
      setFlashEdges(added);
      const t = setTimeout(() => setFlashEdges(new Set()), 3_000);
      return () => clearTimeout(t);
    }
  }, [edgeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mouse handlers
  const handleSvgMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  // Connected edges per node (for highlight)
  const connectedTo = hoveredNode
    ? new Set(edges.filter((e) => e.source === hoveredNode || e.target === hoveredNode).flatMap((e) => [e.source, e.target]))
    : null;

  if (nodes.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm font-mono">
        Enable mock events — connections form as agents transact.
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-gray-950 overflow-hidden select-none">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleSvgMouseMove}
        onMouseLeave={() => { setHoveredNode(null); setHoveredEdge(null); }}
      >
        {/* ── Background grid ── */}
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#111827" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />

        {/* ── Empty-state label ── */}
        {edges.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="#374151" fontSize="13" fontFamily="monospace">
            Connections form as agents transact...
          </text>
        )}

        {/* ── Edges ── */}
        {edges.map((edge, idx) => {
          const src = positions[edge.source];
          const tgt = positions[edge.target];
          if (!src || !tgt) return null;

          // Parallel edges between same pair get different curvature offsets
          const sameDir = edges.filter(
            (e) => (e.source === edge.source && e.target === edge.target) ||
                   (e.source === edge.target && e.target === edge.source)
          );
          const edgeRank = sameDir.indexOf(edge);
          const curve    = 0.18 + edgeRank * 0.12;

          const d = edgePath(src.x, src.y, tgt.x, tgt.y, curve);

          const isHoveredEdge = hoveredEdge === edge.id;
          const dimmed = hoveredNode && !connectedTo?.has(edge.source) && !connectedTo?.has(edge.target);
          const isFlash = flashEdges.has(edge.id);
          const opacity = dimmed ? 0.08 : edge.isRecent ? (isFlash ? 1 : 0.75) : 0.3;
          const sw = edge.strokeWidth * (isHoveredEdge ? 2 : 1);

          return (
            <g key={edge.id}
              onMouseEnter={() => setHoveredEdge(edge.id)}
              onMouseLeave={() => setHoveredEdge(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Glow layer for flash */}
              {isFlash && (
                <path d={d} fill="none"
                  stroke={edge.color} strokeWidth={sw + 4} opacity="0.2" strokeLinecap="round" />
              )}
              {/* Main edge line */}
              <path d={d} fill="none"
                stroke={edge.color}
                strokeWidth={sw}
                opacity={opacity}
                strokeLinecap="round"
              />
              {/* Hover hit area (wider transparent) */}
              <path d={d} fill="none" stroke="transparent" strokeWidth={12} />

              {/* Particle animation on recent edges */}
              {edge.isRecent && (
                <circle r="3" fill={edge.color} opacity="0.9">
                  <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}

        {/* ── Nodes ── */}
        {nodes.map((node) => {
          const p = positions[node.id];
          if (!p) return null;

          const isHovered  = hoveredNode === node.id;
          const dimmed     = hoveredNode && !connectedTo?.has(node.id);
          const opacity    = dimmed ? 0.25 : 1;
          const borderW    = node.type === 'agent'
            ? Math.max(1.5, (node.reputation / 10000) * 4)
            : 2;

          return (
            <g key={node.id}
              transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
              opacity={opacity}
              onMouseEnter={() => { setHoveredNode(node.id); setHoveredEdge(null); }}
              style={{ cursor: 'pointer' }}
            >
              {/* Tier rings */}
              <TierRings cx={0} cy={0} r={node.radius} tier={node.tier} color={node.color} />

              {/* Hover glow */}
              {isHovered && (
                <circle r={node.radius + 7} fill={node.color} opacity="0.15" />
              )}

              {/* Main node shape */}
              {node.type === 'vault' ? (
                // Vault: gold square rotated 45° (diamond)
                <rect x={-node.radius * 0.75} y={-node.radius * 0.75}
                  width={node.radius * 1.5} height={node.radius * 1.5}
                  rx="2"
                  fill="#1c1917"
                  stroke={node.color}
                  strokeWidth={3}
                  transform="rotate(45)"
                />
              ) : node.type === 'treasury' ? (
                // Treasury: gray diamond
                <polygon
                  points={`0,${-node.radius} ${node.radius},0 0,${node.radius} ${-node.radius},0`}
                  fill="#1f2937"
                  stroke={node.color}
                  strokeWidth={2}
                />
              ) : (
                // Agent: circle
                <circle r={node.radius}
                  fill="#111827"
                  stroke={node.color}
                  strokeWidth={borderW}
                  style={{ color: node.color }}
                />
              )}

              {/* Node label */}
              <text
                y={node.radius + 12}
                textAnchor="middle"
                fill={isHovered ? '#e5e7eb' : '#9ca3af'}
                fontSize="10"
                fontFamily="monospace"
                fontWeight={isHovered ? 'bold' : 'normal'}
              >
                {node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label}
              </text>
              {node.type === 'agent' && node.reputation > 0 && (
                <text
                  y={node.radius + 22}
                  textAnchor="middle"
                  fill="#4b5563"
                  fontSize="8"
                  fontFamily="monospace"
                >
                  {(node.reputation / 100).toFixed(0)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* ── Hover tooltip ── */}
      {(hoveredNode || hoveredEdge) && (
        <div
          className="absolute z-20 pointer-events-none bg-gray-900 border border-gray-700 rounded px-2.5 py-2 text-[11px] font-mono shadow-xl"
          style={{
            left: tooltipPos.x + 14,
            top: tooltipPos.y - 10,
            transform: tooltipPos.x > W * 0.65 ? 'translateX(calc(-100% - 28px))' : 'none',
          }}
        >
          {hoveredNode && (() => {
            const node  = nodes.find((n) => n.id === hoveredNode);
            const count = edges.filter((e) => e.source === hoveredNode || e.target === hoveredNode).length;
            if (!node) return null;
            return (
              <>
                <div className="font-bold text-gray-100">{node.label}</div>
                {node.type === 'agent' && (
                  <div className="text-gray-400 mt-0.5">
                    Rep: <span className="text-gray-200">{(node.reputation / 100).toFixed(2)}</span>
                  </div>
                )}
                <div className="text-gray-400">
                  Earned: <span style={{ color: node.color }}>{fmt.guard(node.earned)} GUARD</span>
                </div>
                <div className="text-gray-500">{count} connection{count !== 1 ? 's' : ''}</div>
              </>
            );
          })()}
          {hoveredEdge && !hoveredNode && (() => {
            const edge = edges.find((e) => e.id === hoveredEdge);
            const src  = nodes.find((n) => n.id === edge?.source);
            const tgt  = nodes.find((n) => n.id === edge?.target);
            if (!edge) return null;
            return (
              <>
                <div className="font-bold" style={{ color: edge.color }}>
                  {edge.type.replace(/_/g, ' ')}
                </div>
                <div className="text-gray-400 mt-0.5">
                  {src?.label || edge.source} → {tgt?.label || edge.target}
                </div>
                <div className="text-gray-200 mt-0.5">
                  {fmt.guard(edge.totalAmount)} GUARD
                </div>
                <div className="text-gray-500">{edge.count} transaction{edge.count !== 1 ? 's' : ''}</div>
              </>
            );
          })()}
        </div>
      )}

      {/* ── Legend ── */}
      <div className="absolute bottom-2 right-3 bg-gray-900/90 border border-gray-800 rounded px-2.5 py-2 text-[10px] font-mono space-y-1 pointer-events-none">
        <div className="text-gray-500 uppercase tracking-widest text-[9px] mb-1.5">Edge types</div>
        {LEGEND_EDGES.map(({ type, label }) => (
          <div key={type} className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-px" style={{ backgroundColor: FLOW_COLORS[type] || '#6b7280' }} />
            <span className="text-gray-500">{label}</span>
          </div>
        ))}
        <div className="border-t border-gray-800 mt-1.5 pt-1.5 text-gray-600 text-[9px]">
          Size = earned · Thickness = volume
        </div>
      </div>

      {/* ── Edge count badge ── */}
      <div className="absolute top-2 left-3 text-[10px] font-mono text-gray-600">
        {nodes.length} nodes · {edges.length} edges
      </div>
    </div>
  );
}
