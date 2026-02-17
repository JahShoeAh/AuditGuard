import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import useStore from '../store';

// ── Event type colors ──────────────────────────────────────

const TYPE_COLORS = {
  CONTRACT_DISCOVERY: 'var(--accent-cyan)',
  JOB_CREATED: 'var(--accent-cyan)',
  JobPosted: 'var(--accent-cyan)',
  BID_SUBMITTED: 'var(--accent-amber)',
  BidSubmitted: 'var(--accent-amber)',
  WINNERS_SELECTED: 'var(--accent-green)',
  WinnersSelected: 'var(--accent-green)',
  PAYMENT_SETTLED: 'var(--accent-gold)',
  AGENT_SLASHED: 'var(--accent-red)',
  AgentRegistered: 'var(--accent-purple)',
  ReputationUpdated: 'var(--accent-purple)',
  AgentPromoted: 'var(--accent-green)',
  BidRefunded: 'var(--accent-amber)',
  SUB_AUCTION: 'var(--text-secondary)',
  DATA_LISTING: 'var(--text-secondary)',
  MONITORING_OFFER: 'var(--text-secondary)',
  // Day 2
  SUB_AUCTION_CREATED: 'var(--accent-purple)',
  SUB_BID: '#b39ddb',
  SUB_SELECTED: 'var(--accent-purple)',
  RESULT_DELIVERED: '#9575cd',
  RESULT_ACCEPTED: 'var(--accent-green)',
  DATA_LISTED: '#14b8a6',
  DATA_PURCHASED: 'var(--accent-gold)',
  DATA_RATED: '#4db6ac',
  JOB_SETTLED: 'var(--accent-gold)',
  SUB_JOB_SETTLED: 'var(--accent-gold)',
};

// ── Format a log entry into a single description line ──────

function describeEntry(entry) {
  const t = entry.type;

  if (t === 'CONTRACT_DISCOVERY') {
    const addr = entry.contractAddress
      ? `${entry.contractAddress.slice(0, 8)}...`
      : '???';
    return `Discovered ${addr} — risk ${entry.initialRiskScore ?? '?'}/100`;
  }
  if (t === 'JobPosted' || t === 'JOB_CREATED') {
    return `Job #${entry.jobId} posted for ${entry.contractAddress || entry.budgetFormatted || '?'}${entry.budgetFormatted ? `  ${entry.budgetFormatted} budget` : ''}`;
  }
  if (t === 'BidSubmitted' || t === 'BID_SUBMITTED') {
    return `${entry.agentName || '?'} bid on Job #${entry.jobId}  ${entry.bidFormatted || ''}`;
  }
  if (t === 'WinnersSelected' || t === 'WINNERS_SELECTED') {
    return `Job #${entry.jobId} winners selected (${entry.winnerCount || '?'} agents)`;
  }
  if (t === 'PAYMENT_SETTLED') {
    return `Payment settled for Job #${entry.jobId || '?'}`;
  }
  if (t === 'AGENT_SLASHED') {
    return `Agent slashed: ${entry.agentName || entry.address || '?'}`;
  }
  if (t === 'AgentRegistered') {
    return `Agent registered: ${entry.agentId || '?'}`;
  }
  if (t === 'ReputationUpdated') {
    const delta = entry.delta > 0 ? `+${entry.delta}` : entry.delta;
    return `${entry.agentName || '?'} rep ${delta} → ${entry.newReputation}`;
  }
  if (t === 'AgentPromoted') {
    return `${entry.agentName || '?'} promoted Tier ${entry.fromTier} → ${entry.toTier}`;
  }
  if (t === 'BidRefunded') {
    return `Bid refunded: ${entry.agentName || '?'} on Job #${entry.jobId} — ${entry.refunded || ''}`;
  }
  if (t === 'SUB_AUCTION' || t === 'DATA_LISTING' || t === 'MONITORING_OFFER') {
    return `${entry.fromAgentName || '?'}: ${entry.data?.description || t.toLowerCase().replace('_', ' ')}`;
  }
  // Day 2 event types
  if (t === 'SUB_AUCTION_CREATED') {
    return `${entry.requesterName || '?'} needs ${entry.requiredSpecialization || 'analysis'}  ${entry.paymentFormatted || ''}`;
  }
  if (t === 'SUB_BID') {
    return `${entry.agentName || '?'} → Sub #${entry.subJobId}  ${entry.bidFormatted || ''}`;
  }
  if (t === 'SUB_SELECTED') {
    return `${entry.agentName || '?'} wins Sub #${entry.subJobId}  ${entry.agreedPriceFormatted || ''}`;
  }
  if (t === 'RESULT_DELIVERED') {
    return `Sub #${entry.subJobId} result delivered by ${entry.agentName || '?'}`;
  }
  if (t === 'RESULT_ACCEPTED') {
    return `Sub #${entry.subJobId} accepted  ${entry.paymentFormatted || ''}`;
  }
  if (t === 'DATA_LISTED') {
    return `${entry.sellerName || '?'} listed "${entry.title || '?'}"  ${entry.priceFormatted || ''}`;
  }
  if (t === 'DATA_PURCHASED') {
    return `${entry.buyerName || '?'} bought from ${entry.sellerName || '?'}  ${entry.pricePaidFormatted || ''}`;
  }
  if (t === 'DATA_RATED') {
    const stars = '★'.repeat(entry.rating || 0) + '☆'.repeat(5 - (entry.rating || 0));
    return `${entry.buyerName || '?'} rated listing #${entry.listingId}  ${stars}`;
  }
  if (t === 'JOB_SETTLED') {
    return `Job #${entry.jobId} settled — ${entry.recipientCount || '?'} recipients  ${entry.totalDisbursedFormatted || ''}`;
  }
  if (t === 'SUB_JOB_SETTLED') {
    return `Sub #${entry.subJobId} settled → ${entry.agentName || '?'}  ${entry.amountFormatted || ''}`;
  }
  return entry.type || 'Unknown event';
}

