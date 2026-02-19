import { useState } from 'react';
import { motion } from 'framer-motion';
import { formatDistanceToNowStrict } from 'date-fns';
import { hashscan } from '../utils/hashscan';

// ── Type badge config ─────────────────────────────────────

const TYPE_CONFIG = {
  // Auction
  JobPosted:          { color: 'var(--accent-amber)',  label: 'JOB'    },
  BidSubmitted:       { color: 'var(--accent-cyan)',   label: 'BID'    },
  BID_SKIPPED:        { color: '#f59e0b',              label: 'SKIP'   },
  BID_SUBMISSION_FAILED: { color: '#ef4444',           label: 'BFAIL'  },
  AUCTION_INVITE_SUMMARY: { color: 'var(--accent-cyan)', label: 'INV'  },
  LLM_INFERENCE_STARTED: { color: 'var(--accent-cyan)', label: 'LSTM'  },
  LLM_INFERENCE_SUCCEEDED: { color: 'var(--accent-green)', label: 'LOK'  },
  LLM_INFERENCE_FAILED: { color: '#ef4444', label: 'LFAIL'  },
  WinnersSelected:    { color: 'var(--accent-green)',  label: 'WIN'    },
  BidRefunded:        { color: '#f59e0b',              label: 'REFUND' },
  // Sub-contract
  SUB_AUCTION_CREATED:{ color: '#a855f7',              label: 'SUB+'   },
  SUB_BID:            { color: '#c084fc',              label: 'SBID'   },
  SUB_SELECTED:       { color: '#8b5cf6',              label: 'SWIN'   },
  RESULT_DELIVERED:   { color: '#7c3aed',              label: 'DELIV'  },
  RESULT_ACCEPTED:    { color: '#6d28d9',              label: 'ACCEPT' },
  SUB_JOB_SETTLED:    { color: '#7c3aed',              label: 'SSETL'  },
  // Data marketplace
  DATA_LISTED:        { color: '#14b8a6',              label: 'LIST'   },
  DATA_PURCHASED:     { color: '#0d9488',              label: 'BUY'    },
  DATA_RATED:         { color: '#0f766e',              label: 'RATE'   },
  // Settlement
  JOB_SETTLED:        { color: 'var(--accent-gold)',   label: 'SETTL'  },
  // Agents
  AgentRegistered:    { color: 'var(--accent-green)',  label: 'REG'    },
  ReputationUpdated:  { color: '#22c55e',              label: 'REP'    },
  AgentPromoted:      { color: '#16a34a',              label: 'PROMO'  },
  LLM_PROVIDER_READY: { color: '#22c55e',              label: 'LREADY' },
  LLM_PROVIDER_UNHEALTHY: { color: '#ef4444',          label: 'LUNHL'  },
};

const DEFAULT_CFG = { color: '#6b7280', label: '---' };

// ── Entry description ─────────────────────────────────────

function describe(e) {
  switch (e.type) {
    case 'JobPosted':
      return `Job #${e.jobId} posted — ${e.contractAddress?.slice(0,10) || '?'} — ${e.budgetFormatted || '?'}`;
    case 'BidSubmitted':
      return `${e.agentName || '?'} bid ${e.bidFormatted || '?'} on Job #${e.jobId}`;
    case 'BID_SKIPPED':
      return `${e.agentId || '?'} skipped bid on Job #${e.jobId}: ${e.reason || 'n/a'}`;
    case 'BID_SUBMISSION_FAILED':
      return `${e.agentId || '?'} bid failed on Job #${e.jobId}: ${e.reason || 'n/a'}`;
    case 'AUCTION_INVITE_SUMMARY':
      return `Job #${e.jobId}: ${e.eligibleAgents?.length || 0} invite-eligible agents`;
    case 'LLM_PROVIDER_READY':
      return `LLM provider ready: ${e.providerAddress || '?'} (${e.model || '?'})`;
    case 'LLM_PROVIDER_UNHEALTHY':
      return `LLM provider unhealthy: ${e.reasonCode || '?'} ${e.reason || ''}`;
    case 'LLM_INFERENCE_STARTED':
      return `LLM started Job #${e.jobId} (${e.model || '?'})`;
    case 'LLM_INFERENCE_SUCCEEDED':
      return `LLM succeeded Job #${e.jobId} (${e.findingsCount || 0} findings)`;
    case 'LLM_INFERENCE_FAILED':
      return `LLM failed Job #${e.jobId}: ${e.reasonCode || '?'} ${e.reason || ''}`;
    case 'WinnersSelected':
      return `Winners selected for Job #${e.jobId}`;
    case 'BidRefunded':
      return `Collateral refunded to ${e.agentName || '?'} — ${e.refunded || '?'}`;
    case 'AgentRegistered':
      return `Agent ${e.agentId || e.address?.slice(0,10) || '?'} registered`;
    case 'ReputationUpdated':
      return `${e.agentName || '?'} rep Δ${e.delta ?? '?'} → ${e.newReputation ?? '?'}`;
    case 'AgentPromoted':
      return `${e.agentName || '?'} promoted tier ${e.fromTier ?? '?'}→${e.toTier ?? '?'}`;
    case 'SUB_AUCTION_CREATED':
      return `Sub #${e.subJobId} created for Job #${e.parentJobId} — ${e.requiredSpecialization || '?'}`;
    case 'SUB_BID':
      return `${e.agentName || '?'} bid ${e.bidFormatted || '?'} on sub #${e.subJobId}`;
    case 'SUB_SELECTED':
      return `${e.agentName || '?'} selected for sub #${e.subJobId} @ ${e.agreedPriceFormatted || '?'}`;
    case 'RESULT_DELIVERED':
      return `${e.agentName || '?'} delivered result for sub #${e.subJobId}`;
    case 'RESULT_ACCEPTED':
      return `Sub #${e.subJobId} accepted — ${e.paymentFormatted || '?'}`;
    case 'DATA_LISTED':
      return `${e.sellerName || '?'} listed "${e.title || '?'}" — ${e.priceFormatted || '?'}`;
    case 'DATA_PURCHASED':
      return `${e.buyerName || '?'} bought from ${e.sellerName || '?'} — ${e.pricePaidFormatted || '?'}`;
    case 'DATA_RATED':
      return `${e.buyerName || '?'} rated listing #${e.listingId} ${'★'.repeat(e.rating || 0)}`;
    case 'JOB_SETTLED':
      return `Settlement #${e.settlementId} — Job #${e.jobId} — ${e.recipientCount || 0} recipients — ${e.totalDisbursedFormatted || '?'}`;
    case 'SUB_JOB_SETTLED':
      return `Sub #${e.subJobId} settled to ${e.agentName || '?'} — ${e.amountFormatted || '?'}`;
    default: {
      const src = e.source ? `[${e.source}] ` : '';
      return `${src}${e.type || 'EVENT'}: ${e.contractAddress || e.address || ''}`;
    }
  }
}

