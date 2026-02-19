import { useState, useEffect, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { Link } from 'react-router-dom';
import useStore from '../store/index';
import useWalletStore from '../store/wallet';
import { useContractWrite } from '../hooks/useContractWrite';
import { useToast } from './ui/Toast';
import { fmt } from '../utils/format';
import { hashscan } from '../utils/hashscan';
import ReputationGraph from './ReputationGraph';
import StakingChart from './StakingChart';

// GUARD uses 8 decimal places on Hedera (same precision as DelegatedStaking).
function fmtG(raw) {
  if (raw == null) return '0.00';
  try { return parseFloat(formatUnits(BigInt(raw.toString()), 8)).toFixed(2); } catch { return '0.00'; }
}

// ── Slash reason labels + colors ───────────────────────────
const SLASH_REASON_CONFIG = [
  { label: 'FALSE_POSITIVE',   bg: 'bg-amber-900',  text: 'text-amber-300' },
  { label: 'FALSE_NEGATIVE',   bg: 'bg-orange-900', text: 'text-orange-300' },
  { label: 'MALICIOUS_REPORT', bg: 'bg-red-900',    text: 'text-red-300' },
  { label: 'SLA_VIOLATION',    bg: 'bg-yellow-900', text: 'text-yellow-300' },
  { label: 'COLLUSION',        bg: 'bg-red-950',    text: 'text-red-400' },
  { label: 'PLAGIARISM',       bg: 'bg-purple-900', text: 'text-purple-300' },
];

function SlashReasonBadge({ reason }) {
  const cfg = SLASH_REASON_CONFIG[reason] || { label: `REASON_${reason}`, bg: 'bg-gray-800', text: 'text-gray-400' };
  return (
    <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

// ── Appeal status badge ────────────────────────────────────
const APPEAL_CONFIG = {
  NONE:     { label: 'No Appeal',  classes: 'text-gray-500' },
  PENDING:  { label: 'Pending',    classes: 'text-amber-400' },
  APPROVED: { label: 'Approved',   classes: 'text-green-400' },
  DENIED:   { label: 'Denied',     classes: 'text-red-400' },
};

// ── Tier label ─────────────────────────────────────────────
const TIER_LABELS = ['COMMODITY', 'SPECIALIZED', 'PREMIUM'];
const TIER_BADGE  = [
  'bg-gray-700 text-gray-300',
  'bg-cyan-900 text-cyan-300',
  'bg-amber-900 text-amber-300',
];

// ── Stacked stake bar ──────────────────────────────────────
function StakeBar({ effective, locked, available }) {
  const total = Math.max(1, effective || 0);
  const lockedPct = Math.min(100, ((locked || 0) / total) * 100);
  const availPct  = Math.min(100 - lockedPct, ((available || 0) / total) * 100);
  return (
    <div className="h-3 rounded bg-gray-700 overflow-hidden flex">
      <div className="bg-green-500 transition-all" style={{ width: `${availPct}%` }} title="Available" />
      <div className="bg-amber-500 transition-all" style={{ width: `${lockedPct}%` }} title="Locked" />
    </div>
  );
}

// ── Section wrapper ────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 border-b border-gray-800 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── AgentDetail ────────────────────────────────────────────

export default function AgentDetail({ addr }) {
  const profile       = useStore((s) => s.agents[addr] || {});
  const enriched      = useStore((s) => s.agentProfiles[addr] || {});
  const history       = useStore((s) => s.reputationHistory[addr] || []);
  const jobBidStatus  = useStore((s) => s.jobBidStatus || {});
  const llmProviderStatus = useStore((s) => s.llmProviderStatus || {});
  const llmInferenceStatus = useStore((s) => s.llmInferenceStatus || {});
  const allSlashes    = useStore((s) => s.slashEvents);
  const mySlashes     = allSlashes.filter((e) => e.agent?.toLowerCase() === addr?.toLowerCase());

  const contracts      = useStore((s) => s.contracts);
  const walletAddress  = useWalletStore((s) => s.address);
  const [poolData,     setPoolData]     = useState(null);
  const [myDelegation, setMyDelegation] = useState(null);

  useEffect(() => {
    const ds = contracts?.delegatedStakingContract;
    if (!ds || !addr) return;
    let cancelled = false;
    (async () => {
      try {
        const pool = await ds.getAgentPool(addr);
        if (!cancelled) setPoolData({
          totalDelegated:       pool.totalDelegated,
          rewardShareBps:       pool.rewardShareBps,
          delegatorCount:       Number(pool.delegatorCount),
          acceptingDelegations: pool.acceptingDelegations,
        });
      } catch { /* contract not deployed */ }
      if (walletAddress) {
        try {
          const del = await ds.getDelegation(walletAddress, addr);
          if (!cancelled && del.amount > 0n) {
            setMyDelegation({ amount: del.amount });
          }
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [contracts, addr, walletAddress]);

  // ── Owner-specific state ─────────────────────────────────
  const signer  = useWalletStore((s) => s.signer);
  const isOwner = !!(walletAddress && addr && walletAddress.toLowerCase() === addr.toLowerCase());

  const { execute: execWrite, status: writeStatus } = useContractWrite();
  const toast = useToast();

  const [ucpTestStatus,  setUcpTestStatus]  = useState('idle');
  const [ucpTestLatency, setUcpTestLatency] = useState(null);

  const handleUcpTest = useCallback(async () => {
    const ep = profile.ucpEndpoint;
    if (!ep) return;
    setUcpTestStatus('pending');
    setUcpTestLatency(null);
    const healthUrl = ep.replace(/\/$/, '') + '/health';
    const start = Date.now();
    try {
      const res = await fetch(healthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'HEALTH_CHECK' }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        setUcpTestStatus('ok');
        setUcpTestLatency(Date.now() - start);
      } else {
        setUcpTestStatus('fail');
      }
    } catch (err) {
      setUcpTestStatus(err?.name === 'TypeError' ? 'cors' : 'fail');
    }
  }, [profile.ucpEndpoint]);

  const handleEnableDelegation = useCallback(async () => {
    const ds = contracts?.delegatedStakingContract;
    if (!ds || !signer) { toast.error('Wallet not connected.'); return; }
    try {
      await execWrite(ds, 'enableDelegation', []);
      toast.success('Delegation enabled! Backers can now delegate GUARD to your agent.');
    } catch (err) {
      toast.error(`Failed: ${err?.message?.slice(0, 80) || 'Unknown error'}`);
    }
  }, [contracts, signer, execWrite, toast]);

  if (!addr) {
    return (
      <div className="h-full flex items-center justify-center text-gray-600 text-sm font-mono">
        Select an agent from the leaderboard to view their iNFT profile.
      </div>
    );
  }

  const repRaw   = profile.reputationScore || profile.reputation || 0;
  const repNum   = Number(repRaw) / 100;
  const tier     = profile.tier ?? 0;
  const tierLabel = TIER_LABELS[tier] || 'COMMODITY';
  const tierBadge = TIER_BADGE[tier] || TIER_BADGE[0];

  const effectiveStake = enriched.effectiveStake || profile.stakedAmount || 0n;
  const lockedStake    = enriched.lockedStake || 0n;
  const available      = enriched.availableStake
    || (BigInt(effectiveStake || 0) - BigInt(lockedStake || 0) > 0n
        ? BigInt(effectiveStake || 0) - BigInt(lockedStake || 0)
        : 0n);

  const completedJobs      = profile.completedJobs      || 0;
  const successfulFindings = profile.successfulFindings || 0;
  const falsePositives     = profile.falsePositives     || 0;
  const falseNegatives     = profile.falseNegatives     || 0;
  const bidPipeline = Object.entries(jobBidStatus)
    .flatMap(([jobId, entries]) =>
      (entries || []).map((entry) => ({ ...entry, jobId }))
    )
    .filter((entry) => {
      const idMatch = (entry.agentId || '').toLowerCase() === (profile.agentId || '').toLowerCase();
      const addrMatch = (entry.evmAddress || '').toLowerCase() === (addr || '').toLowerCase();
      return idMatch || addrMatch;
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 8);
  const accuracy = completedJobs > 0
    ? ((successfulFindings / Math.max(1, successfulFindings + falsePositives)) * 100).toFixed(1)
    : '—';
  const providerEvents = llmProviderStatus[profile.agentId || ''] || [];
  const latestProviderEvent = providerEvents[0] || null;
  const inferenceEvents = Object.entries(llmInferenceStatus)
    .flatMap(([jobId, entries]) =>
      (entries || []).map((entry) => ({ ...entry, jobId }))
    )
    .filter((entry) => (entry.agentId || '').toLowerCase() === (profile.agentId || '').toLowerCase())
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 6);

  return (
    <div className="h-full overflow-y-auto px-4 py-3 font-mono text-xs text-gray-300">

      {/* ── Owner: Agent Status ────────────────────────────── */}
      {isOwner && (
        <Section title="Your Agent Status">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 font-semibold text-[11px]">Registered &amp; Active</span>
          </div>

          {/* UCP endpoint */}
          {profile.ucpEndpoint ? (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-gray-500 flex-shrink-0">UCP Endpoint</span>
                <button
                  type="button"
                  onClick={handleUcpTest}
                  disabled={ucpTestStatus === 'pending'}
                  className="ml-auto flex-shrink-0 text-[10px] font-bold font-mono uppercase px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors"
                >
                  {ucpTestStatus === 'pending' ? '…' : 'Test'}
                </button>
              </div>
              <div className="text-cyan-400 break-all text-[11px]">{profile.ucpEndpoint}</div>
              {ucpTestStatus !== 'idle' && (
                <div className={`text-[11px] mt-1 font-mono ${
                  ucpTestStatus === 'ok'      ? 'text-green-400' :
                  ucpTestStatus === 'pending' ? 'text-cyan-400 animate-pulse' :
                  ucpTestStatus === 'cors'    ? 'text-amber-400' : 'text-red-400'
                }`}>
                  {ucpTestStatus === 'ok'      && `✓ Agent responded (${ucpTestLatency}ms)`}
                  {ucpTestStatus === 'pending' && 'Testing…'}
                  {ucpTestStatus === 'cors'    && '⚠ CORS blocked — agent may still be reachable from Hedera network'}
                  {ucpTestStatus === 'fail'    && '✗ No response — is your agent running?'}
                </div>
              )}
            </div>
          ) : (
            <div className="text-gray-600 mb-3">UCP endpoint not set.</div>
          )}

          {/* Job stats snapshot */}
          <div className="grid grid-cols-2 gap-1 mb-3">
            <span className="text-gray-500">Last active</span>
            <span className="text-gray-300 text-right">
              {profile.lastActiveAt && Number(profile.lastActiveAt) > 0
                ? fmt.relativeTime(Number(profile.lastActiveAt) * 1000)
                : 'No jobs yet'}
            </span>
            <span className="text-gray-500">Jobs completed</span>
            <span className="text-gray-300 text-right">{profile.completedJobs || 0}</span>
          </div>

          {/* Enable Delegations toggle */}
          <div className="border border-gray-700 rounded-lg p-3 bg-gray-900">
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-300 font-semibold">Accept Delegations</span>
              {poolData?.acceptingDelegations ? (
                <span className="text-[10px] font-bold text-green-400 bg-green-400/10 px-2 py-0.5 rounded">ENABLED</span>
              ) : (
                <span className="text-[10px] font-bold text-gray-500 bg-gray-800 px-2 py-0.5 rounded">DISABLED</span>
              )}
            </div>
            <p className="text-gray-600 text-[11px] mb-2">
              Allow GUARD holders to back your agent and share in rewards.
            </p>
            {!poolData?.acceptingDelegations && (
              <button
                type="button"
                onClick={handleEnableDelegation}
                disabled={writeStatus === 'confirming'}
                className="w-full py-1.5 text-[11px] font-bold font-mono uppercase tracking-wider rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors"
              >
                {writeStatus === 'confirming' ? '⏳ Enabling…' : 'Enable Delegations →'}
              </button>
            )}
          </div>
        </Section>
      )}

      {/* ── Identity ── */}
      <Section title="Identity">
        <div className="text-sm font-bold text-gray-100 mb-1">
          {profile.name || profile.agentId || fmt.address(addr)}
        </div>
        <div className="flex items-center gap-2 mb-1">
          <a
            href={hashscan.account(addr)}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-400 hover:underline truncate text-xs"
          >
            {addr}
          </a>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${tierBadge}`}>
            {tierLabel}
          </span>
        </div>
        {profile.ucpEndpoint && (
          <div className="text-gray-500">UCP: <span className="text-gray-400">{profile.ucpEndpoint}</span></div>
        )}
        {enriched.stakeStatus && (
          <div className="mt-1">
            Status:{' '}
            <span className={
              enriched.stakeStatus === 'ACTIVE' ? 'text-green-400' :
              enriched.stakeStatus === 'UNBONDING' ? 'text-amber-400' : 'text-red-400'
            }>
              {enriched.stakeStatus}
            </span>
          </div>
        )}
      </Section>

      {profile.agentId === 'llm-contextual-003' && (
        <Section title="0g Inference">
          <div className="grid grid-cols-2 gap-1 mb-2">
            <span className="text-gray-500">Provider status</span>
            <span className={`text-right ${
              latestProviderEvent?.status === 'ready' ? 'text-green-400' :
              latestProviderEvent?.status === 'unhealthy' ? 'text-red-400' : 'text-gray-500'
            }`}>
              {latestProviderEvent?.status || 'unknown'}
            </span>
            <span className="text-gray-500">Provider</span>
            <span className="text-right text-gray-400 truncate">{latestProviderEvent?.providerAddress || '—'}</span>
            <span className="text-gray-500">Model</span>
            <span className="text-right text-gray-400 truncate">{latestProviderEvent?.model || '—'}</span>
          </div>
          <div className="space-y-1">
            {inferenceEvents.length === 0 ? (
              <div className="text-gray-600">No inference events yet.</div>
            ) : (
              inferenceEvents.map((entry, idx) => (
                <div key={`${entry.jobId}-${idx}`} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-gray-500">Job #{entry.jobId}</span>
                  <span className={`font-semibold ${
                    entry.status === 'succeeded' ? 'text-green-400' :
                    entry.status === 'failed' ? 'text-red-400' : 'text-cyan-400'
                  }`}>
                    {entry.status}
                  </span>
                  <span className="text-gray-500 truncate max-w-[45%]">
                    {entry.reason || entry.reasonCode || entry.model || '—'}
                  </span>
                </div>
              ))
            )}
          </div>
        </Section>
      )}

      {/* ── Reputation ── */}
      <Section title="Reputation">
        <ReputationGraph history={history} currentReputation={repRaw} />
        {history.length > 0 && (
          <div className="text-gray-500 mt-1 text-[10px]">
            Last update:{' '}
            <span className="text-gray-400">{fmt.relativeTime(history[history.length - 1]?.timestamp)}</span>
          </div>
        )}
      </Section>

      {/* ── Staking History ── */}
      <Section title="Staking History">
        <StakingChart addr={addr} />
      </Section>

      {/* ── Staking ── */}
      <Section title="Staking">
        <StakeBar
          effective={Number(effectiveStake || 0)}
          locked={Number(lockedStake || 0)}
          available={Number(available || 0)}
        />
        <div className="flex justify-between mt-1.5">
          <span className="text-green-400">Available: {fmt.guard(available)} GUARD</span>
          <span className="text-amber-400">Locked: {fmt.guard(lockedStake)} GUARD</span>
        </div>
        <div className="text-gray-400 mt-1">
          Effective total: <span className="text-gray-200">{fmt.guard(effectiveStake)} GUARD</span>
        </div>
      </Section>

      {/* ── Delegation Pool ── */}
      <Section title="Delegation Pool">
        {poolData ? (
          <div>
            <div className="grid grid-cols-2 gap-1">
              <span className="text-gray-500">Total Delegated</span>
              <span className="text-amber-300 text-right font-semibold">{fmtG(poolData.totalDelegated)} GUARD</span>
              <span className="text-gray-500">Delegators</span>
              <span className="text-gray-300 text-right">{poolData.delegatorCount}</span>
              <span className="text-gray-500">Reward Share</span>
              <span className="text-green-400 text-right font-semibold">
                {(Number(poolData.rewardShareBps) / 100).toFixed(0)}%
              </span>
              <span className="text-gray-500">Accepting</span>
              <span className={`text-right font-semibold ${poolData.acceptingDelegations ? 'text-green-400' : 'text-red-400'}`}>
                {poolData.acceptingDelegations ? '✓ Yes' : '✗ Closed'}
              </span>
              {myDelegation && (
                <>
                  <span className="text-gray-500">Your Stake</span>
                  <span className="text-cyan-300 text-right font-semibold">{fmtG(myDelegation.amount)} GUARD</span>
                </>
              )}
            </div>
            <Link
              to={`/dashboard/stake?agent=${addr}`}
              className="mt-3 flex items-center justify-center gap-1.5 w-full text-[10px] font-bold uppercase tracking-wider font-mono py-2 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
            >
              💎 Delegate to this Agent
            </Link>
          </div>
        ) : (
          <div className="text-gray-600">
            Delegation data unavailable.{' '}
            <Link to={`/dashboard/stake?agent=${addr}`} className="text-cyan-500 hover:underline">
              Open delegation page →
            </Link>
          </div>
        )}
      </Section>

      {/* ── Performance ── */}
      <Section title="Performance">
        <div className="grid grid-cols-2 gap-1">
          <span className="text-gray-500">Completed Jobs</span>
          <span className="text-gray-200 text-right">{completedJobs}</span>
          <span className="text-gray-500">Successful Findings</span>
          <span className="text-gray-200 text-right">{successfulFindings}</span>
          <span className="text-gray-500">Accuracy</span>
          <span className="text-gray-200 text-right">{accuracy}%</span>
          <span className="text-gray-500">False Positives</span>
          <span className="text-red-400 text-right">{falsePositives}</span>
          <span className="text-gray-500">False Negatives</span>
          <span className="text-red-400 text-right">{falseNegatives}</span>
        </div>
      </Section>

      {/* ── Bid Pipeline ── */}
      <Section title="Bid Pipeline">
        {bidPipeline.length === 0 ? (
          <div className="text-gray-600">No invite/bid lifecycle events yet.</div>
        ) : (
          <div className="space-y-1.5">
            {bidPipeline.map((entry, idx) => (
              <div key={`${entry.jobId}-${idx}`} className="flex items-start justify-between gap-2">
                <span className="text-gray-500">Job #{entry.jobId}</span>
                <span className="text-right">
                  <span className={
                    entry.status === 'submitted' ? 'text-green-400' :
                    entry.status === 'failed' ? 'text-red-400' :
                    entry.status === 'skipped' ? 'text-amber-400' :
                    'text-cyan-400'
                  }>
                    {(entry.status || 'invite_sent').replace('_', ' ').toUpperCase()}
                  </span>
                  {entry.reason && (
                    <span className="block text-gray-500 text-[10px] max-w-[220px] truncate">
                      {entry.reason}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Slash History ── */}
      <Section title="Slash History">
        {mySlashes.length === 0 ? (
          <div className="text-gray-600">No slashes recorded.</div>
        ) : (
          <div className="space-y-2">
            {mySlashes.map((slash) => {
              const ac = APPEAL_CONFIG[slash.appealStatus] || APPEAL_CONFIG.NONE;
              return (
                <div key={slash.slashId} className="border border-gray-800 rounded p-2">
                  <div className="flex items-center justify-between mb-1">
                    <SlashReasonBadge reason={slash.reason} />
                    <span className="text-red-400 font-semibold">{slash.slashedAmountFormatted || '—'}</span>
                  </div>
                  <div className="text-gray-500 flex gap-3">
                    <span>Job #{slash.jobId || '—'}</span>
                    <span className={ac.classes}>Appeal: {ac.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── Fee Discount ── */}
      <Section title="Fee Discount">
        {enriched.discount ? (
          <div>
            <div className={`font-bold mb-2 ${enriched.discount.eligible ? 'text-yellow-400' : 'text-gray-500'}`}>
              {enriched.discount.eligible ? '✦ Eligible' : '✗ Not Eligible'}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <span className="text-gray-500">Current Stake</span>
              <span className="text-gray-300 text-right">{fmt.guard(enriched.discount.currentStake)} GUARD</span>
              <span className="text-gray-500">Current Reputation</span>
              <span className="text-gray-300 text-right">
                {enriched.discount.currentReputation
                  ? (Number(enriched.discount.currentReputation) / 100).toFixed(2)
                  : '—'}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-gray-600">Discount data unavailable (live mode only).</div>
        )}
      </Section>
    </div>
  );
}
