import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';

// ── Payment type config ───────────────────────────────────

function paymentTypeConf(flow) {
  const desc = (flow.type || '').toUpperCase();
  if (desc.includes('SPEED') || desc.includes('BONUS')) return { label: 'BONUS',    color: 'var(--accent-green)' };
  if (desc.includes('PLATFORM') || desc.includes('FEE')) return { label: 'FEE',      color: '#6b7280' };
  if (desc.includes('REPORT'))                           return { label: 'REPORT',   color: '#a855f7' };
  if (desc.includes('SUB'))                              return { label: 'SUB-CTR',  color: '#7c3aed' };
  return { label: 'AUDIT', color: 'var(--accent-gold)' };
}

// ── Overlay backdrop ──────────────────────────────────────

function Overlay({ onClick }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 z-40"
      onClick={onClick}
    />
  );
}

// ── Main SettlementDetail ─────────────────────────────────

export default function SettlementDetail({ settlementId, onClose }) {
  const settlements  = useStore((s) => s.settlements);
  const guardFlows   = useStore((s) => s.guardFlows);
  const config       = useStore((s) => s.config);

  const settlement = settlements?.[settlementId];
  const flows = guardFlows.filter(
    (f) => f.jobId === settlement?.jobId
      && (f.type === 'SETTLEMENT' || f.type?.includes('MAIN') || f.type?.includes('BONUS')
         || f.type?.includes('PLATFORM') || f.type?.includes('REPORT')
         || f.from === 'vault' || f.from?.toLowerCase() === config?.budgetVault?.toLowerCase())
  );

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <AnimatePresence>
      {settlementId && (
        <>
          <Overlay onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 16 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed inset-x-0 mx-auto top-[10vh] z-50 max-w-lg w-full px-4"
            style={{ pointerEvents: 'auto' }}
          >
            <div className="panel p-0 overflow-hidden">
              {/* Header */}
              <div
                className="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between"
                style={{ borderLeftWidth: '3px', borderLeftColor: 'var(--accent-gold)' }}
              >
                <div>
                  <h3 className="text-sm font-bold font-mono" style={{ color: 'var(--accent-gold)' }}>
                    Settlement #{settlementId}
                  </h3>
                  {settlement?.jobId && (
                    <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                      Job #{settlement.jobId}
                    </p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
                >
                  ×
                </button>
              </div>

              {/* Summary row */}
              {settlement && (
                <div className="px-5 py-2.5 border-b border-white/[0.04] flex items-center gap-6 text-[11px] font-mono">
                  <div>
                    <span className="text-gray-600">Disbursed</span>
                    <span className="text-guard-amber ml-2">{settlement.totalDisbursedFormatted}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Recipients</span>
                    <span className="text-gray-300 ml-2">{settlement.recipientCount}</span>
                  </div>
                </div>
              )}

              {/* Payment rows */}
              <div className="max-h-[50vh] overflow-y-auto">
                {flows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-2">
                    <span className="text-2xl text-gray-700">◈</span>
                    <p className="text-[11px] text-gray-600 font-mono">
                      {settlement ? 'Flow data loading…' : 'Settlement not found'}
                    </p>
                  </div>
                ) : (
                  flows.map((flow, i) => {
                    const conf = paymentTypeConf(flow);
                    return (
                      <div
                        key={i}
                        className="px-5 py-2.5 border-b border-white/[0.03] flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span
                            className="text-[8px] font-bold font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                            style={{ color: conf.color, backgroundColor: `${conf.color}18` }}
                          >
                            {conf.label}
                          </span>
                          <span className="text-[10px] font-mono text-gray-400 truncate">
                            {flow.toName || flow.to?.slice(0, 12) || '?'}
                          </span>
                        </div>
                        <span
                          className="text-[11px] font-mono font-semibold flex-shrink-0"
                          style={{ color: conf.color }}
                        >
                          {flow.amountFormatted}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
