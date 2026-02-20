import { useState, useEffect, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { motion, AnimatePresence } from 'framer-motion';
import useStore from '../../store/index';
import useWalletStore, { hbarEquivalent } from '../../store/wallet';
import WalletGate from '../wallet/WalletGate';
import { useContractWrite } from '../../hooks/useContractWrite';
import { useHbarSwap } from '../../hooks/useHbarSwap';
import { useToast } from '../ui/Toast';

const POLL_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────

// GUARD uses 8 decimal places on Hedera (same precision used by DelegatedStaking).
const GUARD_DECIMALS = 8;

function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS)).toFixed(2); } catch { return '0.00'; }
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
  totalRewardsHbar,
  count,
  onClaimAll,
  onClaimAllAndConvert,
  isClaiming,
  isConvertingAll,
}) {
  return (
    <div className="flex items-center gap-4 flex-wrap px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg mb-3">
      <div className="flex-1 min-w-0">
        <span className="text-xs font-mono text-gray-400">Total Delegated: </span>
        <span className="text-sm font-bold font-mono text-amber-300">{totalDelegated} GUARD</span>
        <span className="mx-3 text-gray-600">│</span>
        <span className="text-xs font-mono text-gray-400">Pending Rewards: </span>
        <span className="text-sm font-bold font-mono text-yellow-400">
          {totalRewards} GUARD <span className="text-gray-500 text-xs">(≈ {totalRewardsHbar} HBAR)</span>
        </span>
        <span className="mx-3 text-gray-600">│</span>
        <span className="text-xs font-mono text-gray-400">Backing </span>
        <span className="text-sm font-bold font-mono text-cyan-300">{count} agent{count !== 1 ? 's' : ''}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onClaimAll}
          disabled={isClaiming || parseFloat(totalRewards) === 0}
          className="flex-shrink-0 text-xs font-bold font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isClaiming ? '⏳ Claiming…' : '⚡ Claim All Rewards'}
        </button>
        <button
          onClick={onClaimAllAndConvert}
          disabled={isConvertingAll || parseFloat(totalRewards) === 0}
          className="flex-shrink-0 text-xs font-bold font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isConvertingAll ? '⏳ Converting…' : '⚡ Claim All & Convert to HBAR'}
        </button>
      </div>
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
  hbarPerGuard,
  isSwapping,
  swapStep,
  convertingAgent,
  onClaimAndConvert,
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
  const poolTotal  = fmtG(poolData?.totalDelegated);

  const isClaiming      = claimStatus === 'confirming';
  const isUndelegating  = undelegateStatus === 'confirming';

  const handleClaim = async () => {
    if (!ds) return;
    try {
      await execClaim(ds, 'claimRewards', [agentAddr]);
      toast.success(`✓ Claimed ${fmtG(pendingRewards)} GUARD rewards from ${name}`);
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
      toast.info(`Unbonding ${fmtG(amount)} GUARD from ${name}. Withdrawal available after bonding period.`);
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

      {/* Row 2: delegated + rewards */}
      <div className="flex items-center gap-4 mt-1.5 text-xs font-mono pl-4">
        <span className="text-gray-400">
          Delegated: <span className="text-amber-300 font-semibold">{fmtG(amount)} GUARD</span>
        </span>
        <span className="text-gray-600">│</span>
        <span className="text-gray-400">
          Pending:{' '}
          <span className={`font-semibold ${parseFloat(fmtG(pendingRewards)) > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
            {fmtG(pendingRewards)} GUARD
          </span>
          <span className="text-gray-500 text-xs font-mono ml-2">
            ≈ {hbarEquivalent(fmtG(pendingRewards), hbarPerGuard)} HBAR
          </span>
        </span>
      </div>

      {/* Row 3: share rate + pool size */}
      <div className="flex items-center gap-4 mt-1 text-xs font-mono pl-4 text-gray-500">
        <span>Share rate: <span className="text-cyan-400">{shareRate}</span></span>
        <span>│</span>
        <span>Pool: <span className="text-gray-300">{poolTotal} GUARD total</span></span>
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
          onClick={() => onClaimAndConvert?.(agentAddr)}
          disabled={isSwapping || convertingAgent !== null || parseFloat(fmtG(pendingRewards)) === 0}
          className="text-[10px] font-bold font-mono uppercase tracking-wider px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {convertingAgent === agentAddr && isSwapping
            ? `${swapStep === 'executing' ? 'Claiming...' : swapStep === 'converting' ? 'Converting...' : '...'}`
            : 'Claim & Convert to HBAR'}
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

/**
 * DelegationPortfolio — shows the connected wallet's active delegations.
 *
 * Props:
 *   onSelectAgent(addr)  — called when user clicks "Add More" on a card
 */
export default function DelegationPortfolio({ onSelectAgent }) {
  const contracts    = useStore((s) => s.contracts);
  const agents       = useStore((s) => s.agents);
  const address      = useWalletStore((s) => s.address);
  const connected    = useWalletStore((s) => s.connectionStatus === 'connected');
  const hbarPerGuard = useWalletStore((s) => s.hbarPerGuard);
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const { claimAndConvert, isSwapping, swapError, swapStep, reset } = useHbarSwap();

  const { execute: execClaimAll, status: claimAllStatus, reset: resetClaimAll } = useContractWrite();

  const [portfolio, setPortfolio] = useState({ agents: [], amounts: [], pendingRewards: [] });
  const [poolData,  setPoolData]  = useState({});
  const [loading,   setLoading]   = useState(false);
  const [convertingAgent, setConvertingAgent] = useState(null);
  const [isConvertingAll, setIsConvertingAll] = useState(false);

  const ds = contracts?.delegatedStakingContract;

  const fetchPortfolio = useCallback(async () => {
    if (!ds || !address) return;
    setLoading(true);
    try {
      const [portAgents, amounts, rewards] = await ds.getDelegatorPortfolio(address);
      setPortfolio({ agents: [...portAgents], amounts: [...amounts], pendingRewards: [...rewards] });

      // Fetch pool data for each delegated agent
      const poolMap = {};
      await Promise.allSettled(
        portAgents.map(async (addr) => {
          try {
            const pool = await ds.getAgentPool(addr);
            poolMap[addr.toLowerCase()] = {
              totalDelegated:       pool.totalDelegated,
              rewardShareBps:       pool.rewardShareBps,
              delegatorCount:       Number(pool.delegatorCount),
              acceptingDelegations: pool.acceptingDelegations,
            };
          } catch { /* skip */ }
        })
      );
      setPoolData(poolMap);
    } catch {
      // Contract may not be deployed — silently empty
    } finally {
      setLoading(false);
    }
  }, [ds, address]);

  // Initial load + polling
  useEffect(() => {
    if (!connected) return;
    fetchPortfolio();
    const id = setInterval(fetchPortfolio, POLL_MS);
    return () => clearInterval(id);
  }, [connected, fetchPortfolio]);

  const handleClaimAll = async () => {
    if (!ds) return;
    try {
      await execClaimAll(ds, 'claimAllRewards', []);
      toastSuccess('✓ All rewards claimed successfully');
      fetchPortfolio();
    } catch (err) {
      toastError(`✗ Claim all failed: ${err?.message?.slice(0, 80) ?? 'unknown'}`);
    } finally {
      resetClaimAll();
    }
  };

  const handleClaimAndConvert = async (agentAddr) => {
    if (!ds) return;
    setConvertingAgent(agentAddr);
    reset();
    try {
      toastInfo('Claiming rewards and converting to HBAR...');
      const { guardClaimed, hbarReceived } = await claimAndConvert(agentAddr, ds);
      toastSuccess(
        `Received ${parseFloat(hbarReceived).toFixed(4)} HBAR (from ${parseFloat(guardClaimed).toFixed(2)} GUARD)`
      );
      await fetchPortfolio?.();
    } catch (err) {
      toastError(`Conversion failed: ${swapError || err?.message || 'unknown error'}`);
    } finally {
      setConvertingAgent(null);
    }
  };

  const handleClaimAllAndConvert = async () => {
    if (!ds) return;
    const delegations = portfolio.agents.map((agentAddress, i) => ({
      agentAddress,
      pendingRewards: portfolio.pendingRewards[i],
    }));
    const agentsWithRewards = delegations.filter((d) => BigInt(d.pendingRewards ?? 0) > 0n);
    if (!agentsWithRewards.length) return;

    setIsConvertingAll(true);
    reset();
    toastInfo(`Converting rewards from ${agentsWithRewards.length} agents to HBAR...`);
    let totalHbar = 0;
    for (const d of agentsWithRewards) {
      setConvertingAgent(d.agentAddress);
      try {
        const { hbarReceived } = await claimAndConvert(d.agentAddress, ds);
        totalHbar += parseFloat(hbarReceived);
      } catch {
        // Continue with remaining agents even if one fails
      }
    }
    setConvertingAgent(null);
    setIsConvertingAll(false);
    toastSuccess(`Total received: ${totalHbar.toFixed(4)} HBAR`);
    await fetchPortfolio?.();
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

  const totalDelegated = portfolio.amounts
    .reduce((sum, a) => sum + parseFloat(fmtG(a)), 0)
    .toFixed(2);

  const totalRewards = portfolio.pendingRewards
    .reduce((sum, r) => sum + parseFloat(fmtG(r)), 0)
    .toFixed(2);
  const totalRewardsHbar = hbarEquivalent(totalRewards, hbarPerGuard);

  return (
    <section className="border border-gray-800 rounded-lg bg-gray-950 p-4">
      <SectionTitle loading={loading} />

      {hasPortfolio ? (
        <>
          <PortfolioSummary
            totalDelegated={totalDelegated}
            totalRewards={totalRewards}
            totalRewardsHbar={totalRewardsHbar}
            count={portfolio.agents.length}
            onClaimAll={handleClaimAll}
            onClaimAllAndConvert={handleClaimAllAndConvert}
            isClaiming={claimAllStatus === 'confirming'}
            isConvertingAll={isConvertingAll}
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
                  hbarPerGuard={hbarPerGuard}
                  isSwapping={isSwapping}
                  swapStep={swapStep}
                  convertingAgent={convertingAgent}
                  onClaimAndConvert={handleClaimAndConvert}
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
