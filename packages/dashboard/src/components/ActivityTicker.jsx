import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store/index';
import { fmt } from '../utils/format';
import TransactionExplorer from './TransactionExplorer';

// ── Format an audit log entry into a ticker string ─────────
function formatEntry(entry) {
  if (!entry) return null;
  const time = fmt.timestamp(entry.timestamp || entry._hcsTimestamp);
  const type = entry.type || 'EVENT';
  let detail = '';

  switch (type) {
    case 'JOB_SETTLED':
      detail = `Job #${entry.jobId} — ${entry.totalDisbursedFormatted || ''}`;
      break;
    case 'JobPosted':
      detail = `Job #${entry.jobId} — ${entry.budgetFormatted || ''}`;
      break;
    case 'BidSubmitted':
      detail = `${entry.agentName || '?'} bid ${entry.bidFormatted || ''}`;
      break;
    case 'WinnersSelected':
      detail = `Job #${entry.jobId} — ${entry.winnerCount || 0} winners`;
      break;
    case 'DATA_PURCHASED':
      detail = `${entry.buyerName || '?'} bought from ${entry.sellerName || '?'} — ${entry.pricePaidFormatted || ''}`;
      break;
    case 'SUB_AUCTION_CREATED':
      detail = `Sub-job ${entry.subJobId} — ${entry.paymentFormatted || ''}`;
      break;
    case 'SLASH_INITIATED':
      detail = `${entry.agentName || '?'} slashed — ${entry.slashedAmountFormatted || ''}`;
      break;
    case 'REPUTATION_UPDATED':
      detail = `${entry.agentName || '?'} rep ${entry.delta}`;
      break;
    case 'AUDIT_RECORDED':
      detail = `Score ${entry.securityScore}/100`;
      break;
    case 'VAULT_CREATED':
      detail = `Vault for ${fmt.address(entry.contractAddress)}`;
      break;
    case 'AUTO_AUDIT_TRIGGERED':
      detail = `Re-audit triggered — ${entry.reason || ''}`;
      break;
    default:
      detail = entry.contractAddress
        ? fmt.address(entry.contractAddress)
        : entry.jobId
        ? `Job #${entry.jobId}`
        : '';
  }

  return `${time}  [${type}]${detail ? `  ${detail}` : ''}`;
}

// ── ActivityTicker ─────────────────────────────────────────

export default function ActivityTicker() {
  const auditLog = useStore((s) => s.auditLog);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const latestEntry = auditLog[0] || null;
  const latestKey = latestEntry?.timestamp || 'empty';

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawerOpen]);

  const tickerText = formatEntry(latestEntry) || 'AuditGuard — monitoring live events…';

  return (
    <>
      {/* ── Bottom ticker bar ── */}
      <div
        className="flex-shrink-0 h-9 bg-gray-900 border-t border-gray-800 flex items-center px-3 gap-2 cursor-pointer hover:bg-gray-800 transition-colors"
        onClick={() => setDrawerOpen(true)}
        title="Click to open Transaction Explorer"
      >
        {/* Pulse dot */}
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />

        {/* Animated ticker text */}
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.span
              key={latestKey}
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0,  opacity: 1 }}
              exit={{ x: -40, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="block text-xs font-mono text-gray-300 whitespace-nowrap"
            >
              {tickerText}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* Open hint */}
        <span className="text-[10px] text-gray-600 flex-shrink-0">▶ Explorer</span>
      </div>

      {/* ── Slide-out drawer ── */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />

            {/* Drawer panel */}
            <motion.div
              key="drawer"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed right-0 top-0 bottom-0 z-50 w-[400px] bg-gray-950 border-l border-gray-800 flex flex-col shadow-2xl"
            >
              {/* Drawer header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 flex-shrink-0">
                <h2 className="text-sm font-bold text-gray-100 font-mono uppercase tracking-widest">
                  Transaction Explorer
                </h2>
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="text-gray-500 hover:text-gray-200 text-lg leading-none"
                >
                  ✕
                </button>
              </div>

              {/* Drawer content */}
              <div className="flex-1 overflow-hidden">
                <TransactionExplorer />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
