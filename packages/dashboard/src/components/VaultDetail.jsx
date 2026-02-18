import useStore from '../store/index';
import { fmt } from '../utils/format';

// ── Score history mini line chart ──────────────────────────
function ScoreHistory({ auditHistory }) {
  const pts = (auditHistory || []).slice(-10);
  if (pts.length < 2) return (
    <div className="text-gray-600 text-xs">No audit history yet.</div>
  );
  const scores = pts.map((p) => p.securityScore || 0);
  const min = Math.max(0, Math.min(...scores) - 5);
  const max = Math.min(100, Math.max(...scores) + 5);
  const range = max - min || 1;
  const W = 200, H = 40;
  const xStep = W / (pts.length - 1);
  const ys = scores.map((s) => H - ((s - min) / range) * (H - 6) - 3);
  return (
    <svg width={W} height={H} className="block">
      {pts.slice(1).map((_, i) => (
        <line
          key={i}
          x1={i * xStep} y1={ys[i]}
          x2={(i + 1) * xStep} y2={ys[i + 1]}
          stroke="#22d3ee" strokeWidth="2" strokeLinecap="round"
        />
      ))}
      {pts.map((pt, i) => (
        <circle key={i} cx={i * xStep} cy={ys[i]} r="2.5" fill="#22d3ee" opacity="0.8" />
      ))}
    </svg>
  );
}

