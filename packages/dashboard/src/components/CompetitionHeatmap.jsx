import { Fragment, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useCompetitionData } from '../hooks/useCompetitionData';

function intensityToColor(winRate, bidCount, maxBids) {
  if (maxBids <= 0 || bidCount <= 0) return 'rgba(31, 41, 55, 0.35)';
  const rate = Math.max(0, Math.min(1, winRate));
  const bidIntensity = Math.max(0.25, Math.min(1, bidCount / maxBids));
  const r = Math.round(30 + (1 - rate) * 80);
  const g = Math.round(80 + rate * 140);
  const b = Math.round(70 + rate * 80);
  const a = 0.2 + bidIntensity * 0.75;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export default function CompetitionHeatmap() {
  const { agents, dynamicContractTypes, agentVsTypeMatrix } = useCompetitionData();

  const maxBids = useMemo(() => {
    let max = 0;
    for (const row of agentVsTypeMatrix || []) {
      for (const cell of row || []) {
        max = Math.max(max, Number(cell?.bids || 0));
      }
    }
    return max;
  }, [agentVsTypeMatrix]);

  if (!agents.length || !dynamicContractTypes.length) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[11px] text-gray-500 font-mono">
        <p>No competition data yet.</p>
        <p className="mt-1 text-[10px] text-gray-600">Heatmap populates after bids + winner selection.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-auto">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">&#x2B21;</span>
        <h2 className="text-sm font-bold font-mono uppercase tracking-widest text-gray-300">
          Competition Heatmap
        </h2>
      </div>

      <p className="text-[10px] text-gray-500 font-mono mb-4">
        Agent win-rate by contract type. Cell text: bids and win%.
      </p>

      <div className="flex-1">
        <div
          className="grid gap-0.5"
          style={{ gridTemplateColumns: `140px repeat(${dynamicContractTypes.length}, minmax(64px, 1fr))` }}
        >
          <div />
          {dynamicContractTypes.map((type) => (
            <div
              key={type}
              className="text-center text-[10px] font-mono font-bold uppercase tracking-wider text-gray-500 py-2"
            >
              {type}
            </div>
          ))}

          {agents.map((agent, rowIdx) => (
            <Fragment key={agent.address}>
              <div
                className="flex items-center gap-1.5 text-[11px] font-mono font-semibold pr-2 truncate"
                style={{ color: agent.color }}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.color }} />
                <span className="truncate">{agent.name}</span>
              </div>
              {dynamicContractTypes.map((type, colIdx) => {
                const cell = agentVsTypeMatrix?.[rowIdx]?.[colIdx] || { bids: 0, wins: 0, winRate: 0 };
                const bids = Number(cell.bids || 0);
                const wins = Number(cell.wins || 0);
                const winRate = Number(cell.winRate || 0);
                const bg = intensityToColor(winRate, bids, maxBids);
                return (
                  <motion.div
                    key={`${agent.address}-${type}`}
                    className="rounded min-h-[64px] flex flex-col items-center justify-center gap-0.5 border border-gray-800"
                    style={{ backgroundColor: bg }}
                    whileHover={{ scale: 1.03 }}
                    title={`${agent.name} / ${type}: ${bids} bids, ${wins} wins, ${(winRate * 100).toFixed(1)}%`}
                  >
                    <span className="text-sm font-bold text-white">{bids}</span>
                    <span className="text-[9px] font-mono text-gray-300">
                      {(winRate * 100).toFixed(0)}%
                    </span>
                  </motion.div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