// ── Single log line ────────────────────────────────────────

function LogLine({ entry }) {
  const typeColor = TYPE_COLORS[entry.type] || 'var(--text-secondary)';
  const typeTag = entry.type
    ? entry.type.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '')
    : 'EVENT';

  let ts = '--:--:--';
  if (entry.timestamp) {
    try {
      ts = format(new Date(entry.timestamp), 'HH:mm:ss');
    } catch { /* keep default */ }
  } else if (entry._hcsTimestamp) {
    try {
      const secs = parseFloat(entry._hcsTimestamp);
      ts = format(new Date(secs * 1000), 'HH:mm:ss');
    } catch { /* keep default */ }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-3 py-0.5 text-[11px] leading-relaxed font-mono hover:bg-white/[0.02] px-2 rounded"
    >
      <span className="text-gray-600 flex-shrink-0 w-[60px]">{ts}</span>
      <span
        className="flex-shrink-0 w-[140px] truncate font-semibold"
        style={{ color: typeColor }}
      >
        [{typeTag}]
      </span>
      <span className="text-gray-400 flex-1 truncate">
        {describeEntry(entry)}
      </span>
    </motion.div>
  );
}

// ── Main Activity Log ──────────────────────────────────────

export default function ActivityLog() {
  const auditLog = useStore((s) => s.auditLog);
  const scrollRef = useRef(null);

  // Auto-scroll to top when new entries arrive (newest first)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [auditLog.length]);

  const visible = auditLog.slice(0, 50);

  return (
    <div className="panel flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.04] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Terminal icon */}
          <span className="text-guard-green text-[10px] font-mono">&gt;_</span>
          <h2 className="text-xs font-semibold tracking-wider uppercase font-sans text-gray-400">
            Network Activity
          </h2>
          <span className="text-[10px] text-gray-600 font-mono">
            ({auditLog.length})
          </span>
        </div>
        {auditLog.length > 0 && (
          <span className="text-[9px] text-gray-600 font-mono terminal-cursor">
            live
          </span>
        )}
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 min-h-0">
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-gray-600 font-mono">
              Awaiting network events...
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((entry, i) => (
              <LogLine
                key={`${entry.type}-${entry.timestamp || entry._hcsTimestamp || i}-${i}`}
                entry={entry}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
