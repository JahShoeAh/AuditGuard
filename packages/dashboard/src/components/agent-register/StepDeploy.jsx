import { useState } from 'react';
import { parseUnits } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import { useHbarSwap } from '../../hooks/useHbarSwap';
import { hashscan } from '../../utils/hashscan';
import { AVATAR_OPTIONS } from './StepIdentity';
import { TIERS, SPECIALIZATIONS } from './StepSpecialization';

// ── Constants ──────────────────────────────────────────────

// AgentRegistry uses 8-decimal GUARD amounts (same as DelegatedStaking).
const GUARD_DECIMALS = 8;

// ── Confetti ───────────────────────────────────────────────

const CONFETTI_CSS = `@keyframes cfFall { to { transform: translateY(100vh) rotate(720deg); opacity: 0; } }`;

function Confetti() {
  const COLORS = ['#22d3ee', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#f97316'];
  return (
    <>
      <style>{CONFETTI_CSS}</style>
      <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
        {Array.from({ length: 40 }, (_, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${(i * 2.5) % 100}%`,
              top: '-12px',
              width:  `${5 + (i % 4) * 2}px`,
              height: `${5 + (i % 4) * 2}px`,
              background: COLORS[i % COLORS.length],
              borderRadius: i % 3 === 0 ? '50%' : '2px',
              animation: `cfFall ${0.9 + (i % 5) * 0.13}s ${(i % 10) * 50}ms ease-in forwards`,
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── Row helpers ────────────────────────────────────────────

function SummaryRow({ label, value, valueClass = 'text-gray-200' }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-800 last:border-0">
      <span className="text-xs font-mono text-gray-500">{label}</span>
      <span className={`text-xs font-mono font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

function TxRow({ label, done, active }) {
  return (
    <div className={[
      'flex items-center gap-2 text-xs font-mono py-1',
      done ? 'text-green-400' : active ? 'text-cyan-300' : 'text-gray-600',
    ].join(' ')}>
      {done   && <span className="w-4 flex-shrink-0">✓</span>}
      {active && <span className="w-4 flex-shrink-0 animate-spin inline-block">◌</span>}
      {!done && !active && <span className="w-4 flex-shrink-0">○</span>}
      {label}
    </div>
  );
}

// ── SuccessScreen ──────────────────────────────────────────

function SuccessScreen({ formData, agentAddress, stakeAmountHuman, stakeInHbar }) {
  const tierDef  = TIERS.find((t) => t.id === formData.tier) || TIERS[0];
  const avatarDef = AVATAR_OPTIONS.find((a) => a.id === formData.identity.avatar);

  return (
    <div className="space-y-6 text-center">
      <Confetti />

      <div>
        <div className="text-5xl mb-3">🎉</div>
        <h2 className="text-lg font-bold font-mono text-gray-100">Your agent is live on AuditGuard!</h2>
        <p className="text-sm text-gray-400 font-mono mt-1">
          Registration confirmed on Hedera Testnet.
        </p>
      </div>

      {/* Agent profile card */}
      <div className="border border-gray-700 rounded-xl p-4 bg-gray-900 text-left space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{avatarDef?.emoji ?? '🤖'}</span>
          <div>
            <div className="text-base font-bold font-mono text-gray-100">
              {formData.identity.agentId}
            </div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${tierDef.badge}`}>
              {tierDef.label}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 text-xs font-mono mt-2">
          <span className="text-gray-500">Address</span>
          <span className="text-cyan-400 text-right truncate">{agentAddress}</span>
          <span className="text-gray-500">Stake</span>
          <span className="text-amber-300 text-right">{stakeInHbar} HBAR</span>
          <span className="text-gray-500">Starting reputation</span>
          <span className="text-green-400 text-right">50.00</span>
          <span className="text-gray-500">Specializations</span>
          <span className="text-gray-200 text-right">
            {formData.specializations.map((sid) =>
              SPECIALIZATIONS.find((s) => s.id === sid)?.label ?? sid
            ).join(', ')}
          </span>
        </div>
        <p className="text-[11px] font-mono text-gray-500 pt-1 border-t border-gray-800">
          Your agent will begin receiving job opportunities at{' '}
          <span className="text-cyan-400">{formData.ucp.ucpEndpoint}</span>.
          Starting reputation: 50.00. Complete audits to build reputation.
        </p>
      </div>

      {/* Action links */}
      <div className="flex flex-col gap-2">
        <Link
          to="/dashboard?tab=agents"
          className="block w-full py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
        >
          View on Agent Leaderboard →
        </Link>
        <Link
          to={`/dashboard/stake?agent=${agentAddress}`}
          className="block w-full py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          Enable Delegation to attract backers →
        </Link>
        <a
          href={hashscan.account(agentAddress)}
          target="_blank"
          rel="noreferrer"
          className="block w-full py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          View on HashScan ↗
        </a>
      </div>
    </div>
  );
}

// ── parseError ─────────────────────────────────────────────

function parseError(err) {
  if (!err) return 'Unknown error';
  if (err.code === 4001 || err.code === 'ACTION_REJECTED') return 'Transaction rejected by user.';
  if (err.reason) return err.reason;
  const msg = err.message || '';
  if (msg.includes('already registered') || msg.includes('already exists')) return 'Agent ID already taken — go back to Step 1 and choose a different ID.';
  if (msg.includes('insufficient') || msg.includes('balance')) return 'Insufficient GUARD balance for the selected stake amount.';
  if (msg.includes('not found') || msg.includes('404')) return 'Agent not found in registry after deployment — check HashScan and wait 5–10 seconds, then reload the leaderboard.';
  return msg.slice(0, 150) || 'Transaction failed.';
}

// ── StepDeploy ─────────────────────────────────────────────

/**
 * Step 4 — Review & Deploy
 *
 * Props:
 *   formData   { identity: {agentId, description, avatar}, ucp: {...}, specializations, tier }
 *   onReset    () => void   (go back to step 1 on "Agent ID taken" error)
 */
export default function StepDeploy({ formData, onReset }) {
  const contracts  = useStore((s) => s.contracts);
  const address    = useWalletStore((s) => s.address);
  const hbarBalance = useWalletStore((s) => s.hbarBalance);
  const refreshBal = useWalletStore((s) => s.refreshBalances);
  const { swapAndExecute, swapStep, isSwapping, swapError, reset } = useHbarSwap();

  const [riskChecked, setRiskChecked] = useState(false);
  const [deployStep,  setDeployStep]  = useState('idle');
  const [txError,     setTxError]     = useState(null);
  const [agentAddress, setAgentAddress] = useState(null);

  const tierDef      = TIERS.find((t) => t.id === formData.tier) || TIERS[0];
  const stakeAmountHuman = String(tierDef?.stake ?? 100);
  // Fixed rate: 100 GUARD = 1 HBAR
  const stakeInHbar = (tierDef.stake / 100).toFixed(4);
  const stakeRaw     = parseUnits(tierDef.stake.toString(), GUARD_DECIMALS);
  const hbarBalNum   = parseFloat(hbarBalance) || 0;
  const balanceAfterHbar = hbarBalNum - parseFloat(stakeInHbar);

  const isDone    = deployStep === 'success';
  const hasError  = deployStep === 'error';

  const handleDeploy = async () => {
    const registry = contracts?.agentRegistryContract;
    if (!registry || !address) {
      setTxError('Wallet or contracts not ready. Refresh and try again.');
      setDeployStep('error');
      return;
    }

    reset();
    setTxError(null);

    try {
      await swapAndExecute(
        stakeAmountHuman,
        registry,
        'registerAgent',
        [
          formData.identity.agentId,
          formData.ucp.ucpEndpoint,
          formData.specializations,
          stakeRaw,
        ]
      );

      setAgentAddress(address);
      setDeployStep('success');
      refreshBal();
    } catch (err) {
      setTxError(parseError(err));
      setDeployStep('error');
    }
  };

  if (isDone && agentAddress) {
    return (
      <SuccessScreen
        formData={formData}
        agentAddress={agentAddress}
        stakeAmountHuman={stakeAmountHuman}
        stakeInHbar={stakeInHbar}
      />
    );
  }

  const isAgentIdTaken = txError?.includes('Agent ID already taken');

  return (
    <div className="space-y-5">

      {/* Summary card */}
      <div className="border border-gray-700 rounded-xl p-4 bg-gray-900">
        <p className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500 mb-3">
          Registration Summary
        </p>
        <SummaryRow label="Agent ID"      value={formData.identity.agentId} />
        <SummaryRow label="UCP Endpoint"  value={formData.ucp.ucpEndpoint}  valueClass="text-cyan-400 truncate max-w-[200px]" />
        <SummaryRow
          label="Specializations"
          value={formData.specializations.map((sid) =>
            SPECIALIZATIONS.find((s) => s.id === sid)?.label ?? sid
          ).join(', ')}
        />
        <SummaryRow
          label="Tier"
          value={tierDef.label}
          valueClass={tierDef.id === 'PREMIUM' ? 'text-amber-300' : tierDef.id === 'SPECIALIZED' ? 'text-cyan-300' : 'text-gray-300'}
        />
        <SummaryRow
          label="Stake required"
          value={`${stakeInHbar} HBAR`}
          valueClass="text-amber-300"
        />
        <SummaryRow
          label="Connectivity"
          value={
            formData.ucp.testStatus === 'ok'   ? '✓ Verified' :
            formData.ucp.testStatus === 'cors' ? '⚠ CORS (unverifiable from browser)' :
            '⚠ Not verified'
          }
          valueClass={formData.ucp.testStatus === 'ok' ? 'text-green-400' : 'text-amber-400'}
        />
      </div>

      {/* Cost breakdown */}
      <div className="border border-gray-700 rounded-xl p-4 bg-gray-900">
        <p className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500 mb-3">
          Cost Breakdown
        </p>
        <SummaryRow
          label="Staking (held as collateral)"
          value={`${stakeInHbar} HBAR`}
          valueClass="text-amber-300"
        />
        <SummaryRow
          label="Gas estimate"
          value="~0.05 HBAR"
          valueClass="text-gray-300"
        />
        <SummaryRow
          label="HBAR balance after registration"
          value={`${Math.max(0, balanceAfterHbar).toFixed(4)} HBAR`}
          valueClass={balanceAfterHbar < 0 ? 'text-red-400' : 'text-green-400'}
        />
      </div>

      {/* Risk disclosure */}
      <div className="border border-amber-500/30 rounded-xl p-4 bg-amber-500/5">
        <p className="text-xs font-mono text-amber-300 mb-3 leading-relaxed">
          ⚠ Your staked GUARD is subject to slashing if your agent produces{' '}
          <strong>false positives (5%)</strong>, <strong>false negatives (10%)</strong>,
          or <strong>malicious reports (100%)</strong>. Ensure your agent&apos;s analysis
          is accurate and your UCP service is reliable.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={riskChecked}
            onChange={(e) => setRiskChecked(e.target.checked)}
            className="w-4 h-4 accent-amber-400 flex-shrink-0"
          />
          <span className="text-xs font-mono text-gray-300">
            I understand the staking and slashing risks
          </span>
        </label>
      </div>

      {/* Two-tx progress */}
      <div className="border border-gray-700 rounded-xl p-4 bg-gray-900">
        <p className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500 mb-2">
          Transactions
        </p>
        <TxRow
          label="Preparing HBAR conversion..."
          done={['swapping', 'approving', 'executing', 'done'].includes(swapStep)}
          active={swapStep === 'quoting'}
        />
        <TxRow
          label="1/3 — Converting HBAR..."
          done={['approving', 'executing', 'done'].includes(swapStep)}
          active={swapStep === 'swapping'}
        />
        <TxRow
          label="2/3 — Approving for registry..."
          done={['executing', 'done'].includes(swapStep)}
          active={swapStep === 'approving'}
        />
        <TxRow
          label="3/3 — Registering agent on-chain..."
          done={swapStep === 'done'}
          active={swapStep === 'executing'}
        />
      </div>

      {/* Error */}
      <AnimatePresence>
        {hasError && (swapError || txError) && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="border border-red-500/40 rounded-xl p-4 bg-red-500/5"
          >
            <p className="text-xs font-mono text-red-300 leading-relaxed">✗ {swapError || txError}</p>
            {isAgentIdTaken && (
              <button
                onClick={onReset}
                className="mt-2 text-[11px] font-bold font-mono text-cyan-400 hover:text-cyan-200 underline"
              >
                ← Go back to Step 1 to change the Agent ID
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Deploy button */}
      <button
        type="button"
        onClick={handleDeploy}
        disabled={!riskChecked || isSwapping}
        className={[
          'w-full py-3 rounded-xl text-sm font-bold font-mono uppercase tracking-wider transition-all',
          !riskChecked || isSwapping
            ? 'bg-gray-800 border border-gray-700 text-gray-600 cursor-not-allowed'
            : 'bg-green-500/15 border-2 border-green-500/60 text-green-300 hover:bg-green-500/25 shadow-[0_0_20px_rgba(34,197,94,0.1)]',
        ].join(' ')}
      >
        {isSwapping
          ? swapStep === 'quoting'   ? '⏳ Preparing...'
          : swapStep === 'swapping'  ? '⏳ 1/3 Converting HBAR...'
          : swapStep === 'approving' ? '⏳ 2/3 Approving...'
          : swapStep === 'executing' ? '⏳ 3/3 Registering...'
          : '⏳ Processing...'
          : '🚀 Deploy Agent'}
      </button>
    </div>
  );
}
