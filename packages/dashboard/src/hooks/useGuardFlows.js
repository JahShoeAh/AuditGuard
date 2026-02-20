import { useMemo } from 'react';
import useStore from '../store';

// ── Flow type → hex color (CSS vars don't work in SVG fill/stroke) ──

export const FLOW_COLORS = {
  BID_COLLATERAL_LOCK:    '#0ea5e9',
  BID_COLLATERAL_REFUND:  '#38bdf8',
  WINNER_PAYOUT:          '#d97706',
  SLASH_TO_TREASURY:      '#ef4444',
  SUB_CONTRACT:          '#a855f7',
  DATA_PURCHASE_NET:     '#14b8a6',
  SETTLEMENT:            '#d97706',
  MAIN_AUDIT:            '#d97706',
  BONUS_SPEED:           '#22c55e',
  BONUS_UNIQUE_FINDING:  '#4ade80',
  PLATFORM_FEE:          '#6b7280',
  REPORT_FEE:            '#6366f1',
};

export function getFlowColor(type) {
  return FLOW_COLORS[type] || '#06b6d4';
}

// ── Agent node color by name heuristic ──────────────────────

function agentColor(name) {
  if (name.includes('Static') || name.includes('Scanner'))   return '#22c55e';
  if (name.includes('Fuzzer'))                                return '#f59e0b';
  if (name.includes('LLM') || name.includes('Contextual'))   return '#a855f7';
  if (name.includes('DependencyAgent') || name.includes('Dependency')) return '#f97316'; // orange
  if (name.includes('Dep'))                                   return '#6366f1';
  return '#06b6d4';
}

// ── Main hook ────────────────────────────────────────────────

export function useGuardFlows(windowSeconds = 120) {
  const guardFlows = useStore((s) => s.guardFlows);
  const config     = useStore((s) => s.config);

  const { recentFlows, agentAddresses } = useMemo(() => {
    const cutoff = Date.now() - windowSeconds * 1000;
    const recent = guardFlows.filter((f) => (f.timestamp || 0) >= cutoff);

    const addrs = new Set();
    for (const f of recent) {
      if (f.from) addrs.add(typeof f.from === 'string' ? f.from.toLowerCase() : f.from);
      if (f.to)   addrs.add(typeof f.to   === 'string' ? f.to.toLowerCase()   : f.to);
    }
    return { recentFlows: recent, agentAddresses: addrs };
  }, [guardFlows, windowSeconds]);

  // Build a name map from flow toName/fromName so unknown addresses get proper labels
  const flowNameMap = useMemo(() => {
    const map = new Map();
    for (const f of guardFlows) {
      if (f.from && f.fromName) map.set(f.from.toLowerCase(), f.fromName);
      if (f.to   && f.toName)   map.set(f.to.toLowerCase(),   f.toName);
    }
    return map;
  }, [guardFlows]);

  // Build agent node list from seededAgents + any unknown addresses in flows.
  // Vault is always included as the settlement hub.
  const agentNodes = useMemo(() => {
    const nodes = [
      { address: 'vault', name: 'Vault', color: '#d97706' },
    ];
    const seen = new Set(['vault']);

    const seeded = config?.seededAgents || {};
    for (const [name, info] of Object.entries(seeded)) {
      const addr = info.evmAddress?.toLowerCase() || name;
      nodes.push({ address: addr, name, color: agentColor(name) });
      seen.add(addr);
    }

    // Any addresses from flows not yet represented
    for (const addr of agentAddresses) {
      if (seen.has(addr)) continue;
      const name = flowNameMap.get(addr) || `${addr.slice(0, 6)}…`;
      nodes.push({ address: addr, name, color: agentColor(name) });
      seen.add(addr);
    }

    return nodes;
  }, [agentAddresses, config, flowNameMap]);

  const flowsByType = useMemo(() => {
    const map = {};
    for (const f of recentFlows) {
      map[f.type] = (map[f.type] || 0) + (Number(f.amount) / 1e8 || 0);
    }
    return map;
  }, [recentFlows]);

  const windowTotal = useMemo(
    () => recentFlows.reduce((sum, f) => sum + (Number(f.amount) / 1e8 || 0), 0),
    [recentFlows]
  );
  const lifetimeTotal = useMemo(
    () => guardFlows.reduce((sum, f) => sum + (Number(f.amount) / 1e8 || 0), 0),
    [guardFlows]
  );

  return {
    recentFlows,
    agentNodes,
    totalTransacted: lifetimeTotal,
    windowTransacted: windowTotal,
    flowsByType,
  };
}
