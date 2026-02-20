import { useState, useEffect, useMemo } from 'react';
import { formatUnits } from 'ethers';
import { motion } from 'framer-motion';
import useStore from '../../store/index';
import { useAgentLeaderboard } from '../../hooks/useAgentLeaderboard';
import { fmt } from '../../utils/format';

const POLL_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────

// GUARD uses 8 decimal places on Hedera (same precision used by DelegatedStaking).
const GUARD_DECIMALS = 8;

function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), GUARD_DECIMALS)).toFixed(2); } catch { return '0.00'; }
}

function fmtShareRate(bps) {
  const n = Number(bps ?? 0);
  return n === 0 ? '0%' : `${(n / 100).toFixed(n % 100 === 0 ? 0 : 1)}%`;
}

function calcWinRate(agent) {
  const jobs = agent.completedJobs || 0;
  const wins = agent.successfulFindings || 0;
  if (!jobs) return null;
  return Math.round((wins / jobs) * 100);
}

const TIER_LABELS  = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];
const TIER_CLASSES = [
  'bg-gray-700 text-gray-300',
  'bg-cyan-900 text-cyan-300',
  'bg-amber-900 text-amber-300',
];

const SORT_OPTIONS = [
  { key: 'reputation',  label: 'By Reputation'    },
  { key: 'backing',     label: 'By Total Backing'  },
  { key: 'rewardShare', label: 'By Reward Share'   },
  { key: 'winRate',     label: 'By Win Rate'        },
];

// ── Agent row ──────────────────────────────────────────────

