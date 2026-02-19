import { useMemo } from 'react';
import useStore from '../store';
import { useGuardFlows } from '../hooks/useGuardFlows';
import { hashscan } from '../utils/hashscan';

// ── Stat row ─────────────────────────────────────────────

function StatRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[9px] text-gray-600 font-sans">{label}</span>
      <span className="text-[10px] font-mono font-semibold" style={{ color: color || '#9ca3af' }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Main FlowSummary ──────────────────────────────────────

export default function FlowSummary() {
  const auditLog = useStore((s) => s.auditLog);
  const config   = useStore((s) => s.config);

  const { flowsByType, totalTransacted } = useGuardFlows(600);

  const avgFinalityS = useMemo(() => {
    const entries = auditLog.filter((e) => e._tx?.finalityMs > 0);
    if (entries.length === 0) return null;
    const avg = entries.reduce((s, e) => s + e._tx.finalityMs, 0) / entries.length / 1000;
    return avg.toFixed(1);
  }, [auditLog]);

  const txCount = auditLog.filter((e) => e._tx?.hash).length;

  const auditAmt   = (flowsByType?.['MAIN_AUDIT']    || 0) + (flowsByType?.['SETTLEMENT'] || 0) + (flowsByType?.['BONUS_SPEED'] || 0);
  const subAmt     = flowsByType?.['SUB_CONTRACT']  || 0;
  const dataAmt    = flowsByType?.['DATA_PURCHASE'] || 0;
  const feeAmt     = flowsByType?.['PLATFORM_FEE']  || 0;
  const reportAmt  = flowsByType?.['REPORT_FEE']    || 0;

  const fmt = (v) => v > 0 ? `${v.toFixed(2)}` : '0';

  const guardTokenId = config?.guardTokenId;

  return (
    <div className="w-[148px] flex-shrink-0 border-l border-white/[0.04] px-3 py-2.5 flex flex-col gap-1.5 overflow-hidden">
      {/* Section label */}
      <span className="text-[9px] text-gray-600 uppercase tracking-wider font-sans">10-min summary</span>

      <div className="space-y-px">
        <StatRow label="Audit pays"  value={fmt(auditAmt)}  color="var(--accent-gold)"   />
        <StatRow label="Sub-CTR"     value={fmt(subAmt)}    color="#a855f7"              />
        <StatRow label="Data sales"  value={fmt(dataAmt)}   color="#14b8a6"              />
        <StatRow label="Plat. fees"  value={fmt(feeAmt)}    color="#6b7280"              />
        <StatRow label="Report fees" value={fmt(reportAmt)} color="#9ca3af"              />
      </div>

      {/* Divider */}
      <div className="border-t border-white/[0.04]" />

      <StatRow
        label="Total"
        value={`${fmt(totalTransacted)} GUARD`}
        color="var(--accent-gold)"
      />

      <div className="space-y-px">
        {txCount > 0 && (
          <StatRow label="On-chain txs" value={txCount} />
        )}
        {avgFinalityS && (
          <StatRow label="Avg finality" value={`${avgFinalityS}s`} color="var(--accent-green)" />
        )}
      </div>

      {/* HashScan links */}
      <div className="border-t border-white/[0.04] pt-1 flex items-center gap-2 flex-wrap">
        {guardTokenId && (
          <a
            href={hashscan.token(guardTokenId)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] text-gray-700 hover:text-guard-cyan transition-colors font-mono truncate"
          >
            GUARD↗
          </a>
        )}
        {guardTokenId && <span className="text-gray-800 text-[8px]">·</span>}
        <a
          href={hashscan.networkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[9px] text-gray-700 hover:text-guard-cyan transition-colors font-mono"
        >
          HashScan↗
        </a>
      </div>
    </div>
  );
}
