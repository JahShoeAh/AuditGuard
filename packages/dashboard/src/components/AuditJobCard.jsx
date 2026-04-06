import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { fmt } from '../utils/format';
import { hashscan } from '../utils/hashscan';
import SubContractTree from './SubContractTree';

// ── State machine stages ───────────────────────────────────
const STAGES = [
  { key: 'DISCOVERED',  label: 'DISC',   short: 'Discovered' },
  { key: 'AUCTION',     label: 'AUCT',   short: 'Auction'    },
  { key: 'AUDITING',    label: 'AUDIT',  short: 'Auditing'   },
  { key: 'COMPLETED',   label: 'COMPL',  short: 'Completed'  },
  { key: 'MONITORING',  label: 'MONIT',  short: 'Monitoring' },
];

// ── Contract type colors ───────────────────────────────────
const TYPE_COLORS = {
  lending:  '#22d3ee',
  dex:      '#a855f7',
  staking:  '#4ade80',
  vault:    '#f59e0b',
};

// ── Risk score color ───────────────────────────────────────
function riskColor(score) {
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#4ade80';
}

// ── State machine pipeline SVG ─────────────────────────────
function StatePipeline({ currentStage }) {
  const N = STAGES.length;
  const W = 260, H = 36;
  const dotR = 5, activeDotR = 8;
  const dotY = 16;
  const xPositions = STAGES.map((_, i) => 16 + (i / (N - 1)) * (W - 32));

  return (
    <div className="relative" style={{ width: W, height: H + 20 }}>
      <svg width={W} height={H} style={{ overflow: 'visible' }}>
        {/* Connecting lines */}
        {STAGES.slice(1).map((_, i) => {
          const x1 = xPositions[i] + dotR;
          const x2 = xPositions[i + 1] - dotR;
          const done = i + 1 <= currentStage;
          return (
            <line key={i}
              x1={x1} y1={dotY} x2={x2} y2={dotY}
              stroke={done ? '#4ade80' : '#374151'}
              strokeWidth="2"
            />
          );
        })}

        {/* Dots */}
        {STAGES.map((stage, i) => {
          const x = xPositions[i];
          const isActive = i === currentStage;
          const isDone   = i < currentStage;
          const r = isActive ? activeDotR : dotR;

          return (
            <g key={stage.key}>
              {isActive && (
                <circle cx={x} cy={dotY} r={activeDotR + 4}
                  fill="rgba(74, 222, 128, 0.15)"
                  className="animate-pulse"
                />
              )}
              <circle
                cx={x} cy={dotY} r={r}
                fill={isDone ? '#4ade80' : isActive ? '#4ade80' : 'transparent'}
                stroke={isDone || isActive ? '#4ade80' : '#4b5563'}
                strokeWidth="2"
              />
              {isDone && (
                <text x={x} y={dotY + 1} textAnchor="middle" dominantBaseline="middle"
                  fill="#111827" fontSize="7" fontWeight="bold">
                  ✓
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Labels */}
      <div className="flex justify-between mt-0" style={{ paddingLeft: '12px', paddingRight: '12px' }}>
        {STAGES.map((stage, i) => (
          <span
            key={stage.key}
            className={`text-[9px] font-mono font-bold uppercase ${
              i === currentStage ? 'text-green-400' :
              i < currentStage  ? 'text-green-600' : 'text-gray-600'
            }`}
            style={{ width: `${100 / N}%`, textAlign: 'center' }}
          >
            {stage.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Phase timing bar ───────────────────────────────────────
function TimingBar({ discoveredAt, postedAt, winnersAt, settledAt }) {
  if (!discoveredAt) return null;
  const end   = settledAt || Date.now();
  const total = Math.max(1, end - discoveredAt);

  const phases = [
    { label: 'Discovery→Auction', start: discoveredAt, end: postedAt || discoveredAt, color: '#6b7280' },
    { label: 'Auction',           start: postedAt || discoveredAt, end: winnersAt || postedAt || end, color: '#22d3ee' },
    { label: 'Auditing',          start: winnersAt || postedAt || discoveredAt, end: settledAt || end, color: '#a855f7' },
  ];

  return (
    <div className="mt-2">
      <div className="h-2 rounded bg-gray-800 flex overflow-hidden">
        {phases.map((ph, i) => {
          const width = Math.max(0, ((ph.end - ph.start) / total) * 100);
          return (
            <div
              key={i}
              style={{ width: `${width}%`, backgroundColor: ph.color }}
              title={`${ph.label}: ${fmt.duration((ph.end - ph.start) / 1000)}`}
            />
          );
        })}
      </div>
      {settledAt && discoveredAt && (
        <div className="text-[9px] text-gray-600 font-mono mt-0.5">
          Total: {fmt.duration((settledAt - discoveredAt) / 1000)}
        </div>
      )}
    </div>
  );
}

// ── AuditJobCard ───────────────────────────────────────────

export default function AuditJobCard({ job }) {
  const [expanded, setExpanded] = useState(false);
  const typeColor = TYPE_COLORS[job.contractType] || '#6b7280';
  const classifierSummary = [
    job.riskSource ? `src:${job.riskSource}` : null,
    job.riskModel ? job.riskModel : null,
    job.topRiskFactors?.[0] ? `factor:${job.topRiskFactors[0]}` : null,
  ].filter(Boolean).join(' • ');

  return (
    <div className="border border-gray-900 rounded bg-gray-900/60 font-mono text-xs overflow-hidden min-w-[300px] max-w-[360px] flex-shrink-0">
      {/* ── Card header ── */}
      <div
        className="px-3 py-2 border-b flex items-start justify-between gap-2"
        style={{ borderColor: `${typeColor}30`, borderLeftWidth: 3, borderLeftColor: typeColor }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-gray-100 font-bold text-[13px]">JOB #{job.jobId}</span>
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase"
              style={{ color: typeColor, backgroundColor: `${typeColor}20` }}
            >
              {job.contractType?.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-gray-500">
            <a
              href={hashscan.contract(job.contractAddress)}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {fmt.address(job.contractAddress)}
            </a>
            <span>│</span>
            <span>{job.contractChain}</span>
            <span>│</span>
            <span style={{ color: riskColor(job.initialRiskScore) }}>Risk {job.initialRiskScore}/100</span>
          </div>
          {(classifierSummary || job.evmType || job.isProxy != null) && (
            <div className="mt-0.5 text-[10px] text-gray-600 font-mono truncate">
              {classifierSummary || '--'}
              {job.evmType ? ` • ${job.evmType}` : ''}
              {job.isProxy === true ? ' • proxy' : ''}
            </div>
          )}
        </div>
        {/* State badge */}
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${
          job.state === 'COMPLETED'         ? 'bg-green-900 text-green-300' :
          job.state === 'AUDITING_IN_PROGRESS' ? 'bg-purple-900 text-purple-300' :
          'bg-cyan-900 text-cyan-300'
        }`}>
          {job.state?.replace(/_/g, ' ')}
        </span>
      </div>

      {/* ── State machine ── */}
      <div className="px-3 pt-3 pb-1">
        <StatePipeline currentStage={job.currentStage} />
      </div>

      {/* ── Agents ── */}
      {job.winnerNames?.length > 0 && (
        <div className="px-3 py-1 text-gray-400">
          Agents: <span className="text-gray-200">{job.winnerNames.join(', ')}</span>
        </div>
      )}
      {job.bidCount > 0 && !job.winners && (
        <div className="px-3 py-1 text-cyan-600">
          {job.bidCount} bid{job.bidCount !== 1 ? 's' : ''} received
        </div>
      )}

      {/* ── Commerce density ── */}
      <div className="px-3 py-2 flex items-center gap-3 text-gray-500 border-t border-gray-800">
        <span title="Agents">👤 {job.winnerNames?.length || 0}</span>
        <span title="Sub-jobs">⛓ {job.subJobCount}</span>
        <span title="Data sales">📦 {job.listingCount}</span>
        <span title="Budget" className="text-amber-500 font-semibold ml-auto">{job.budgetFormatted}</span>
      </div>

      {/* ── Settlement summary ── */}
      {job.settlement && (
        <div className="px-3 py-1.5 bg-gray-950 text-green-400 font-semibold flex items-center gap-2 border-t border-gray-800">
          <span>↗</span>
          <span>{job.totalDisbursed} disbursed</span>
        </div>
      )}

      {/* ── Timing bar ── */}
      <div className="px-3 pb-2">
        <TimingBar
          discoveredAt={job.discoveredAt}
          postedAt={job.postedAt}
          winnersAt={job.winnersAt}
          settledAt={job.settledAt}
        />
      </div>

      {/* ── Expand toggle ── */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-1.5 text-[10px] text-gray-600 hover:text-gray-400 hover:bg-gray-800 transition-colors flex items-center gap-1 border-t border-gray-800"
      >
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.18 }}>
          ▾
        </motion.span>
        {expanded ? 'Hide detail' : 'Show sub-jobs + settlement'}
      </button>

      {/* ── Expanded detail ── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <SubContractTree parentJobId={job.jobId} />
            {job.settlement && (
              <div className="px-3 py-2 border-t border-gray-800">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Settlement</div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Total disbursed</span>
                  <span className="text-amber-400 font-semibold">{job.totalDisbursed}</span>
                </div>
                <div className="flex justify-between text-xs mt-0.5">
                  <span className="text-gray-500">Recipients</span>
                  <span className="text-gray-300">{job.settlement.recipientCount}</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
