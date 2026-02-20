import { useState, useEffect, useCallback } from 'react';
import { parseUnits, formatUnits } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore, { hbarEquivalent } from '../../store/wallet';
import { useHbarSwap } from '../../hooks/useHbarSwap';
import { useToast } from '../ui/Toast';
import { fmt } from '../../utils/format';

const MIN_AMOUNT   = 10;     // GUARD
const EXAMPLE_EARN = 50;     // GUARD, used for reward preview

// ── Helpers ────────────────────────────────────────────────

// GUARD uses 8 decimal places on Hedera (minDelegation = 10 * 10**8).
// All amounts passed to / returned from DelegatedStaking are in 8-decimal units.
const GUARD_DECIMALS = 8;

function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS)).toFixed(2); } catch { return '0.00'; }
}

function fmtShareRate(bps) {
  return `${(Number(bps ?? 0) / 100).toFixed(Number(bps ?? 0) % 100 === 0 ? 0 : 1)}%`;
}

function calcEstimatedReward(amountStr, poolTotalRaw, shareRateBps) {
  const amount    = parseFloat(amountStr) || 0;
  const poolTotal = parseFloat(fmtG(poolTotalRaw)) + amount; // include new stake
  if (!poolTotal || !shareRateBps) return null;
  return ((amount / poolTotal) * EXAMPLE_EARN * (Number(shareRateBps) / 10000)).toFixed(2);
}

const TIER_LABELS  = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];
const TIER_CLASSES = [
  'bg-gray-700 text-gray-300',
  'bg-cyan-900 text-cyan-300',
  'bg-amber-900 text-amber-300',
];

// ── Confetti ───────────────────────────────────────────────

const CONFETTI_CSS = `
@keyframes confettiFall {
  to { transform: translateY(100vh) rotate(720deg); opacity: 0; }
}`;