// ── TxLink ────────────────────────────────────────────────

function TxLink({ hash }) {
  if (!hash) return null;
  const short = `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  return (
    <a
      href={hashscan.transaction(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[9px] font-mono text-gray-600 hover:text-guard-cyan transition-colors flex-shrink-0 flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
      title={hash}
    >
      {short}↗
    </a>
  );
}

// ── Main TransactionRow ───────────────────────────────────

export default function TransactionRow({ entry, onSettleClick }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = TYPE_CONFIG[entry.type] || DEFAULT_CFG;

  const ts = entry.timestamp || entry._hcsTimestamp;
  let timeAgo = '';
  if (ts) {
    try {
      const d = typeof ts === 'string' ? new Date(ts) : new Date(ts);
      timeAgo = formatDistanceToNowStrict(d, { addSuffix: true });
    } catch { /* ignore */ }
  }

  const finalityS = entry._tx?.finalityMs
    ? `${(entry._tx.finalityMs / 1000).toFixed(1)}s`
    : null;

  const handleClick = () => {
    if (entry.type === 'JOB_SETTLED' && onSettleClick) {
      onSettleClick(entry.settlementId);
    } else {
      setExpanded((p) => !p);
    }
  };

  return (
    <motion.div
      layout
      className="px-3 py-1.5 border-b border-white/[0.025] hover:bg-white/[0.02] cursor-pointer transition-colors"
      onClick={handleClick}
    >
      {/* Main row */}
      <div className="flex items-center gap-2">
        {/* Time */}
        <span className="text-[9px] text-gray-600 font-mono flex-shrink-0 w-[64px] truncate">
          {timeAgo || '--'}
        </span>

        {/* Type badge */}
        <span
          className="text-[8px] font-bold font-mono px-1.5 py-0.5 rounded flex-shrink-0"
          style={{
            color: cfg.color,
            backgroundColor: `${cfg.color}18`,
            border: `1px solid ${cfg.color}35`,
          }}
        >
          {cfg.label}
        </span>

        {/* Description */}
        <span className="text-[10px] text-gray-400 font-mono flex-1 truncate">
          {describe(entry)}
        </span>

        {/* Finality */}
        {finalityS && (
          <span className="text-[9px] text-gray-600 font-mono flex-shrink-0">
            ⏱{finalityS}
          </span>
        )}

        {/* Tx link */}
        <TxLink hash={entry._tx?.hash} />

        {/* Settle expand hint */}
        {entry.type === 'JOB_SETTLED' && (
          <span className="text-[9px] text-gray-600 flex-shrink-0">↗</span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && entry.type !== 'JOB_SETTLED' && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-1 pl-[80px] text-[9px] font-mono text-gray-600 space-y-0.5"
        >
          {entry._tx?.blockNumber && (
            <div>block #{entry._tx.blockNumber}</div>
          )}
          {entry._tx?.hash && (
            <div className="text-gray-700 break-all">{entry._tx.hash}</div>
          )}
          {entry._hcsSequence != null && (
            <div>seq #{entry._hcsSequence} · topic {entry._hcsTopic}</div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
