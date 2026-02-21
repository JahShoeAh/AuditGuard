import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import useStore from '../store';
import TransactionRow from './TransactionRow';
import SettlementDetail from './SettlementDetail';
import { useAutoScroll } from '../hooks/useAutoScroll';

// ── Filter tab config ─────────────────────────────────────

const TABS = [
  { key: 'ALL', label: 'ALL', types: null },
  { key: 'AUCTIONS', label: 'AUCTIONS', types: new Set(['CONTRACT_DISCOVERED', 'JobPosted', 'BidSubmitted', 'BID_SKIPPED', 'BID_SUBMISSION_FAILED', 'AUCTION_INVITE_SUMMARY', 'LLM_INFERENCE_STARTED', 'LLM_INFERENCE_SUCCEEDED', 'LLM_INFERENCE_FAILED', 'WinnersSelected', 'WINNERS_SELECTED', 'WINNER_SELECTED', 'BidRefunded']) },
  { key: 'SUB', label: 'SUB-CTR', types: new Set(['SUB_AUCTION_CREATED', 'SUB_BID', 'SUB_SELECTED', 'RESULT_DELIVERED', 'RESULT_ACCEPTED', 'SUB_JOB_SETTLED']) },
  { key: 'DATA', label: 'DATA', types: new Set(['DATA_LISTED', 'DATA_PURCHASED', 'DATA_RATED']) },
  { key: 'SETTLE', label: 'SETTLE', types: new Set(['JOB_SETTLED', 'SUB_JOB_SETTLED']) },
  { key: 'AGENTS', label: 'AGENTS', types: new Set(['AgentRegistered', 'ReputationUpdated', 'AgentPromoted', 'LLM_PROVIDER_READY', 'LLM_PROVIDER_UNHEALTHY']) },
];

const TAB_COLOR = {
  ALL: '#9ca3af',
  AUCTIONS: 'var(--accent-amber)',
  SUB: '#a855f7',
  DATA: '#14b8a6',
  SETTLE: 'var(--accent-gold)',
  AGENTS: 'var(--accent-green)',
};

const HEARTBEAT_TYPES = new Set(['PING', 'PONG']);

export function isHeartbeatEntry(entry) {
  return HEARTBEAT_TYPES.has(String(entry?.type || '').toUpperCase());
}

// ── Main TransactionExplorer ──────────────────────────────

export default function TransactionExplorer() {
  const [activeTab, setActiveTab] = useState('ALL');
  const [settleId, setSettleId] = useState(null);
  const [showHeartbeat, setShowHeartbeat] = useState(false);

  const auditLog = useStore((s) => s.auditLog);

  const filteredEntries = (() => {
    const tab = TABS.find((t) => t.key === activeTab);

    // 1. Filter
    let entries = auditLog;
    if (tab && tab.types) {
      entries = auditLog.filter((e) => tab.types.has(e.type));
    }
    if (!showHeartbeat) {
      entries = entries.filter((e) => !isHeartbeatEntry(e));
    }

    // 2. Sort (Newest first)
    // Create a shallow copy to sort safely
    const sorted = [...entries].sort((a, b) => {
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    // 3. Slice
    return sorted.slice(0, 200);
  })();

  // Tab counts
  const tabCounts = {};
  for (const tab of TABS) {
    if (!tab.types) continue;
    tabCounts[tab.key] = auditLog.filter((e) => tab.types.has(e.type)).length;
  }

  const onChainCount = auditLog.filter((e) => e._tx?.hash).length;
  const { containerRef } = useAutoScroll(filteredEntries.length);

  return (
    <>
      <div className="panel flex flex-col h-full">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-white/[0.04] flex-shrink-0 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color: 'var(--accent-cyan)' }}>⚡</span>
              <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-gray-400">
                Tx Explorer
              </h2>
              <span className="text-[10px] text-gray-600 font-mono">({auditLog.length})</span>
            </div>
          <div className="flex items-center gap-3">
            {onChainCount > 0 && (
              <span className="text-[9px] font-mono text-gray-600">
                {onChainCount} on-chain
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowHeartbeat((prev) => !prev)}
              className="text-[9px] font-mono text-gray-500 hover:text-gray-300 border border-white/[0.08] rounded px-1.5 py-0.5"
            >
              {showHeartbeat ? 'Hide heartbeat' : 'Show heartbeat'}
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="px-2 py-1 border-b border-white/[0.04] flex-shrink-0 overflow-x-auto scrollbar-hide">
          <div className="flex items-center gap-1 min-w-max">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.key;
              const color = TAB_COLOR[tab.key];
              const count = tab.types ? tabCounts[tab.key] : auditLog.length;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono whitespace-nowrap transition-all"
                  style={{
                    background: isActive ? `${color}18` : 'rgba(255,255,255,0.02)',
                    color: isActive ? color : '#6b7280',
                    border: isActive ? `1px solid ${color}35` : '1px solid transparent',
                  }}
                >
                  {tab.label}
                  {count > 0 && (
                    <span
                      className="text-[8px] px-1 rounded-full"
                      style={{ background: isActive ? `${color}25` : 'rgba(255,255,255,0.07)' }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Entry list */}
        <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0">
          {filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <motion.span
                animate={{ opacity: [0.3, 0.7, 0.3] }}
                transition={{ duration: 2.5, repeat: Infinity }}
                className="text-2xl text-gray-700"
              >
                ⛓
              </motion.span>
              <p className="text-[11px] text-gray-600 font-mono">No transactions recorded…</p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {filteredEntries.map((entry, i) => (
                <TransactionRow
                  key={`${entry.type}-${entry.timestamp || i}-${i}`}
                  entry={entry}
                  onSettleClick={(id) => setSettleId(id)}
                />
              ))}
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* Settlement detail modal */}
      {settleId && (
        <SettlementDetail
          settlementId={settleId}
          onClose={() => setSettleId(null)}
        />
      )}
    </>
  );
}
