import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../store';
import Countdown from './Countdown';
import { parseGuardAmount } from '../services/event-listener';

// ── Status step definitions ────────────────────────────────

const STEPS = ['OPEN', 'IN_PROGRESS', 'DELIVERED', 'ACCEPTED'];
const STEP_LABELS = ['OPEN', 'SEL', 'DLVR', 'ACPT'];

const SPEC_COLORS = {
  dependency_analysis: '#9c27b0',
  static_analysis: '#7e57c2',
  fuzzing: '#f59e0b',
  exploit_analysis: '#ef4444',
  llm_review: '#6366f1',
  threat_intel: '#ef4444',
};

// ── Status step indicator ─────────────────────────────────

function StatusSteps({ status }) {
  const isTerminal = status === 'DISPUTED' || status === 'EXPIRED';
  const currentIdx = isTerminal ? -1 : STEPS.indexOf(status);

  return (
    <div className="flex items-center gap-1 mt-2">
      {STEPS.map((step, i) => {
        const done = !isTerminal && currentIdx >= i;
        const active = !isTerminal && currentIdx === i;
        return (
          <div key={step} className="flex items-center">
            <motion.div
              animate={active ? { scale: [1, 1.25, 1] } : {}}
              transition={{ duration: 0.6, repeat: active ? Infinity : 0, repeatDelay: 2 }}
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                backgroundColor: isTerminal
                  ? 'var(--accent-red)'
                  : done
                  ? 'var(--accent-green)'
                  : active
                  ? 'var(--accent-purple)'
                  : '#374151',
              }}
            />
            {i < STEPS.length - 1 && (
              <div
                className="w-4 h-px mx-0.5"
                style={{ backgroundColor: done && !isTerminal ? 'var(--accent-green)' : '#374151' }}
              />
            )}
          </div>
        );
      })}
      <span
        className="ml-2 text-[9px] font-mono"
        style={{
          color: isTerminal
            ? 'var(--accent-red)'
            : status === 'ACCEPTED'
            ? 'var(--accent-green)'
            : '#6b7280',
        }}
      >
        {isTerminal ? status : (STEP_LABELS[Math.max(0, currentIdx)] || 'OPEN')}
      </span>
    </div>
  );
}

// ── Main SubAuctionCard ───────────────────────────────────

export default function SubAuctionCard({ subJobId }) {
  const subJob = useStore((s) => s.subJobs[subJobId]);
  const bids = useStore((s) => s.subBids[subJobId] || []);
  const [showFloater, setShowFloater] = useState(false);
  const prevStatus = useRef(null);

  // Trigger "+X GUARD" floater animation when result is accepted
  useEffect(() => {
    if (subJob?.status && prevStatus.current !== 'ACCEPTED' && subJob.status === 'ACCEPTED') {
      setShowFloater(true);
      const t = setTimeout(() => setShowFloater(false), 2000);
      return () => clearTimeout(t);
    }
    prevStatus.current = subJob?.status;
  }, [subJob?.status]);

  if (!subJob) return null;

  const specKey = (subJob.requiredSpecialization || '').toLowerCase();
  const specColor = SPEC_COLORS[specKey] || 'var(--accent-purple)';

  const isAccepted = subJob.status === 'ACCEPTED';
  const isTerminal = subJob.status === 'DISPUTED' || subJob.status === 'EXPIRED';
  const borderColor = isAccepted
    ? 'var(--accent-green)'
    : isTerminal
    ? 'var(--accent-red)'
    : 'var(--accent-purple)';

  return (
    <motion.div
      layout
      animate={isAccepted ? { boxShadow: '0 0 14px rgba(16,185,129,0.18)' } : { boxShadow: 'none' }}
      transition={{ duration: 0.4 }}
      className="relative rounded-md p-2.5 text-[11px]"
      style={{ borderLeft: `2px solid ${borderColor}`, background: 'rgba(255,255,255,0.02)' }}
    >
      {/* Payment floater */}
      <AnimatePresence>
        {showFloater && subJob.paymentFormatted && (
          <motion.div
            key="floater"
            initial={{ opacity: 1, y: 0 }}
            animate={{ opacity: 0, y: -28 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.6, ease: 'easeOut' }}
            className="absolute right-2 top-1 text-[11px] font-mono font-bold pointer-events-none"
            style={{ color: 'var(--accent-gold)' }}
          >
            +{subJob.paymentFormatted}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header: sub-job id + specialization badge + payment */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className="text-gray-500 font-mono text-[9px]">SUB #{subJobId}</span>
            <span
              className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
              style={{ backgroundColor: `${specColor}20`, color: specColor }}
            >
              {subJob.requiredSpecialization || 'GENERAL'}
            </span>
          </div>
          <p
            className="text-gray-300 font-mono leading-tight truncate"
            title={subJob.taskDescription}
          >
            {subJob.taskDescription || 'No description'}
          </p>
        </div>
        <span className="font-mono font-semibold flex-shrink-0" style={{ color: 'var(--accent-gold)' }}>
          {subJob.paymentFormatted}
        </span>
      </div>

      {/* Requester + SLA */}
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-1.5 flex-wrap">
        <span>
          From: <span className="text-gray-400">{subJob.requesterName || subJob.requester}</span>
        </span>
        {subJob.slaDeadline && !isAccepted && !isTerminal && (
          <span className="flex items-center gap-1">
            <span>⏱</span>
            <Countdown deadline={subJob.slaDeadline} />
          </span>
        )}
      </div>

      {/* Bids */}
      {bids.length > 0 && (
        <div className="space-y-0.5 mb-1.5">
          {bids.map((bid, i) => {
            const isWinner = subJob.selectedAgent?.toLowerCase() === bid.agent?.toLowerCase();
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  background: isWinner ? 'rgba(16,185,129,0.06)' : 'transparent',
                  border: isWinner ? '1px solid rgba(16,185,129,0.2)' : '1px solid transparent',
                }}
              >
                <span className="text-[8px]">▸</span>
                <span className="text-gray-400">{bid.agentName || bid.agent}</span>
                <span className="font-mono" style={{ color: 'var(--accent-gold)' }}>
                  {bid.proposedPriceFormatted}
                </span>
                <span className="text-gray-600 font-mono text-[9px]">⚡{bid.estimatedTime}s</span>
                {isWinner && (
                  <span className="ml-auto text-[10px]" style={{ color: 'var(--accent-green)' }}>
                    ✓
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Status steps */}
      <StatusSteps status={subJob.status} />
    </motion.div>
  );
}