function Confetti() {
  const COLORS = ['#22d3ee', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#f97316'];
  const pieces = Array.from({ length: 36 }, (_, i) => i);
  return (
    <>
      <style>{CONFETTI_CSS}</style>
      <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
        {pieces.map((i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${(i * 2.8) % 100}%`,
              top: '-12px',
              width:  `${5 + (i % 4) * 2}px`,
              height: `${5 + (i % 4) * 2}px`,
              background: COLORS[i % COLORS.length],
              borderRadius: i % 3 === 0 ? '50%' : '2px',
              animation: `confettiFall ${0.9 + (i % 5) * 0.14}s ${(i % 10) * 45}ms ease-in forwards`,
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── Step indicator ─────────────────────────────────────────

function StepDots({ step }) {
  return (
    <div className="flex items-center gap-2">
      {[1, 2, 3].map((s) => (
        <div
          key={s}
          className={[
            'w-2 h-2 rounded-full transition-all',
            s === step   ? 'bg-cyan-400 scale-125' :
            s < step     ? 'bg-green-500' :
            'bg-gray-700',
          ].join(' ')}
        />
      ))}
    </div>
  );
}

// ── Step 1: Review Agent ───────────────────────────────────

function Step1Review({ agentProfile, pool, existingDelegation, onNext, onClose }) {
  const tier     = agentProfile?.tier ?? 0;
  const rep      = Number(agentProfile?.reputationScore ?? agentProfile?.reputation ?? 0) / 100;
  const name     = agentProfile?.name || agentProfile?.agentId || '—';

  const shareRate      = fmtShareRate(pool?.rewardShareBps);
  const totalDelegated = fmtG(pool?.totalDelegated);
  const delegatorCount = pool?.delegatorCount ?? 0;
  const accepting      = pool?.acceptingDelegations ?? true;
  const myExisting     = fmtG(existingDelegation?.amount);
  const slashCount     = agentProfile?.slashCount ?? 0;
  const fpRate         = agentProfile?.falsePositives ?? 0;

  return (
    <div className="space-y-4">
      {/* Agent profile summary */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-base font-bold text-gray-100 font-mono">{name}</div>
            <div className="text-xs text-gray-400 font-mono mt-0.5 break-all">
              {agentProfile?.address || '—'}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${TIER_CLASSES[tier] || TIER_CLASSES[0]}`}>
              {TIER_LABELS[tier] || 'COMMODITY'}
            </span>
            <span className="text-xs font-mono text-gray-300">{rep.toFixed(2)} rep</span>
          </div>
        </div>
        {agentProfile?.specialization && (
          <div className="text-xs text-gray-500 font-mono mt-2">
            Specialization: <span className="text-gray-300">{agentProfile.specialization}</span>
          </div>
        )}
      </div>

      {/* Reward share */}
      <div className="border border-green-500/30 rounded-lg p-3 bg-green-500/5">
        <div className="text-xs font-bold font-mono text-green-400 uppercase tracking-wider mb-1">
          Reward Share
        </div>
        <p className="text-sm font-mono text-gray-300">
          This agent shares <span className="text-green-400 font-bold">{shareRate}</span> of their
          earnings with delegators.
        </p>
      </div>

      {/* Risk factors */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="text-xs font-bold font-mono text-gray-500 uppercase tracking-wider mb-2">
          Risk Factors
        </div>
        <div className="grid grid-cols-2 gap-1 text-xs font-mono">
          <span className="text-gray-500">Slash count</span>
          <span className={`text-right font-semibold ${slashCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {slashCount > 0 ? `⚠ ${slashCount}` : '✓ 0'}
          </span>
          <span className="text-gray-500">False positives</span>
          <span className={`text-right font-semibold ${fpRate > 2 ? 'text-amber-400' : 'text-green-400'}`}>
            {fpRate}
          </span>
        </div>
        {slashCount > 0 && (
          <p className="text-[10px] font-mono text-amber-400 mt-2">
            ⚠ This agent has been slashed {slashCount} time{slashCount !== 1 ? 's' : ''}. Delegators share in slashing risk.
          </p>
        )}
      </div>

      {/* Pool stats */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="text-xs font-bold font-mono text-gray-500 uppercase tracking-wider mb-2">
          Delegation Pool
        </div>
        <div className="grid grid-cols-2 gap-1 text-xs font-mono">
          <span className="text-gray-500">Total delegated</span>
          <span className="text-right text-amber-300">{totalDelegated} GUARD</span>
          <span className="text-gray-500">Delegators</span>
          <span className="text-right text-gray-300">{delegatorCount}</span>
          <span className="text-gray-500">Your stake</span>
          <span className={`text-right font-semibold ${parseFloat(myExisting) > 0 ? 'text-cyan-300' : 'text-gray-600'}`}>
            {parseFloat(myExisting) > 0 ? `${myExisting} GUARD` : 'None yet'}
          </span>
          <span className="text-gray-500">Accepting</span>
          <span className={`text-right font-semibold ${accepting ? 'text-green-400' : 'text-red-400'}`}>
            {accepting ? '✓ Yes' : '✗ Closed'}
          </span>
        </div>
      </div>

      {!accepting && (
        <div className="border border-red-500/30 rounded-lg p-3 bg-red-500/5 text-xs font-mono text-red-300">
          ⚠ This agent is not currently accepting new delegations.
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onClose}
          className="flex-1 text-xs font-mono py-2 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onNext}
          disabled={!accepting}
          className="flex-1 text-xs font-bold font-mono py-2 rounded border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Set Amount →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Set Amount ─────────────────────────────────────

function Step2Amount({
  guardBalance,
  hbarPerGuard,
  hbarCostEstimate,
  amount,
  setAmount,
  pool,
  onBack,
  onNext,
}) {
  const presets = [10, 25, 50, 100];
  const balNum  = parseFloat(guardBalance) || 0;
  const amtNum  = parseFloat(amount) || 0;

  const isOverBalance  = amtNum > balNum;
  const isUnderMin     = amtNum > 0 && amtNum < MIN_AMOUNT;
  const isHighPortion  = amtNum > 0 && balNum > 0 && amtNum / balNum > 0.5;
  const canProceed     = amtNum >= MIN_AMOUNT && !isOverBalance;

  const estimatedReward = amount && canProceed
    ? calcEstimatedReward(amount, pool?.totalDelegated, pool?.rewardShareBps)
    : null;

  const handlePreset = (pct) => {
    const val = (balNum * pct / 100).toFixed(2);
    setAmount(val);
  };

  return (
    <div className="space-y-4">
      {/* Balance */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="flex items-center justify-between font-mono">
          <span className="text-xs text-gray-400">Your balance</span>
          <span className="text-sm font-bold text-amber-300">
            {parseFloat(guardBalance).toFixed(2)} GUARD ({hbarEquivalent(String(guardBalance), hbarPerGuard)} HBAR)
          </span>
        </div>
      </div>

      {/* Amount input */}
      <div>
        <label className="text-xs font-mono text-gray-400 uppercase tracking-wider block mb-1.5">
          Delegation Amount (GUARD)
        </label>
        <div className="flex gap-1">
          <input
            type="number"
            min={MIN_AMOUNT}
            max={balNum}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:border-cyan-500 transition-colors"
          />
          <button
            onClick={() => setAmount(balNum.toFixed(2))}
            className="px-3 py-2 text-[10px] font-bold font-mono uppercase tracking-wider rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
          >
            MAX
          </button>
        </div>
        {hbarCostEstimate && parseFloat(hbarCostEstimate) > 0 && (
          <p className="text-xs font-mono text-amber-400 mt-1">
            ≈ {hbarCostEstimate} HBAR required
          </p>
        )}

        {/* Preset percentage buttons */}
        <div className="flex gap-1.5 mt-2">
          {presets.map((pct) => (
            <button
              key={pct}
              onClick={() => handlePreset(pct)}
              className="flex-1 text-[10px] font-bold font-mono py-1.5 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Validation messages */}
      <AnimatePresence>
        {isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-red-400 border border-red-500/30 rounded p-2 bg-red-500/5">
            ✗ Amount exceeds your GUARD balance.
          </motion.p>
        )}
        {isUnderMin && !isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-amber-400 border border-amber-500/30 rounded p-2 bg-amber-500/5">
            ⚠ Minimum delegation is {MIN_AMOUNT} GUARD.
          </motion.p>
        )}
        {isHighPortion && !isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-amber-400 border border-amber-500/30 rounded p-2 bg-amber-500/5">
            ⚠ This is a significant portion of your GUARD balance.
          </motion.p>
        )}
      </AnimatePresence>

      {/* Reward preview */}
      {estimatedReward && (
        <div className="border border-green-500/20 rounded-lg p-3 bg-green-500/5 text-xs font-mono">
          <span className="text-gray-400">If this agent earns {EXAMPLE_EARN} GUARD on their next audit, your estimated reward: </span>
          <span className="text-green-400 font-bold">~{estimatedReward} GUARD</span>
          <span className="text-gray-600 block mt-1 text-[10px]">
            (based on {fmtShareRate(pool?.rewardShareBps)} share rate and current pool size)
          </span>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onBack}
          className="flex-1 text-xs font-mono py-2 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="flex-1 text-xs font-bold font-mono py-2 rounded border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Review & Confirm →
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Confirm & Execute ──────────────────────────────

const TX_STEP_LABELS = {
  quoting: 'Checking exchange rate...',
  swapping: '1/3 Swapping HBAR → GUARD...',
  approving: '2/3 Approving GUARD transfer...',
  executing: (agentName) => `3/3 Delegating to ${agentName}...`,
  done: '✓ Delegated successfully!',
  error: null,
};

function TxProgressRow({ label, done, active }) {
  return (
    <div className={[
      'flex items-center gap-2 text-xs font-mono py-1',
      done   ? 'text-green-400' :
      active ? 'text-cyan-300' :
      'text-gray-600',
    ].join(' ')}>
      {done   && <span className="w-4">✓</span>}
      {active && <span className="w-4 animate-spin inline-block">◌</span>}
      {!done && !active && <span className="w-4">○</span>}
      {label}
    </div>
  );
}

function Step3Confirm({
  agentName,
  amount,
  hbarCostEstimate,
  pool,
  agentProfile,
  swapStep,
  swapError,
  isSwapping,
  onBack,
  onExecute,
  onClose,
}) {
  const shareRate  = fmtShareRate(pool?.rewardShareBps);
  const isRunning  = isSwapping;
  const isDone     = swapStep === 'done';
  const hasError   = swapStep === 'error';
  const tier       = agentProfile?.tier ?? 0;
  const activeIdx = { quoting: 1, swapping: 2, approving: 3, executing: 4, done: 5, error: 0 }[swapStep] || 0;
  const txStepLabel =
    swapStep === 'executing'
      ? TX_STEP_LABELS.executing(agentName)
      : TX_STEP_LABELS[swapStep];

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900 space-y-2 text-xs font-mono">
        <div className="flex justify-between">
          <span className="text-gray-500">Agent</span>
          <span className="text-gray-100 font-semibold truncate max-w-[160px]">{agentName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Tier</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${TIER_CLASSES[tier] || TIER_CLASSES[0]}`}>
            {TIER_LABELS[tier] || 'COMMODITY'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Amount</span>
          <span className="text-amber-300 font-bold">{parseFloat(amount).toFixed(2)} GUARD</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Payment method</span>
          <span className="text-cyan-300 font-semibold">
            {hbarCostEstimate || '0'} HBAR (auto-converted to {parseFloat(amount || 0).toFixed(2)} GUARD)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Reward share</span>
          <span className="text-green-400 font-semibold">{shareRate}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Unbonding period</span>
          <span className="text-gray-300">~7 days</span>
        </div>
      </div>

      {/* Slashing notice */}
      <div className="border border-amber-500/30 rounded-lg p-3 bg-amber-500/5 text-xs font-mono text-amber-300">
        ⚠ This delegation is subject to slashing if the agent is penalized.
      </div>

      {/* Auto-swap transaction flow */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-2">
          Auto-swap flow
        </div>
        <TxProgressRow
          label="Checking exchange rate..."
          done={activeIdx > 1 || swapStep === 'done'}
          active={swapStep === 'quoting'}
        />
        <TxProgressRow
          label="1/3 Swapping HBAR → GUARD..."
          done={activeIdx > 2 || swapStep === 'done'}
          active={swapStep === 'swapping'}
        />
        <TxProgressRow
          label="2/3 Approving GUARD transfer..."
          done={activeIdx > 3 || swapStep === 'done'}
          active={swapStep === 'approving'}
        />
        <TxProgressRow
          label={`3/3 Delegating to ${agentName}...`}
          done={swapStep === 'done'}
          active={swapStep === 'executing'}
        />
      </div>

      {/* Tx phase label */}
      {txStepLabel && (
        <motion.p
          key={swapStep}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`text-xs font-mono text-center font-semibold ${swapStep === 'done' ? 'text-green-400' : 'text-cyan-300'}`}
        >
          {txStepLabel}
        </motion.p>
      )}

      {/* Error */}
      {hasError && swapError && (
        <div className="border border-red-500/30 rounded-lg p-3 bg-red-500/5 text-xs font-mono text-red-300">
          ✗ {swapError}
        </div>
      )}

      {/* Actions */}
      {!isDone ? (
        <div className="flex gap-2 pt-1">
          <button
            onClick={onBack}
            disabled={isRunning}
            className="flex-1 text-xs font-mono py-2 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-40 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={onExecute}
            disabled={isSwapping}
            className="flex-1 text-xs font-bold font-mono py-2 rounded border border-green-500/50 bg-green-500/15 text-green-300 hover:bg-green-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isSwapping ? '⏳ Processing…' : '⚡ Confirm Delegation'}
          </button>
        </div>
      ) : (
        <button
          onClick={onClose}
          className="w-full text-xs font-bold font-mono py-2 rounded border border-green-500/50 bg-green-500/20 text-green-300 hover:bg-green-500/30 transition-colors"
        >
          ✓ Done — View Portfolio
        </button>
      )}
    </div>
  );
}

// ── Main DelegationWizard ──────────────────────────────────

/**
 * DelegationWizard — right panel, 3-step delegation flow.
 *
 * Props:
 *   agentAddress   string | null   pre-selected agent EVM address
 *   onClose        () => void      close the panel
 *   onSuccess      () => void      called after successful delegation (refresh portfolio)
 */
export default function DelegationWizard({ agentAddress, onClose, onSuccess }) {
  const contracts   = useStore((s) => s.contracts);
  const agents      = useStore((s) => s.agents);
  const guardBalance = useWalletStore((s) => s.guardBalance);
  const hbarPerGuard = useWalletStore((s) => s.hbarPerGuard);
  const address      = useWalletStore((s) => s.address);
  const refreshBals  = useWalletStore((s) => s.refreshBalances);
  const openWallet   = useWalletStore((s) => s.openWalletModal);
  const connected    = useWalletStore((s) => s.connectionStatus === 'connected');
  const { quoteHbarCost, swapAndExecute, swapStep, isSwapping, swapError, reset } = useHbarSwap();
  const toast        = useToast();

  const [step,    setStep]    = useState(1);
  const [amount,  setAmount]  = useState('');
  const [pool,    setPool]    = useState(null);
  const [existingDelegation, setExistingDelegation] = useState(null);
  const [hbarCostEstimate, setHbarCostEstimate] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);

  const ds = contracts?.delegatedStakingContract;

  const agentProfile = agentAddress
    ? (agents[agentAddress] || agents[agentAddress?.toLowerCase()])
    : null;

  const agentName = agentProfile?.name || agentProfile?.agentId
    || (agentAddress ? fmt.address(agentAddress) : '—');

  // Fetch pool data for selected agent
  const fetchPoolData = useCallback(async () => {
    if (!ds || !agentAddress) return;
    try {
      const poolResult = await ds.getAgentPool(agentAddress);
      setPool({
        totalDelegated:       poolResult.totalDelegated,
        rewardShareBps:       poolResult.rewardShareBps,
        delegatorCount:       Number(poolResult.delegatorCount),
        acceptingDelegations: poolResult.acceptingDelegations,
      });
    } catch { /* not deployed yet */ }

    if (address) {
      try {
        const del = await ds.getDelegation(address, agentAddress);
        setExistingDelegation({ amount: del.amount, unbondingAmount: del.unbondingAmount });
      } catch { /* skip */ }
    }
  }, [ds, agentAddress, address]);

  useEffect(() => {
    setStep(1);
    setAmount('');
    setHbarCostEstimate('');
    reset();
    fetchPoolData();
  }, [agentAddress, fetchPoolData, reset]);

  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) {
      setHbarCostEstimate('');
      return;
    }
    const timer = setTimeout(async () => {
      const cost = await quoteHbarCost(amount);
      setHbarCostEstimate(cost);
    }, 400);
    return () => clearTimeout(timer);
  }, [amount, quoteHbarCost]);

  const handleExecute = async () => {
    if (!ds || !agentAddress || !amount) return;

    reset();
    try {
      await swapAndExecute(
        amount,
        ds,
        'delegate',
        [agentAddress, parseUnits(amount, GUARD_DECIMALS)]
      );
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2000);
      toast.success(`✓ Delegated ${parseFloat(amount).toFixed(2)} GUARD to ${agentName}`);
      await refreshBals();
      onSuccess?.();
    } catch (err) {
      const msg = err?.reason || err?.message?.slice(0, 100) || 'Transaction failed';
      toast.error(`✗ Delegation failed: ${msg}`);
    }
  };

  // Empty state (no agent selected)
  if (!agentAddress) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-4">🎯</div>
        <h3 className="text-sm font-bold font-mono text-gray-300 uppercase tracking-wider mb-2">
          Select an Agent
        </h3>
        <p className="text-xs font-mono text-gray-500">
          Choose an agent from the browser to start delegating GUARD.
        </p>
      </div>
    );
  }

  // Not connected state
  if (!connected) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-4">🔒</div>
        <h3 className="text-sm font-bold font-mono text-gray-300 uppercase tracking-wider mb-2">
          Wallet Required
        </h3>
        <p className="text-xs font-mono text-gray-500 mb-4">
          Connect your wallet to delegate GUARD to {agentName}.
        </p>
        <button
          onClick={() => openWallet({ action: 'delegate stake' })}
          className="text-xs font-bold font-mono uppercase tracking-wider px-4 py-2 rounded border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  const STEP_LABELS = ['Review Agent', 'Set Amount', 'Confirm & Execute'];

  return (
    <div className="h-full flex flex-col min-h-0">
      {showConfetti && <Confetti />}

      {/* Wizard header */}
      <div className="flex-shrink-0 border-b border-gray-800 px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-bold font-mono uppercase tracking-widest text-gray-100">
            Delegate to {agentName}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-600 hover:text-gray-400 text-lg leading-none"
            aria-label="Close wizard"
          >
            ×
          </button>
        </div>
        <div className="flex items-center gap-3">
          <StepDots step={step} />
          <span className="text-[10px] font-mono text-gray-500">
            Step {step}/3 — {STEP_LABELS[step - 1]}
          </span>
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4">
        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Step1Review
                agentProfile={{ ...agentProfile, address: agentAddress }}
                pool={pool}
                existingDelegation={existingDelegation}
                onNext={() => setStep(2)}
                onClose={onClose}
              />
            </motion.div>
          )}
          {step === 2 && (
            <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Step2Amount
                guardBalance={guardBalance ?? 0}
                hbarPerGuard={hbarPerGuard}
                hbarCostEstimate={hbarCostEstimate}
                amount={amount}
                setAmount={setAmount}
                pool={pool}
                onBack={() => setStep(1)}
                onNext={() => { reset(); setStep(3); }}
              />
            </motion.div>
          )}
          {step === 3 && (
            <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Step3Confirm
                agentName={agentName}
                amount={amount}
                hbarCostEstimate={hbarCostEstimate}
                pool={pool}
                agentProfile={{ ...agentProfile, tier: agentProfile?.tier ?? 0 }}
                swapStep={swapStep}
                swapError={swapError}
                isSwapping={isSwapping}
                onBack={() => setStep(2)}
                onExecute={handleExecute}
                onClose={() => { setStep(1); setAmount(''); setHbarCostEstimate(''); reset(); onClose?.(); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
