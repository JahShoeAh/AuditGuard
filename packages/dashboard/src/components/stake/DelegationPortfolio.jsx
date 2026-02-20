import { useState, useEffect, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore from '../../store/wallet';
import WalletGate from '../wallet/WalletGate';
import { useContractWrite } from '../../hooks/useContractWrite';
import { useToast } from '../ui/Toast';

const POLL_MS = 30_000;

// Fixed rate: 1 HBAR = 100 GUARD
const RATE = 100;
const GUARD_DECIMALS = 8;

// ── Helpers ────────────────────────────────────────────────

function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS)).toFixed(2); } catch { return '0.00'; }
}

/** Format GUARD raw value as HBAR (divide by 100) */
function fmtHbar(raw) {
  if (raw == null) return '0.0000';
  try {
    const guard = parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS));
    return (guard / RATE).toFixed(4);
  } catch { return '0.0000'; }
}

function fmtShareRate(bps) {
  return `${(Number(bps ?? 0) / 100).toFixed(0)}%`;
}

const TIER_LABELS  = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];
const TIER_CLASSES = [
  'bg-gray-700 text-gray-300',
  'bg-cyan-900 text-cyan-300',
  'bg-amber-900 text-amber-300',
];

// ── Empty / disconnected states ───────────────────────────

function NotConnected() {
  const openWalletModal = useWalletStore((s) => s.openWalletModal);
  return (
    <div className="text-center py-6">
      <p className="text-gray-500 text-sm font-mono mb-3">
        Connect wallet to view your delegations.
      </p>
      <button
        onClick={() => openWalletModal({ action: 'view delegations' })}
        className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-300 border border-cyan-500/40 rounded px-3 py-1.5 hover:bg-cyan-500/10"
      >
        Connect Wallet
      </button>
    </div>
  );
}

function NoDelegations() {
  return (
    <div className="text-center py-6 text-gray-500 text-sm font-mono">
      You haven&apos;t delegated to any agents yet. Browse agents below to get started.
    </div>
  );
}

// ── Portfolio summary bar ──────────────────────────────────

function PortfolioSummary({
  totalDelegated,
  totalRewards,
  count,
  onClaimAll,
  isClaiming,
}) {
  return (
    <div className="flex items-center gap-4 flex-wrap px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg mb-3">
      <div className="flex-1 min-w-0">
        <span className="text-xs font-mono text-gray-400">Total Delegated: </span>
        <span className="text-sm font-bold font-mono text-amber-300">{totalDelegated} HBAR</span>
        <span className="mx-3 text-gray-600">│</span>
        <span className="text-xs font-mono text-gray-400">Pending Rewards: </span>
        <span className="text-sm font-bold font-mono text-yellow-400">{totalRewards} HBAR</span>
        <span className="mx-3 text-gray-600">│</span>
        <span className="text-xs font-mono text-gray-400">Backing </span>
        <span className="text-sm font-bold font-mono text-cyan-300">{count} agent{count !== 1 ? 's' : ''}</span>
      </div>
      <button
        onClick={onClaimAll}
        disabled={isClaiming || parseFloat(totalRewards) === 0}
        className="flex-shrink-0 text-xs font-bold font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isClaiming ? '⏳ Claiming…' : '⚡ Claim All Rewards'}
      </button>
    </div>
  );
}

// ── Individual delegation card ─────────────────────────────

