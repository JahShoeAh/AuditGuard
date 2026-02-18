import { motion, AnimatePresence } from 'framer-motion';
import { fmt } from '../utils/format';
import { hashscan } from '../utils/hashscan';

// ── Score bar color ────────────────────────────────────────
function scoreBarClass(score) {
  if (score >= 80) return 'bg-green-500';
  if (score >= 60) return 'bg-yellow-400';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreTextClass(score) {
  if (score >= 80) return 'text-green-400';
  if (score >= 60) return 'text-yellow-300';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

// ── Contract type badge ────────────────────────────────────
const TYPE_LABELS = {
  lending_protocol: 'LENDING',
  dex:              'DEX',
  staking_pool:     'STAKING',
  yield_aggregator: 'YIELD',
  UNKNOWN:          'UNKNOWN',
};

// ── ContractHealthCard ─────────────────────────────────────

export default function ContractHealthCard({ health, isSelected, onSelect }) {
  const {
    contractAddress,
    contractChain  = 'hedera',
    contractType   = 'UNKNOWN',
    securityScore  = 0,
    totalAudits    = 0,
    vaultBalance,
    monitoringActive = false,
    weeklyMonitoringRate,
    reauditDue     = false,
  } = health;

  const typeLabel = TYPE_LABELS[contractType] || contractType.toUpperCase().slice(0, 8);

  return (
    <motion.div
      layout
      className={[
        'cursor-pointer rounded border p-3 transition-all text-xs font-mono',
        isSelected ? 'border-cyan-400 bg-gray-800' : 'border-gray-700 bg-gray-900 hover:border-gray-500',
        reauditDue ? 'ring-1 ring-amber-500/40' : '',
      ].join(' ')}
      onClick={() => onSelect(contractAddress)}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-gray-100 text-[13px] uppercase truncate mr-2">
          {typeLabel} PROTOCOL
        </span>
        <span className="text-[10px] font-bold bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded uppercase">
          {contractType.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Address + chain */}
      <div className="text-gray-500 mb-2 flex gap-2">
        <a
          href={hashscan.contract(contractAddress)}
          target="_blank"
          rel="noreferrer"
          className="text-cyan-500 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {fmt.address(contractAddress)}
        </a>
        <span>│</span>
        <span>{contractChain}</span>
      </div>

      {/* Security score bar */}
      <div className="mb-2">
        <div className="flex justify-between mb-1">
          <span className="text-gray-500">Security Score</span>
          <span className={`font-bold ${scoreTextClass(securityScore)}`}>{securityScore}/100</span>
        </div>
        <div className="h-2 rounded bg-gray-700 overflow-hidden">
          <motion.div
            className={`h-full rounded ${scoreBarClass(securityScore)}`}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, securityScore)}%` }}
            transition={{ duration: 0.6 }}
          />
        </div>
      </div>

      {/* Vault balance + audits */}
      <div className="flex justify-between mb-1 text-gray-400">
        {vaultBalance ? (
          <span className="text-amber-400 font-semibold">{fmt.guard(vaultBalance)} GUARD</span>
        ) : (
          <span className="text-gray-600">No vault</span>
        )}
        <span>{totalAudits} audit{totalAudits !== 1 ? 's' : ''}</span>
      </div>

      {/* Monitoring status */}
      <div className="flex items-center gap-1 text-gray-500 mb-1">
        {monitoringActive ? (
          <>
            <span className="text-green-400">🛡</span>
            <span className="text-green-400">Monitoring: Active</span>
            {weeklyMonitoringRate && (
              <span className="text-gray-500">({fmt.guard(weeklyMonitoringRate)} G/wk)</span>
            )}
          </>
        ) : (
          <>
            <span className="text-gray-600">🛡</span>
            <span className="text-gray-600">Monitoring: Inactive</span>
          </>
        )}
      </div>

      {/* Re-audit status */}
      <AnimatePresence>
        {reauditDue ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-amber-400 animate-pulse font-bold text-[11px] mt-1"
          >
            ⏱ RE-AUDIT DUE
          </motion.div>
        ) : (
          totalAudits > 0 && (
            <div className="text-gray-600 mt-1">✓ On schedule</div>
          )
        )}
      </AnimatePresence>
    </motion.div>
  );
}
