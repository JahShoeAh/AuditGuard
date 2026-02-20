import { useState, useEffect, useCallback } from 'react';
import { ethers, formatUnits } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { useToast } from '../ui/Toast';
import { fmt } from '../../utils/format';

// Fixed rate: 1 HBAR = 100 GUARD
const RATE = 100;
const MIN_HBAR_AMOUNT = 0.1;   // 0.1 HBAR = 10 GUARD (contract minimum)
const EXAMPLE_EARN = 50;       // GUARD, for reward preview
const GUARD_DECIMALS = 8;

// ── Helpers ────────────────────────────────────────────────

function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS)).toFixed(2); } catch { return '0.00'; }
}

/** Format GUARD raw value as HBAR (divide by 100) */
function fmtHbar(raw) {
  if (raw == null) return '0.00';
  try {
    const guard = parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS));
    return (guard / RATE).toFixed(4);
  } catch { return '0.00'; }
}

function fmtShareRate(bps) {
  return `${(Number(bps ?? 0) / 100).toFixed(Number(bps ?? 0) % 100 === 0 ? 0 : 1)}%`;
}

function calcEstimatedReward(hbarStr, poolTotalRaw, shareRateBps) {
  const hbar    = parseFloat(hbarStr) || 0;
  const guardAmt = hbar * RATE;
  const poolTotal = parseFloat(fmtG(poolTotalRaw)) + guardAmt;
  if (!poolTotal || !shareRateBps) return null;
  const rewardGuard = ((guardAmt / poolTotal) * EXAMPLE_EARN * (Number(shareRateBps) / 10000));
  return (rewardGuard / RATE).toFixed(4); // return as HBAR
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

  const shareRate      = pool && pool.totalDelegated > 0n
    ? fmtShareRate(pool.rewardShareBps)
    : '10%';
  const totalDelegatedHbar = fmtHbar(pool?.totalDelegated);
  const delegatorCount = pool?.delegatorCount ?? 0;
  const myExistingHbar = fmtHbar(existingDelegation?.amount);
  const slashCount     = agentProfile?.slashCount ?? 0;
  const fpRate         = agentProfile?.falsePositives ?? 0;

  return (
    <div className="space-y-4">
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

      <div className="border border-green-500/30 rounded-lg p-3 bg-green-500/5">
        <div className="text-xs font-bold font-mono text-green-400 uppercase tracking-wider mb-1">
          Reward Share
        </div>
        <p className="text-sm font-mono text-gray-300">
          This agent shares <span className="text-green-400 font-bold">{shareRate}</span> of their
          earnings with delegators.
        </p>
      </div>

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

      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="text-xs font-bold font-mono text-gray-500 uppercase tracking-wider mb-2">
          Delegation Pool
        </div>
        <div className="grid grid-cols-2 gap-1 text-xs font-mono">
          <span className="text-gray-500">Total delegated</span>
          <span className="text-right text-amber-300">{totalDelegatedHbar} HBAR</span>
          <span className="text-gray-500">Delegators</span>
          <span className="text-right text-gray-300">{delegatorCount}</span>
          <span className="text-gray-500">Your stake</span>
          <span className={`text-right font-semibold ${parseFloat(myExistingHbar) > 0 ? 'text-cyan-300' : 'text-gray-600'}`}>
            {parseFloat(myExistingHbar) > 0 ? `${myExistingHbar} HBAR` : 'None yet'}
          </span>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={onClose}
          className="flex-1 text-xs font-mono py-2 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onNext}
          className="flex-1 text-xs font-bold font-mono py-2 rounded border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 transition-colors"
        >
          Set Amount →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Set Amount (HBAR only) ────────────────────────

function Step2Amount({
  hbarBalance,
  amount,
  setAmount,
  pool,
  onBack,
  onNext,
}) {
  const presets = [0.5, 1, 5, 10];
  const hbarBalNum = parseFloat(hbarBalance) || 0;
  const amtNum = parseFloat(amount) || 0;

  const isOverBalance = amtNum > hbarBalNum;
  const isUnderMin = amtNum > 0 && amtNum < MIN_HBAR_AMOUNT;
  const isHighPortion = amtNum > 0 && hbarBalNum > 0 && amtNum / hbarBalNum > 0.5;
  const canProceed = amtNum >= MIN_HBAR_AMOUNT && !isOverBalance;

  const guardBacking = amtNum > 0 ? (amtNum * RATE).toFixed(2) : null;
  const estimatedReward = canProceed
    ? calcEstimatedReward(amount, pool?.totalDelegated, pool?.rewardShareBps)
    : null;

  return (
    <div className="space-y-4">
      {/* Balance */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="flex items-center justify-between font-mono">
          <span className="text-xs text-gray-400">Your HBAR balance</span>
          <span className="text-sm font-bold text-amber-300">
            {hbarBalNum.toFixed(2)} HBAR
          </span>
        </div>
      </div>

      {/* Amount input */}
      <div>
        <label className="text-xs font-mono text-gray-400 uppercase tracking-wider block mb-1.5">
          HBAR Amount to Delegate
        </label>
        <div className="flex gap-1">
          <input
            type="number"
            min={MIN_HBAR_AMOUNT}
            max={hbarBalNum}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:border-cyan-500 transition-colors"
          />
          <button
            onClick={() => setAmount(hbarBalNum.toFixed(2))}
            className="px-3 py-2 text-[10px] font-bold font-mono uppercase tracking-wider rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
          >
            MAX
          </button>
        </div>
        {guardBacking && (
          <p className="text-xs font-mono text-green-400 mt-1">
            = {guardBacking} GUARD backing (internal)
          </p>
        )}

        {/* Preset buttons */}
        <div className="flex gap-1.5 mt-2">
          {presets.map((amt) => (
            <button
              key={amt}
              onClick={() => setAmount(amt.toFixed(2))}
              className="flex-1 text-[10px] font-bold font-mono py-1.5 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
            >
              {amt} HBAR
            </button>
          ))}
        </div>
      </div>

      {/* Validation messages */}
      <AnimatePresence>
        {isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-red-400 border border-red-500/30 rounded p-2 bg-red-500/5">
            ✗ Amount exceeds your HBAR balance.
          </motion.p>
        )}
        {isUnderMin && !isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-amber-400 border border-amber-500/30 rounded p-2 bg-amber-500/5">
            ⚠ Minimum delegation is {MIN_HBAR_AMOUNT} HBAR.
          </motion.p>
        )}
        {isHighPortion && !isOverBalance && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="text-xs font-mono text-amber-400 border border-amber-500/30 rounded p-2 bg-amber-500/5">
            ⚠ This is a significant portion of your HBAR balance.
          </motion.p>
        )}
      </AnimatePresence>

      {/* Reward preview */}
      {estimatedReward && (
        <div className="border border-green-500/20 rounded-lg p-3 bg-green-500/5 text-xs font-mono">
          <span className="text-gray-400">If this agent earns {EXAMPLE_EARN} GUARD on their next audit, your estimated reward: </span>
          <span className="text-green-400 font-bold">~{estimatedReward} HBAR</span>
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

function Step3Confirm({
  agentName,
  amount,
  pool,
  agentProfile,
  txStep,
  txError,
  isProcessing,
  onBack,
  onExecute,
  onClose,
}) {
  const shareRate  = pool && pool.totalDelegated > 0n
    ? fmtShareRate(pool.rewardShareBps)
    : '10%';
  const isDone     = txStep === 'done';
  const hasError   = txStep === 'error';
  const tier       = agentProfile?.tier ?? 0;
  const guardAmount = (parseFloat(amount) * RATE).toFixed(2);

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
          <span className="text-gray-500">HBAR Amount</span>
          <span className="text-amber-300 font-bold">{parseFloat(amount).toFixed(2)} HBAR</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">GUARD Backing</span>
          <span className="text-green-400 font-semibold text-[10px]">
            = {guardAmount} GUARD (internal)
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

      {/* Single transaction progress */}
      <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
        <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-2">
          Transaction
        </div>
        <div className={[
          'flex items-center gap-2 text-xs font-mono py-1',
          isDone   ? 'text-green-400' :
          isProcessing ? 'text-cyan-300' :
          'text-gray-600',
        ].join(' ')}>
          {isDone   && <span className="w-4">✓</span>}
          {isProcessing && <span className="w-4 animate-spin inline-block">◌</span>}
          {!isDone && !isProcessing && <span className="w-4">○</span>}
          Delegating {parseFloat(amount).toFixed(2)} HBAR to {agentName}
        </div>
      </div>

      {/* Status label */}
      {isProcessing && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs font-mono text-center font-semibold text-cyan-300"
        >
          Delegating...
        </motion.p>
      )}
      {isDone && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs font-mono text-center font-semibold text-green-400"
        >
          ✓ Delegated successfully!
        </motion.p>
      )}

      {/* Error */}
      {hasError && txError && (
        <div className="border border-red-500/30 rounded-lg p-3 bg-red-500/5 text-xs font-mono text-red-300">
          ✗ {txError}
        </div>
      )}

      {/* Actions */}
      {!isDone ? (
        <div className="flex gap-2 pt-1">
          <button
            onClick={onBack}
            disabled={isProcessing}
            className="flex-1 text-xs font-mono py-2 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-40 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={onExecute}
            disabled={isProcessing}
            className="flex-1 text-xs font-bold font-mono py-2 rounded border border-green-500/50 bg-green-500/15 text-green-300 hover:bg-green-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isProcessing ? '⏳ Processing…' : '⚡ Confirm Delegation'}
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

export default function DelegationWizard({ agentAddress, onClose, onSuccess }) {
  const contracts   = useStore((s) => s.contracts);
  const agents      = useStore((s) => s.agents);
  const hbarBalance  = useWalletStore((s) => s.hbarBalance);
  const address      = useWalletStore((s) => s.address);
  const signer       = useWalletStore((s) => s.signer);
  const refreshBals  = useWalletStore((s) => s.refreshBalances);
  const openWallet   = useWalletStore((s) => s.openWalletModal);
  const connected    = useWalletStore((s) => s.connectionStatus === 'connected');
  const toast        = useToast();

  const [step,    setStep]    = useState(1);
  const [amount,  setAmount]  = useState('');
  const [pool,    setPool]    = useState(null);
  const [existingDelegation, setExistingDelegation] = useState(null);
  const [showConfetti, setShowConfetti] = useState(false);

  // Transaction state
  const [isProcessing, setIsProcessing] = useState(false);
  const [txStep, setTxStep] = useState(null);
  const [txError, setTxError] = useState(null);

  const ds = contracts?.delegatedStakingContract;

  const agentProfile = agentAddress
    ? (agents[agentAddress] || agents[agentAddress?.toLowerCase()])
    : null;

  const agentName = agentProfile?.name || agentProfile?.agentId
    || (agentAddress ? fmt.address(agentAddress) : '—');

  const fetchPoolData = useCallback(async () => {
    if (!ds || !agentAddress) return;
    try {
      const poolResult = await ds.getAgentPool(agentAddress);
      setPool({
        totalDelegated:       poolResult.totalDelegated,
        rewardShareBps:       poolResult.rewardShareBps,
        delegatorCount:       Number(poolResult.delegatorCount),
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
    setIsProcessing(false);
    setTxStep(null);
    setTxError(null);
    fetchPoolData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAddress]);

  const handleExecute = async () => {
    if (!ds || !agentAddress || !amount || !signer) return;

    setIsProcessing(true);
    setTxStep('delegating');
    setTxError(null);

    try {
      // Single payable transaction: delegateWithHbar
      const hbarWei = ethers.parseEther(amount);
      const tx = await ds.connect(signer).delegateWithHbar(agentAddress, {
        value: hbarWei,
        gasLimit: 500_000,
      });
      await tx.wait();

      setTxStep('done');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2000);
      toast.success(`✓ Delegated ${parseFloat(amount).toFixed(2)} HBAR to ${agentName}`);
      await refreshBals();
      onSuccess?.();
    } catch (err) {
      setTxStep('error');
      const msg = err?.reason || err?.message?.slice(0, 100) || 'Transaction failed';
      setTxError(msg);
      toast.error(`✗ Delegation failed: ${msg}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Empty state
  if (!agentAddress) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-4">🎯</div>
        <h3 className="text-sm font-bold font-mono text-gray-300 uppercase tracking-wider mb-2">
          Select an Agent
        </h3>
        <p className="text-xs font-mono text-gray-500">
          Choose an agent from the browser to start delegating HBAR.
        </p>
      </div>
    );
  }

  // Not connected
  if (!connected) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-4">🔒</div>
        <h3 className="text-sm font-bold font-mono text-gray-300 uppercase tracking-wider mb-2">
          Wallet Required
        </h3>
        <p className="text-xs font-mono text-gray-500 mb-4">
          Connect your wallet to delegate HBAR to {agentName}.
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
                hbarBalance={hbarBalance ?? 0}
                amount={amount}
                setAmount={setAmount}
                pool={pool}
                onBack={() => setStep(1)}
                onNext={() => { setTxStep(null); setTxError(null); setStep(3); }}
              />
            </motion.div>
          )}
          {step === 3 && (
            <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Step3Confirm
                agentName={agentName}
                amount={amount}
                pool={pool}
                agentProfile={{ ...agentProfile, tier: agentProfile?.tier ?? 0 }}
                txStep={txStep}
                txError={txError}
                isProcessing={isProcessing}
                onBack={() => setStep(2)}
                onExecute={handleExecute}
                onClose={() => { setStep(1); setAmount(''); setTxStep(null); setTxError(null); onClose?.(); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
