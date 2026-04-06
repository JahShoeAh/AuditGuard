/**
 * ExchangeWidget — displays GUARD ↔ HBAR exchange rate info for
 * GuardExchange (constant-product AMM) and HbarPool (fixed rate).
 *
 * Rates are read from the events-api audit_events table — the orchestrator
 * broadcasts EXCHANGE_RATE_UPDATE events via HCS whenever reserves change.
 * Falls back to showing the contract addresses for direct Hashscan inspection.
 */
import { useMemo } from 'react';
import { motion } from 'framer-motion';
import useStore from '../store';

function RateCard({ title, icon, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="border border-gray-800 rounded-lg p-4 flex flex-col gap-3"
      style={{ background: 'rgba(17,24,39,0.6)' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{icon}</span>
        <span className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-400">
          {title}
        </span>
      </div>
      {children}
    </motion.div>
  );
}

function StatRow({ label, value, accent }) {
  return (
    <div className="flex items-center justify-between text-xs font-mono">
      <span className="text-gray-500">{label}</span>
      <span style={{ color: accent || 'var(--accent-cyan)' }} className="font-bold">
        {value}
      </span>
    </div>
  );
}

export default function ExchangeWidget() {
  const hssEvents = useStore((s) => s.hssEvents ?? []);

  // Look for the latest EXCHANGE_RATE_UPDATE event broadcast by the orchestrator
  const latestRate = useMemo(() => {
    const ev = [...hssEvents]
      .reverse()
      .find((e) => e.type === 'EXCHANGE_RATE_UPDATE' || e.type === 'HSS_EXCHANGE_RATE_UPDATE');
    return ev ?? null;
  }, [hssEvents]);

  const hbarReserve  = latestRate?.hbarReserve  ?? null;
  const guardReserve = latestRate?.guardReserve  ?? null;
  const spotRate     = latestRate?.spotRate      ?? null; // GUARD per 1 HBAR

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-3">
        <span className="text-[10px] font-bold font-mono uppercase tracking-wider text-gray-500">
          GUARD ↔ HBAR EXCHANGE
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* HbarPool — fixed rate */}
        <RateCard title="HbarPool — Fixed Rate Converter" icon="🏦">
          <StatRow label="Rate" value="1 HBAR = 100 GUARD" accent="var(--accent-green)" />
          <StatRow label="Direction" value="HBAR → GUARD only" accent="var(--accent-amber)" />
          <p className="text-[10px] font-mono text-gray-600 leading-relaxed">
            Fixed-rate conversion at 100 GUARD per 1 HBAR (1×10⁸ tinybars).
            Useful for bootstrapping liquidity without price slippage.
          </p>
        </RateCard>

        {/* GuardExchange — AMM */}
        <RateCard title="GuardExchange — Constant-Product AMM" icon="⚡">
          {spotRate !== null ? (
            <>
              <StatRow label="Spot rate" value={`1 HBAR ≈ ${Number(spotRate).toFixed(4)} GUARD`} accent="var(--accent-cyan)" />
              {hbarReserve  !== null && <StatRow label="HBAR reserves"  value={`${Number(hbarReserve).toLocaleString()} HBAR`}  accent="var(--accent-amber)" />}
              {guardReserve !== null && <StatRow label="GUARD reserves" value={`${Number(guardReserve).toLocaleString()} GUARD`} accent="var(--accent-purple)" />}
            </>
          ) : (
            <p className="text-[10px] font-mono text-gray-600 leading-relaxed">
              Live rates not yet broadcast. The orchestrator publishes{' '}
              <span className="text-cyan-500">EXCHANGE_RATE_UPDATE</span> events when
              trades occur. Reserves will appear here automatically.
            </p>
          )}
          <p className="text-[10px] font-mono text-gray-600 leading-relaxed">
            Bidirectional HBAR ↔ GUARD swaps via x·y=k invariant with 0.30% fee.
            Price impact scales with trade size vs. pool depth.
          </p>
        </RateCard>

        {/* Legend */}
        <div className="text-[10px] font-mono text-gray-700 border-t border-gray-900 pt-3">
          Rates sourced from on-chain events. GUARD token has 8 decimal places (not 18).
          Use <span className="text-cyan-600">HbarPool</span> for predictable conversions;
          use <span className="text-cyan-600">GuardExchange</span> for market-rate swaps.
        </div>
      </div>
    </div>
  );
}