// ── Vault balance stacked bar ──────────────────────────────
function VaultBalanceBar({ available, reserved, bounty }) {
  const total = Math.max(1, (Number(available || 0) + Number(reserved || 0) + Number(bounty || 0)));
  const availPct  = (Number(available || 0) / total) * 100;
  const reservPct = (Number(reserved  || 0) / total) * 100;
  const bountyPct = (Number(bounty    || 0) / total) * 100;
  return (
    <div className="h-3 rounded bg-gray-700 overflow-hidden flex mb-2">
      <div className="bg-green-500 transition-all"  style={{ width: `${availPct}%` }}  title="Available" />
      <div className="bg-amber-500 transition-all"  style={{ width: `${reservPct}%` }} title="Reserved" />
      <div className="bg-purple-500 transition-all" style={{ width: `${bountyPct}%` }} title="Bounty" />
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

// ── VaultDetail ────────────────────────────────────────────

export default function VaultDetail({ addr }) {
  const health = useStore((s) => s.contractHealth[addr] || null);

  if (!addr) {
    return (
      <div className="h-full flex items-center justify-center text-gray-600 text-sm font-mono">
        Select a contract to view its health iNFT.
      </div>
    );
  }

  if (!health) {
    return (
      <div className="h-full flex items-center justify-center text-gray-600 text-sm font-mono">
        No vault data available for this contract yet.
      </div>
    );
  }

  const {
    securityScore    = 0,
    totalAudits      = 0,
    lastAudit,
    vaultBalance     = 0,
    vaultReserved    = 0,
    bountyRemaining  = 0,
    monitoringActive = false,
    monitoringAgent,
    weeklyMonitoringRate,
    monitoringStartedAt,
    reauditDue       = false,
    reauditIntervalSeconds,
    weeklyMonitoringBudget,
    criticalBounty,
    auditHistory     = [],
  } = health;

  // Elapsed since last audit (for reaudit countdown)
  const elapsedMs = lastAudit ? Date.now() - lastAudit : 0;
  const intervalMs = (reauditIntervalSeconds || 0) * 1000;
  const reauditPct = intervalMs > 0 ? Math.min(100, (elapsedMs / intervalMs) * 100) : 0;

  const available = Math.max(0, Number(vaultBalance || 0) - Number(vaultReserved || 0));

  return (
    <div className="h-full overflow-y-auto px-4 py-3 font-mono text-xs text-gray-300">

      {/* ── Security Score History ── */}
      <Section title="Security Score History">
        <div className="text-2xl font-bold text-cyan-400 mb-2">{securityScore}/100</div>
        <ScoreHistory auditHistory={auditHistory} />
        <div className="text-gray-500 mt-1">{totalAudits} audit{totalAudits !== 1 ? 's' : ''} recorded</div>
      </Section>

      {/* ── Vault Balance ── */}
      <Section title="Vault Balance">
        <VaultBalanceBar
          available={available}
          reserved={Number(vaultReserved || 0)}
          bounty={Number(bountyRemaining || 0)}
        />
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <div>
            <div className="text-green-400 font-semibold">{fmt.guard(available)}</div>
            <div className="text-gray-600">Available</div>
          </div>
          <div>
            <div className="text-amber-400 font-semibold">{fmt.guard(vaultReserved)}</div>
            <div className="text-gray-600">Reserved</div>
          </div>
          <div>
            <div className="text-purple-400 font-semibold">{fmt.guard(bountyRemaining)}</div>
            <div className="text-gray-600">Bounty</div>
          </div>
        </div>
      </Section>

      {/* ── Monitoring ── */}
      <Section title="Monitoring">
        {monitoringActive ? (
          <div>
            <div className="text-green-400 font-bold mb-1">🛡 Active</div>
            {monitoringAgent && (
              <div className="text-gray-400">Agent: <span className="text-gray-200">{monitoringAgent}</span></div>
            )}
            {weeklyMonitoringRate && (
              <div className="text-gray-400">Weekly rate: <span className="text-amber-400">{fmt.guard(weeklyMonitoringRate)} GUARD</span></div>
            )}
            {monitoringStartedAt && (
              <div className="text-gray-500">Since: {fmt.relativeTime?.(monitoringStartedAt) || '—'}</div>
            )}
          </div>
        ) : (
          <div className="text-gray-600">No active monitoring subscription.</div>
        )}
      </Section>

      {/* ── Audit History ── */}
      <Section title="Audit History">
        {auditHistory.length === 0 ? (
          <div className="text-gray-600">No audits recorded yet.</div>
        ) : (
          <div className="space-y-1">
            {[...auditHistory].reverse().slice(0, 10).map((entry, i) => {
              const prev = auditHistory[auditHistory.length - 2 - i];
              const delta = prev ? entry.securityScore - prev.securityScore : null;
              return (
                <div key={i} className="flex items-center justify-between border-b border-gray-800 pb-1">
                  <span className="text-gray-500">{fmt.timestamp(entry.timestamp)}</span>
                  <span className="text-cyan-400 font-bold">{entry.securityScore}/100</span>
                  {delta != null && (
                    <span className={delta >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {delta >= 0 ? `+${delta}` : delta}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── Re-audit Countdown ── */}
      <Section title="Re-audit Countdown">
        {reauditDue ? (
          <div className="text-amber-400 font-bold animate-pulse">⏱ RE-AUDIT DUE NOW</div>
        ) : intervalMs > 0 ? (
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-gray-500">Elapsed</span>
              <span className="text-gray-400">{Math.round(reauditPct)}%</span>
            </div>
            <div className="h-2 rounded bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded bg-cyan-600 transition-all"
                style={{ width: `${reauditPct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="text-gray-600">On schedule</div>
        )}
      </Section>

      {/* ── Config ── */}
      {(weeklyMonitoringBudget || criticalBounty || reauditIntervalSeconds) && (
        <Section title="Config">
          <div className="grid grid-cols-2 gap-1">
            {weeklyMonitoringBudget && (
              <>
                <span className="text-gray-500">Weekly Budget</span>
                <span className="text-gray-300 text-right">{fmt.guard(weeklyMonitoringBudget)} GUARD</span>
              </>
            )}
            {criticalBounty && (
              <>
                <span className="text-gray-500">Critical Bounty</span>
                <span className="text-gray-300 text-right">{fmt.guard(criticalBounty)} GUARD</span>
              </>
            )}
            {reauditIntervalSeconds && (
              <>
                <span className="text-gray-500">Reaudit Interval</span>
                <span className="text-gray-300 text-right">{fmt.duration(reauditIntervalSeconds)}</span>
              </>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