function AgentBrowserRow({ rank, agent, pool, backing, isSelected, onSelect }) {
  const rep     = Number(agent.reputationScore ?? agent.reputation ?? 0) / 100;
  const tier    = agent.tier ?? 0;
  const winRate = calcWinRate(agent);

  const selfStake     = fmtG(agent.stakedAmount ?? agent.effectiveStake ?? 0n);
  const delegated     = fmtG(pool?.totalDelegated ?? 0n);
  const totalBacking  = backing != null
    ? parseFloat(formatUnits(BigInt(backing.toString()), GUARD_DECIMALS)).toFixed(2)
    : (parseFloat(selfStake) + parseFloat(delegated)).toFixed(2);

  const shareRate      = pool && pool.totalDelegated > 0n
    ? fmtShareRate(pool.rewardShareBps)
    : '10%';
  const delegatorCount = pool?.delegatorCount ?? 0;
  const accepting      = pool?.acceptingDelegations ?? true;

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={[
        'rounded-lg border p-3 cursor-pointer transition-all',
        isSelected
          ? 'border-cyan-400 bg-gray-800'
          : 'border-gray-700 bg-gray-900 hover:border-gray-500',
      ].join(' ')}
      onClick={() => onSelect(agent.address)}
    >
      {/* Row 1: rank, status, name, tier, rep */}
      <div className="flex items-center gap-2 font-mono">
        <span className="text-[10px] text-gray-600 w-4 text-right">#{rank}</span>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${accepting ? 'bg-green-400' : 'bg-gray-600'}`} />
        <span className="flex-1 text-sm font-bold text-gray-100 truncate">
          {agent.name || agent.agentId || fmt.address(agent.address)}
        </span>
        <span className="text-xs text-gray-400">{rep.toFixed(2)} rep</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${TIER_CLASSES[tier] || TIER_CLASSES[0]}`}>
          {TIER_LABELS[tier] || 'COMMODITY'}
        </span>
      </div>

      {/* Row 2: stakes */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 text-xs font-mono pl-6">
        <span className="text-gray-400">
          Self-stake: <span className="text-amber-300">{selfStake} GUARD</span>
        </span>
        <span className="text-gray-600">│</span>
        <span className="text-gray-400">
          Delegated: <span className="text-cyan-300">{delegated} GUARD</span>
        </span>
      </div>

      {/* Row 3: total backing */}
      <div className="flex items-center gap-2 mt-0.5 text-xs font-mono pl-6">
        <span className="text-gray-400">
          Total backing: <span className="text-gray-100 font-semibold">{totalBacking} GUARD</span>
        </span>
      </div>

      {/* Row 4: delegation metrics */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs font-mono pl-6 text-gray-500">
        <span>
          Reward share: <span className="text-green-400 font-semibold">{shareRate}</span>
          {(!pool || pool.totalDelegated === 0n) && (
            <span className="text-gray-600 text-[10px] ml-1">(default)</span>
          )}
        </span>
        <span>│</span>
        <span>{delegatorCount} delegator{delegatorCount !== 1 ? 's' : ''}</span>
        <span>│</span>
        <span className={accepting ? 'text-green-400' : 'text-red-400'}>
          {accepting ? 'Accepting: ✓' : '✗ Closed'}
        </span>
      </div>

      {/* Row 5: job metrics */}
      <div className="flex items-center justify-between mt-1 pl-6">
        <div className="flex items-center gap-3 text-xs font-mono text-gray-500">
          <span>Jobs: {agent.completedJobs || 0}</span>
          <span>│</span>
          <span>
            Win rate:{' '}
            <span className={winRate != null ? (winRate >= 70 ? 'text-green-400' : winRate >= 50 ? 'text-yellow-300' : 'text-red-400') : 'text-gray-600'}>
              {winRate != null ? `${winRate}%` : '—'}
            </span>
          </span>
          <span>│</span>
          <span>
            Slash:{' '}
            <span className={(agent.slashCount || 0) > 0 ? 'text-red-400 font-semibold' : 'text-gray-500'}>
              {agent.slashCount || 0}
            </span>
          </span>
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onSelect(agent.address); }}
          className="text-[10px] font-bold font-mono uppercase tracking-wider px-2.5 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 transition-colors"
        >
          Delegate →
        </button>
      </div>
    </motion.div>
  );
}

// ── Main component ─────────────────────────────────────────

/**
 * AgentBrowser — left panel of the StakeDelegation page.
 *
 * Props:
 *   selectedAgent   string | null    currently selected agent address
 *   onSelectAgent   (addr) => void   called when user selects an agent
 */
export default function AgentBrowser({ selectedAgent, onSelectAgent }) {
  const { agents } = useAgentLeaderboard();
  const contracts  = useStore((s) => s.contracts);
  const ds         = contracts?.delegatedStakingContract;

  const [poolData,    setPoolData]    = useState({});
  const [backingData, setBackingData] = useState({});
  const [loadingPool, setLoadingPool] = useState(false);
  const [sortBy,      setSortBy]      = useState('reputation');
  const [filterAccepting, setFilterAccepting] = useState(true);

  // Fetch pool + backing data for all agents
  const fetchPoolData = async () => {
    if (!ds || agents.length === 0) return;
    setLoadingPool(true);
    const newPools   = {};
    const newBacking = {};

    await Promise.allSettled(
      agents.map(async (agent) => {
        const addr = agent.address;
        try {
          const [pool, backing] = await Promise.all([
            ds.getAgentPool(addr),
            ds.getEffectiveBacking(addr),
          ]);
          newPools[addr.toLowerCase()] = {
            totalDelegated:       pool.totalDelegated,
            rewardShareBps:       pool.rewardShareBps,
            delegatorCount:       Number(pool.delegatorCount),
            acceptingDelegations: pool.acceptingDelegations,
          };
          newBacking[addr.toLowerCase()] = backing;
        } catch { /* skip if not available */ }
      })
    );

    setPoolData(newPools);
    setBackingData(newBacking);
    setLoadingPool(false);
  };

  useEffect(() => {
    fetchPoolData();
    const id = setInterval(fetchPoolData, POLL_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, agents.length]);

  // Sort + filter agents
  const displayed = useMemo(() => {
    let list = [...agents];

    if (filterAccepting) {
      list = list.filter((a) => {
        const p = poolData[a.address?.toLowerCase()];
        // If pool data unavailable, show the agent (optimistic default)
        return p == null || p.acceptingDelegations;
      });
    }

    list.sort((a, b) => {
      const pa = poolData[a.address?.toLowerCase()];
      const pb = poolData[b.address?.toLowerCase()];
      if (sortBy === 'backing') {
        const ba = backingData[a.address?.toLowerCase()];
        const bb = backingData[b.address?.toLowerCase()];
        return Number(bb ?? 0n) - Number(ba ?? 0n);
      }
      if (sortBy === 'rewardShare') {
        return Number(pb?.rewardShareBps ?? 0) - Number(pa?.rewardShareBps ?? 0);
      }
      if (sortBy === 'winRate') {
        return (calcWinRate(b) ?? 0) - (calcWinRate(a) ?? 0);
      }
      // Default: reputation
      return (Number(b.reputationScore ?? b.reputation ?? 0)) -
             (Number(a.reputationScore ?? a.reputation ?? 0));
    });

    return list;
  }, [agents, poolData, backingData, sortBy, filterAccepting]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <span className="text-cyan-400">🤖</span>
        <h2 className="text-xs font-bold font-mono uppercase tracking-widest text-gray-100">
          Agent Browser
        </h2>
        <span className="ml-auto text-[10px] font-mono text-gray-500">
          {displayed.length} agent{displayed.length !== 1 ? 's' : ''}
          {loadingPool && <span className="ml-1 text-cyan-400 animate-pulse">•</span>}
        </span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3 flex-shrink-0">
        {/* Sort pills */}
        <div className="flex items-center gap-1 flex-wrap">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={[
                'text-[10px] font-bold font-mono uppercase tracking-wider px-2 py-1 rounded transition-colors',
                sortBy === opt.key
                  ? 'bg-cyan-900 text-cyan-300 border border-cyan-700'
                  : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Accepting filter toggle */}
        <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
          <span className="text-[10px] font-mono text-gray-400">Accepting only</span>
          <div className="relative">
            <input
              type="checkbox"
              checked={filterAccepting}
              onChange={(e) => setFilterAccepting(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-7 h-3.5 bg-gray-700 rounded-full peer-checked:bg-cyan-700 transition-colors" />
            <div className="absolute top-0.5 left-0.5 w-2.5 h-2.5 bg-gray-400 rounded-full peer-checked:translate-x-3.5 peer-checked:bg-cyan-300 transition-all" />
          </div>
        </label>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1">
        {displayed.length === 0 ? (
          <div className="text-center py-8 text-gray-600 text-sm font-mono">
            {filterAccepting
              ? 'No agents currently accepting delegations.'
              : 'No agents registered yet.'}
          </div>
        ) : (
          displayed.map((agent, i) => (
            <AgentBrowserRow
              key={agent.address}
              rank={i + 1}
              agent={agent}
              pool={poolData[agent.address?.toLowerCase()]}
              backing={backingData[agent.address?.toLowerCase()]}
              isSelected={selectedAgent === agent.address}
              onSelect={onSelectAgent}
            />
          ))
        )}
      </div>
    </div>
  );
}
