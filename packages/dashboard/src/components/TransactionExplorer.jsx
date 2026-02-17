import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import useStore from '../store';
import TransactionRow from './TransactionRow';
import SettlementDetail from './SettlementDetail';

// ── Filter tab config ─────────────────────────────────────

const TABS = [
  { key: 'ALL',      label: 'ALL',      types: null },
  { key: 'AUCTIONS', label: 'AUCTIONS', types: new Set(['JobPosted','BidSubmitted','WinnersSelected','BidRefunded']) },
  { key: 'SUB',      label: 'SUB-CTR',  types: new Set(['SUB_AUCTION_CREATED','SUB_BID','SUB_SELECTED','RESULT_DELIVERED','RESULT_ACCEPTED','SUB_JOB_SETTLED']) },
  { key: 'DATA',     label: 'DATA',     types: new Set(['DATA_LISTED','DATA_PURCHASED','DATA_RATED']) },
  { key: 'SETTLE',   label: 'SETTLE',   types: new Set(['JOB_SETTLED','SUB_JOB_SETTLED']) },
  { key: 'AGENTS',   label: 'AGENTS',   types: new Set(['AgentRegistered','ReputationUpdated','AgentPromoted']) },
];

const TAB_COLOR = {
  ALL:      '#9ca3af',
  AUCTIONS: 'var(--accent-amber)',
  SUB:      '#a855f7',
  DATA:     '#14b8a6',
  SETTLE:   'var(--accent-gold)',
  AGENTS:   'var(--accent-green)',
};

// ── Main TransactionExplorer ──────────────────────────────

export default function TransactionExplorer() {
  const [activeTab, setActiveTab]   = useState('ALL');
  const [settleId,  setSettleId]    = useState(null);

  const auditLog = useStore((s) => s.auditLog);

  const filteredEntries = (() => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (!tab || !tab.types) return auditLog.slice(0, 200);
    return auditLog.filter((e) => tab.types.has(e.type)).slice(0, 200);
  })();

  // Tab counts
  const tabCounts = {};
  for (const tab of TABS) {
    if (!tab.types) continue;
    tabCounts[tab.key] = auditLog.filter((e) => tab.types.has(e.type)).length;
  }

  const onChainCount = auditLog.filter((e) => e._tx?.hash).length;

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
          {onChainCount > 0 && (
            <span className="text-[9px] font-mono text-gray-600">
              {onChainCount} on-chain
            </span>
          )}
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
                    color:      isActive ? color : '#6b7280',
                    border:     isActive ? `1px solid ${color}35` : '1px solid transparent',
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
        <div className="flex-1 overflow-y-auto min-h-0">
          {filteredEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] text-gray-600 font-mono">No entries yet…</p>
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
