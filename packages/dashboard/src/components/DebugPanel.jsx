import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';
import { fmt } from '../utils/format';

// ── Stat row ──────────────────────────────────────────────

function KV({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-[10px] text-gray-500 font-sans">{k}</span>
      <span className="text-[10px] font-mono text-gray-300">{v}</span>
    </div>
  );
}

// ── Section header ────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="mb-3">
      <div className="text-[9px] uppercase tracking-widest text-gray-600 mb-1.5 font-sans">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Main Debug Panel ──────────────────────────────────────

export default function DebugPanel() {
  const [visible, setVisible] = useState(false);

  // Ctrl+D toggle
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const stats         = useStore((s) => s.stats);
  const isConnected   = useStore((s) => s.isConnected);
  const connectionError = useStore((s) => s.connectionError);
  const useMockEvents = useStore((s) => s.useMockEvents);
  const toggleMock    = useStore((s) => s.toggleMockEvents);
  const auditLog      = useStore((s) => s.auditLog);
  const resetAll      = useStore((s) => s.resetAll);
  const config        = useStore((s) => s.config);
  const ingestionHealth = useStore((s) => s.ingestionHealth);

  const lastEntry   = auditLog[0];
  const lastEventTs = lastEntry
    ? fmt.timestamp(lastEntry.timestamp)
    : '--';
  const onChainCount = auditLog.filter((e) => e._tx?.hash).length;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: 20, y: -10 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.18 }}
          className="fixed top-14 right-3 z-50 w-64 rounded-lg overflow-hidden"
          style={{
            background:  'rgba(10,14,20,0.92)',
            border:      '1px solid rgba(255,255,255,0.1)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.07]">
            <span className="text-[10px] font-bold font-mono tracking-widest text-guard-cyan">
              DEBUG ⌨ Ctrl+D
            </span>
            <button
              onClick={() => setVisible(false)}
              className="text-gray-500 hover:text-gray-300 transition-colors text-base leading-none"
            >
              ×
            </button>
          </div>

          <div className="px-3 py-2.5 max-h-[80vh] overflow-y-auto">

            {/* Mock toggle */}
            <Section title="Event Source">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[10px] font-mono" style={{ color: useMockEvents ? '#f59e0b' : '#22c55e' }}>
                  {useMockEvents ? 'MOCK' : 'LIVE'}
                </span>
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={useMockEvents}
                    onChange={toggleMock}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4 bg-gray-700 rounded-full peer-checked:bg-guard-amber/40 transition-colors" />
                  <div className="absolute top-0.5 left-0.5 w-3 h-3 bg-gray-400 rounded-full peer-checked:translate-x-4 peer-checked:bg-guard-amber transition-all" />
                </div>
              </label>
            </Section>

            {/* Connection */}
            <Section title="Connection">
              <KV k="Status"   v={isConnected ? '🟢 Connected' : connectionError ? '🔴 Error' : '🟡 Connecting'} />
              {connectionError && (
                <div className="text-[9px] text-guard-red font-mono truncate mt-0.5">
                  {connectionError}
                </div>
              )}
              {config?.networkId && <KV k="Network" v={config.networkId} />}
            </Section>

            {/* Live stats */}
            <Section title="Stats">
              <KV k="Discoveries"   v={stats.totalDiscoveries} />
              <KV k="Auctions"      v={stats.totalAuctions} />
              <KV k="Bids"          v={stats.totalBids} />
              <KV k="Sub-auctions"  v={stats.totalSubAuctions} />
              <KV k="Data sales"    v={stats.totalDataSales} />
              <KV k="Settlements"   v={stats.totalSettlements} />
              <KV k="GUARD settled" v={`${stats.totalGuardTransacted?.toFixed(2) || '0.00'} G`} />
            </Section>

            {/* Audit log */}
            <Section title="Audit Log">
              <KV k="Total entries" v={auditLog.length} />
              <KV k="On-chain txs"  v={onChainCount} />
              <KV k="Last event"    v={lastEventTs} />
              {lastEntry?.type && <KV k="Last type" v={lastEntry.type} />}
            </Section>

            <Section title="Ingestion">
              <KV k="Source mode" v={ingestionHealth?.sourceMode || 'unknown'} />
              <KV k="Replay mode" v={ingestionHealth?.replayMode || 'unknown'} />
              <KV k="Agent hydration" v={ingestionHealth?.agentHydrationStatus || 'unknown'} />
              <KV
                k="Hydrated at"
                v={
                  ingestionHealth?.agentHydrationLastAt
                    ? fmt.timestamp(ingestionHealth.agentHydrationLastAt)
                    : '--'
                }
              />
              {ingestionHealth?.agentHydrationError && (
                <div className="text-[9px] text-guard-red font-mono break-words mt-0.5">
                  {ingestionHealth.agentHydrationError}
                </div>
              )}
              <KV k="HCS seq (disc)" v={ingestionHealth?.lastHcsSeq?.discovery ?? 0} />
              <KV k="HCS seq (audit)" v={ingestionHealth?.lastHcsSeq?.auditLog ?? 0} />
              <KV k="HCS seq (comms)" v={ingestionHealth?.lastHcsSeq?.agentComms ?? 0} />
              <KV k="Block cursor" v={ingestionHealth?.lastContractBlock ?? 0} />
              <KV k="Dropped dupes" v={ingestionHealth?.duplicatesDropped ?? 0} />
              <KV k="Decode fails" v={ingestionHealth?.decodeFailures ?? 0} />
              <KV k="Pending settles" v={ingestionHealth?.pendingSettlementBreakdowns ?? 0} />
            </Section>

            {/* Actions */}
            <Section title="Actions">
              <button
                onClick={resetAll}
                className="w-full text-[10px] font-mono font-semibold py-1.5 rounded transition-colors text-center"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border:     '1px solid rgba(239,68,68,0.25)',
                  color:      'var(--accent-red)',
                }}
              >
                ⚠ Clear All Data
              </button>
            </Section>

          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
