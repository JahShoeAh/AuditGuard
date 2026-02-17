import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGuardFlows, getFlowColor } from '../hooks/useGuardFlows';

// ── Quadratic bezier helpers ──────────────────────────────────

function qb(t, p0, p1, p2) {
  const m = 1 - t;
  return m * m * p0 + 2 * m * t * p1 + t * t * p2;
}

function buildKeyframes(N, x0, cpX, x1, y0, cpY, y1) {
  const kx = [], ky = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    kx.push(qb(t, x0, cpX, x1));
    ky.push(qb(t, y0, cpY, y1));
  }
  return { kx, ky };
}

// ── Single flow arc (manages its own lifetime) ────────────────

function FlowArc({ arc, nodeMap, containerH }) {
  const [alive, setAlive]          = useState(true);
  const [particleAlive, setParticle] = useState(true);

  useEffect(() => {
    const t1 = setTimeout(() => setParticle(false), 1800);
    const t2 = setTimeout(() => setAlive(false),    7500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (!alive) return null;

  const src = nodeMap.get(arc.from?.toLowerCase?.() ?? arc.from);
  const dst = nodeMap.get(arc.to?.toLowerCase?.()   ?? arc.to);
  if (!src || !dst || src === dst) return null;

  const x0 = src.x, y0 = src.y;
  const x1 = dst.x, y1 = dst.y;
  const cpX = (x0 + x1) / 2;
  const arcH = Math.max(48, Math.min(containerH * 0.52, Math.abs(x1 - x0) * 0.45 + 28));
  const cpY = Math.min(y0, y1) - arcH;

  const { kx, ky } = buildKeyframes(22, x0, cpX, x1, y0, cpY, y1);

  // Label position at arc peak (t=0.5)
  const lx = qb(0.5, x0, cpX, x1);
  const ly = qb(0.5, y0, cpY, y1) - 9;

  const color = getFlowColor(arc.type);
  const d = `M ${x0} ${y0} Q ${cpX} ${cpY} ${x1} ${y1}`;

  return (
    <g>
      {/* Arc path — draws on with pathLength then fades */}
      <motion.path
        d={d}
        stroke={color}
        strokeWidth={1.5}
        fill="none"
        strokeDasharray="5 3"
        initial={{ pathLength: 0, opacity: 0.5 }}
        animate={{ pathLength: 1, opacity: alive ? 0.35 : 0 }}
        transition={{
          pathLength: { duration: 1.4, ease: 'easeOut' },
          opacity:    { duration: alive ? 0.3 : 2.5 },
        }}
      />

      {/* Amount label */}
      <motion.text
        x={lx}
        y={ly}
        textAnchor="middle"
        fill={color}
        fontSize="8"
        fontFamily="monospace"
        fontWeight="600"
        initial={{ opacity: 0 }}
        animate={{ opacity: alive ? 0.95 : 0 }}
        transition={{ delay: 0.6, duration: 0.3 }}
      >
        {arc.amountFormatted || '?'}
      </motion.text>

      {/* Glowing particle */}
      {particleAlive && (
        <motion.g
          initial={{ x: kx[0], y: ky[0] }}
          animate={{ x: kx, y: ky }}
          transition={{ duration: 1.5, ease: 'linear' }}
        >
          {/* Glow ring */}
          <circle r={7} cx={0} cy={0} fill={color} opacity={0.2} />
          {/* Core */}
          <circle r={4} cx={0} cy={0} fill={color} opacity={0.95} />
        </motion.g>
      )}
    </g>
  );
}

// ── Agent node ────────────────────────────────────────────────

function AgentNode({ node }) {
  return (
    <g>
      {/* Outer glow ring */}
      <circle cx={node.x} cy={node.y} r={11} fill={node.color} opacity={0.08} />
      {/* Node circle */}
      <circle cx={node.x} cy={node.y} r={7}  fill={node.color} opacity={0.85} />
      <circle cx={node.x} cy={node.y} r={7}  fill="none" stroke={node.color} strokeWidth={1.5} opacity={0.35} />
      {/* Label */}
      <text
        x={node.x}
        y={node.y + 20}
        textAnchor="middle"
        fill="#9ca3af"
        fontSize="8"
        fontFamily="monospace"
      >
        {node.name.length > 11 ? node.name.slice(0, 10) + '…' : node.name}
      </text>
    </g>
  );
}

// ── Empty state ───────────────────────────────────────────────

function EmptyFlow() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <motion.div
        animate={{ opacity: [0.2, 0.5, 0.2] }}
        transition={{ duration: 3, repeat: Infinity }}
        className="text-2xl"
      >
        ⟳
      </motion.div>
      <p className="text-[10px] text-gray-600 font-mono">
        Waiting for first GUARD transfer…
      </p>
    </div>
  );
}

// ── Main PaymentFlow ──────────────────────────────────────────

export default function PaymentFlow() {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Track container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { recentFlows, agentNodes, totalTransacted } = useGuardFlows(120);

  // Compute positioned nodes from agentNodes
  const [nodePositions, nodeMap] = (() => {
    if (dims.w === 0 || agentNodes.length === 0) return [[], new Map()];
    const PAD    = 48;
    const NODE_Y = dims.h - 50;
    const n      = agentNodes.length;
    const step   = n > 1 ? (dims.w - PAD * 2) / (n - 1) : 0;

    const positioned = agentNodes.map((node, i) => ({
      ...node,
      x: n === 1 ? dims.w / 2 : PAD + i * step,
      y: NODE_Y,
    }));

    const map = new Map();
    for (const node of positioned) {
      map.set(node.address, node);
    }

    return [positioned, map];
  })();

  // Local arc queue — each flow spawns one arc then self-removes
  const spawnedRef = useRef(new Set());
  const [activeArcs, setActiveArcs] = useState([]);

  useEffect(() => {
    for (const flow of recentFlows) {
      const id = `${flow.from}-${flow.to}-${flow.timestamp}`;
      if (spawnedRef.current.has(id)) continue;

      spawnedRef.current.add(id);
      const arc = { ...flow, arcId: id };
      setActiveArcs((prev) => [arc, ...prev].slice(0, 24));

      // Remove after 8s (matches arc lifetime)
      setTimeout(() => {
        setActiveArcs((prev) => prev.filter((a) => a.arcId !== id));
      }, 8200);
    }
  }, [recentFlows]);

  const totalDisplay =
    totalTransacted < 1
      ? `${(totalTransacted * 100).toFixed(2)} m`
      : totalTransacted.toFixed(2);

  return (
    <div className="panel flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.04] flex-shrink-0 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold" style={{ color: 'var(--accent-gold)' }}>
            ◈
          </span>
          <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-gray-400">
            Guard Flow
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {activeArcs.length > 0 && (
            <span className="text-[9px] font-mono text-gray-600 terminal-cursor">live</span>
          )}
          <span
            className="text-[11px] font-mono font-semibold"
            style={{ color: 'var(--accent-gold)' }}
          >
            {totalDisplay} GUARD
          </span>
        </div>
      </div>

      {/* SVG canvas */}
      <div ref={containerRef} className="flex-1 relative min-h-0 overflow-hidden">
        {dims.w === 0 ? null : nodePositions.length === 0 ? (
          <EmptyFlow />
        ) : (
          <svg
            width={dims.w}
            height={dims.h}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {/* Background grid lines (subtle) */}
            {nodePositions.map((node) => (
              <line
                key={`grid-${node.address}`}
                x1={node.x}
                y1={0}
                x2={node.x}
                y2={node.y - 12}
                stroke={node.color}
                strokeWidth={0.5}
                opacity={0.06}
                strokeDasharray="3 6"
              />
            ))}

            {/* Flow arcs */}
            <AnimatePresence>
              {activeArcs.map((arc) => (
                <FlowArc
                  key={arc.arcId}
                  arc={arc}
                  nodeMap={nodeMap}
                  containerH={dims.h}
                />
              ))}
            </AnimatePresence>

            {/* Agent nodes (on top) */}
            {nodePositions.map((node) => (
              <AgentNode key={node.address} node={node} />
            ))}
          </svg>
        )}

        {/* Flow legend */}
        {activeArcs.length === 0 && nodePositions.length > 0 && (
          <div className="absolute inset-x-0 top-1/3 flex justify-center">
            <EmptyFlow />
          </div>
        )}
      </div>
    </div>
  );
}