function DelegationCard({
  agentAddr,
  amount,
  pendingRewards,
  poolData,
  agentProfile,
  onAddMore,
  onRefresh,
}) {
  const toast = useToast();
  const { execute: execClaim, status: claimStatus, reset: resetClaim } = useContractWrite();
  const { execute: execUndelegate, status: undelegateStatus, reset: resetUndelegate } = useContractWrite();
  const contracts = useStore((s) => s.contracts);
  const ds = contracts?.delegatedStakingContract;

  const name       = agentProfile?.name || agentProfile?.agentId || `${agentAddr.slice(0, 6)}…${agentAddr.slice(-4)}`;
  const rep        = Number(agentProfile?.reputationScore ?? agentProfile?.reputation ?? 0) / 100;
  const tier       = agentProfile?.tier ?? 0;
  const shareRate  = fmtShareRate(poolData?.rewardShareBps);
  const poolTotalHbar = fmtHbar(poolData?.totalDelegated);

  const isClaiming      = claimStatus === 'confirming';
  const isUndelegating  = undelegateStatus === 'confirming';

  const handleClaim = async () => {
    if (!ds) return;
    try {
      await execClaim(ds, 'claimRewardsAsHbar', [agentAddr]);
      toast.success(`✓ Claimed ${fmtHbar(pendingRewards)} HBAR rewards from ${name}`);
      onRefresh?.();
    } catch (err) {
      toast.error(`✗ Claim failed: ${err?.message?.slice(0, 80) ?? 'unknown error'}`);
    } finally {
      resetClaim();
    }
  };

  const handleUndelegate = async () => {
    if (!ds) return;
    try {
      await execUndelegate(ds, 'requestUndelegate', [agentAddr, amount]);
      toast.info(`Unbonding ${fmtHbar(amount)} HBAR from ${name}. Withdrawal available after bonding period.`);
      onRefresh?.();
    } catch (err) {
      toast.error(`✗ Undelegate failed: ${err?.message?.slice(0, 80) ?? 'unknown error'}`);
    } finally {
      resetUndelegate();
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="border border-gray-700 rounded-lg p-3 bg-gray-900 hover:border-gray-600 transition-colors"
    >
      {/* Row 1: name, rep, tier */}
      <div className="flex items-center gap-2 font-mono">
        <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
        <span className="flex-1 text-sm font-bold text-gray-100 truncate">{name}</span>
        <span className="text-xs text-gray-400">{rep.toFixed(2)} rep</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${TIER_CLASSES[tier] || TIER_CLASSES[0]}`}>
          {TIER_LABELS[tier] || 'COMMODITY'}
        </span>
      </div>

      {/* Row 2: delegated + rewards (all in HBAR) */}
      <div className="flex items-center gap-4 mt-1.5 text-xs font-mono pl-4">
        <span className="text-gray-400">
          Delegated: <span className="text-amber-300 font-semibold">{fmtHbar(amount)} HBAR</span>
        </span>
        <span className="text-gray-600">│</span>
        <span className="text-gray-400">
          Pending:{' '}
          <span className={`font-semibold ${parseFloat(fmtHbar(pendingRewards)) > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
            {fmtHbar(pendingRewards)} HBAR
          </span>
        </span>
      </div>

      {/* Row 3: share rate + pool size */}
      <div className="flex items-center gap-4 mt-1 text-xs font-mono pl-4 text-gray-500">
        <span>Share rate: <span className="text-cyan-400">{shareRate}</span></span>
        <span>│</span>
        <span>Pool: <span className="text-gray-300">{poolTotalHbar} HBAR total</span></span>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-2.5 pl-4">
        <button
          onClick={handleClaim}
          disabled={isClaiming || parseFloat(fmtG(pendingRewards)) === 0}
          className="text-[10px] font-bold font-mono uppercase tracking-wider px-2.5 py-1 rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isClaiming ? '⏳…' : 'Claim Rewards'}
        </button>
        <button
          onClick={() => onAddMore?.(agentAddr)}
          className="text-[10px] font-bold font-mono uppercase tracking-wider px-2.5 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
        >
          Add More
        </button>
        <button
          onClick={handleUndelegate}
          disabled={isUndelegating}
          className="text-[10px] font-bold font-mono uppercase tracking-wider px-2.5 py-1 rounded border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isUndelegating ? '⏳…' : 'Undelegate'}
        </button>
      </div>
    </motion.div>
  );
}

// ── Main component ─────────────────────────────────────────

export default function DelegationPortfolio({ onSelectAgent }) {
  const contracts    = useStore((s) => s.contracts);
  const agents       = useStore((s) => s.agents);
  const address      = useWalletStore((s) => s.address);
  const connected    = useWalletStore((s) => s.connectionStatus === 'connected');
  const { success: toastSuccess, error: toastError } = useToast();

  const { execute: execClaimAll, status: claimAllStatus, reset: resetClaimAll } = useContractWrite();

  const [portfolio, setPortfolio] = useState({ agents: [], amounts: [], pendingRewards: [] });
  const [poolData,  setPoolData]  = useState({});
  const [loading,   setLoading]   = useState(false);

  const ds = contracts?.delegatedStakingContract;

  const fetchPortfolio = useCallback(async () => {
    if (!ds || !address) return;
    setLoading(true);
    try {
      const [portAgents, amounts, rewards] = await ds.getDelegatorPortfolio(address);
      setPortfolio({ agents: [...portAgents], amounts: [...amounts], pendingRewards: [...rewards] });

      const poolMap = {};
      await Promise.allSettled(
        portAgents.map(async (addr) => {
          try {
            const pool = await ds.getAgentPool(addr);
            poolMap[addr.toLowerCase()] = {
              totalDelegated:       pool.totalDelegated,
              rewardShareBps:       pool.rewardShareBps,
              delegatorCount:       Number(pool.delegatorCount),
            };
          } catch { /* skip */ }
        })
      );
      setPoolData(poolMap);
    } catch {
      // Contract may not be deployed
    } finally {
      setLoading(false);
    }
  }, [ds, address]);

  useEffect(() => {
    if (!connected) return;
    fetchPortfolio();
    const id = setInterval(fetchPortfolio, POLL_MS);
    return () => clearInterval(id);
  }, [connected, fetchPortfolio]);

  const handleClaimAll = async () => {
    if (!ds) return;
    try {
      // Single-tx: claimAllRewardsAsHbar returns HBAR directly
      await execClaimAll(ds, 'claimAllRewardsAsHbar', []);
      toastSuccess('✓ All rewards claimed as HBAR');
      fetchPortfolio();
    } catch (err) {
      toastError(`✗ Claim all failed: ${err?.message?.slice(0, 80) ?? 'unknown'}`);
    } finally {
      resetClaimAll();
    }
  };

  if (!connected) {
    return (
      <section className="border border-gray-800 rounded-lg bg-gray-950 p-4">
        <SectionTitle loading={false} />
        <NotConnected />
      </section>
    );
  }

  const hasPortfolio = portfolio.agents.length > 0;

  // Show totals in HBAR
  const totalDelegated = portfolio.amounts
    .reduce((sum, a) => sum + parseFloat(fmtHbar(a)), 0)
    .toFixed(4);

  const totalRewards = portfolio.pendingRewards
    .reduce((sum, r) => sum + parseFloat(fmtHbar(r)), 0)
    .toFixed(4);

  return (
    <section className="border border-gray-800 rounded-lg bg-gray-950 p-4">
      <SectionTitle loading={loading} />

      {hasPortfolio ? (
        <>
          <PortfolioSummary
            totalDelegated={totalDelegated}
            totalRewards={totalRewards}
            count={portfolio.agents.length}
            onClaimAll={handleClaimAll}
            isClaiming={claimAllStatus === 'confirming'}
          />

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            <AnimatePresence>
              {portfolio.agents.map((addr, i) => (
                <DelegationCard
                  key={addr}
                  agentAddr={addr}
                  amount={portfolio.amounts[i]}
                  pendingRewards={portfolio.pendingRewards[i]}
                  poolData={poolData[addr.toLowerCase()]}
                  agentProfile={agents[addr] || agents[addr.toLowerCase()]}
                  onAddMore={onSelectAgent}
                  onRefresh={fetchPortfolio}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      ) : (
        <NoDelegations />
      )}
    </section>
  );
}

function SectionTitle({ loading }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-amber-400">💎</span>
      <h2 className="text-xs font-bold font-mono uppercase tracking-widest text-gray-100">
        Your Delegation Portfolio
      </h2>
      {loading && <span className="ml-auto text-cyan-400 text-xs animate-pulse font-mono">syncing…</span>}
    </div>
  );
}
