import { useMemo } from 'react';
import { motion } from 'framer-motion';
import useStore from '../store/index';

const CONTRACT_TYPES = ['lending', 'dex', 'staking', 'bridge', 'vault'];

const AGENT_ROLES = [
  { id: 'static-analysis-047', label: 'Static', color: '#22c55e' },
  { id: 'fuzzer-012', label: 'Fuzzer', color: '#eab308' },
  { id: 'llm-contextual-003', label: 'LLM', color: '#a855f7' },
];

function intensityToColor(value, maxValue) {
  if (maxValue === 0) return 'rgba(34, 211, 238, 0.05)';
  const t = Math.min(value / maxValue, 1);
  const r = Math.round(6 + t * 28);
  const g = Math.round(182 + t * 29);
  const b = Math.round(212 + t * 26);
  const a = 0.1 + t * 0.7;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export default function CompetitionHeatmap() {
  const events = useStore((s) => s.auditLog || []);

  const heatmapData = useMemo(() => {
    const bidMap = {};
    const winMap = {};

    for (const agent of AGENT_ROLES) {
      bidMap[agent.id] = {};
      winMap[agent.id] = {};
      for (const ct of CONTRACT_TYPES) {
        bidMap[agent.id][ct] = 0;
        winMap[agent.id][ct] = 0;
      }
    }

    for (const evt of events) {
      if (evt.type === 'BID_SUBMITTED') {
        const agentId = evt.agentId;
        const contractType = evt.payload?.contractType || 'unknown';
        if (bidMap[agentId] && CONTRACT_TYPES.includes(contractType)) {
          bidMap[agentId][contractType]++;
        }
      }
      if (evt.type === 'WINNER_SELECTED' || evt.type === 'WINNERS_SELECTED_FALLBACK') {
        const winners = evt.payload?.winners || [];
        const contractType = evt.payload?.contractType || 'unknown';
        for (const w of winners) {
          for (const agent of AGENT_ROLES) {
            if (w === agent.id && CONTRACT_TYPES.includes(contractType)) {
              winMap[agent.id][contractType]++;
            }
          }
        }
      }
    }

    let maxBids = 1;
    for (const agent of AGENT_ROLES) {
      for (const ct of CONTRACT_TYPES) {
        maxBids = Math.max(maxBids, bidMap[agent.id][ct]);
      }
    }

    return { bidMap, winMap, maxBids };
  }, [events]);

  return (
    <div className="h-full flex flex-col p-4 overflow-auto">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">&#x2B21;</span>
        <h2 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-300">
          Competition Heatmap
        </h2>
      </div>

      <p className="text-[10px] text-gray-500 font-mono mb-4">
        Bid activity per agent per contract type. Brighter = more bids submitted.
      </p>

      {/* Heatmap grid */}
      <div className="flex-1">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `100px repeat(${CONTRACT_TYPES.length}, 1fr)` }}>
          {/* Header row */}
          <div />
          {CONTRACT_TYPES.map((ct) => (
            <div
              key={ct}
              className="text-center text-[10px] font-mono font-bold uppercase tracking-wider text-gray-500 py-2"
            >
              {ct}
            </div>
          ))}

          {/* Agent rows */}
          {AGENT_ROLES.map((agent) => (
            <>
              <div
                key={`label-${agent.id}`}
                className="flex items-center gap-1.5 text-xs font-mono font-bold pr-2"
                style={{ color: agent.color }}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.color }} />
                {agent.label}
              </div>
              {CONTRACT_TYPES.map((ct) => {
                const bids = heatmapData.bidMap[agent.id]?.[ct] || 0;
                const wins = heatmapData.winMap[agent.id]?.[ct] || 0;
                const winRate = bids > 0 ? ((wins / bids) * 100).toFixed(0) : '--';

                return (
                  <motion.div
                    key={`${agent.id}-${ct}`}
                    className="rounded aspect-square flex flex-col items-center justify-center gap-0.5 border border-gray-800"
                    style={{ backgroundColor: intensityToColor(bids, heatmapData.maxBids) }}
                    whileHover={{ scale: 1.05 }}
                    title={`${agent.label} / ${ct}: ${bids} bids, ${wins} wins`}
                  >
                    <span className="text-sm font-bold text-white">{bids}</span>
                    <span className="text-[9px] font-mono text-gray-400">
                      {winRate}% win
                    </span>
                  </motion.div>
                );
              })}
            </>
          ))}
        </div>

        {/* Legend */}
        <div className="mt-6 flex items-center gap-4">
          <span className="text-[10px] font-mono text-gray-600">INTENSITY:</span>
          <div className="flex gap-0.5">
            {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((t) => (
              <div
                key={t}
                className="w-6 h-3 rounded-sm"
                style={{ backgroundColor: intensityToColor(t * 10, 10) }}
              />
            ))}
          </div>
          <span className="text-[10px] font-mono text-gray-600">LOW → HIGH</span>
        </div>
      </div>
    </div>
  );
}
