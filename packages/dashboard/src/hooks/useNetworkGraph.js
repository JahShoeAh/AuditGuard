import { useMemo } from 'react';
import useStore from '../store/index';
import { fmt } from '../utils/format';
import { FLOW_COLORS } from './useGuardFlows';

// ── Agent color heuristic (reuses PaymentFlow's logic) ──────
function agentColor(name = '') {
  if (name.includes('Static') || name.includes('Scanner'))          return '#22c55e';
  if (name.includes('Fuzzer'))                                       return '#f59e0b';
  if (name.includes('LLM') || name.includes('Contextual'))          return '#a855f7';
  if (name.includes('DependencyAgent') || name.includes('Dep'))     return '#f97316';
  return '#06b6d4';
}

// ── Normalise address to canonical form ─────────────────────
function canonical(addr) {
  if (!addr) return '';
  if (addr === 'vault' || addr === 'treasury') return addr;
  return addr.toLowerCase();
}

// ── Map treasury address → 'treasury' id ────────────────────
function resolveId(addr, treasuryAddress) {
  if (!addr) return '';
  if (addr === 'vault') return 'vault';
  if (canonical(addr) === canonical(treasuryAddress)) return 'treasury';
  return canonical(addr);
}

// ── useNetworkGraph ──────────────────────────────────────────

/**
 * Returns { nodes: GraphNode[], edges: GraphEdge[] }
 *
 * GraphNode: { id, label, type, color, radius, tier, reputation, earned }
 * GraphEdge: { id, source, target, type, color, totalAmount, count,
 *              lastTimestamp, isRecent }
 */
export function useNetworkGraph() {
  const agents      = useStore((s) => s.agents);
  const guardFlows  = useStore((s) => s.guardFlows);
  const config      = useStore((s) => s.config);

  return useMemo(() => {
    const now = Date.now();
    const RECENT_WINDOW = 120_000; // 2 minutes

    const treasuryAddress =
      config?.contracts?.treasury?.evmAddress ||
      config?.contracts?.treasury?.address ||
      'treasury';

    // ── Nodes ─────────────────────────────────────────────

    const nodeMap = new Map();

    // Special: Vault (settlement hub)
    nodeMap.set('vault', {
      id: 'vault',
      label: 'Vault',
      type: 'vault',
      color: '#d97706',
      radius: 20,
      tier: -1,
      reputation: 0,
      earned: 0,
    });

    // Special: Treasury
    nodeMap.set('treasury', {
      id: 'treasury',
      label: 'Treasury',
      type: 'treasury',
      color: '#6b7280',
      radius: 16,
      tier: -1,
      reputation: 0,
      earned: 0,
    });

    // Registered agents from store
    for (const [addr, agent] of Object.entries(agents)) {
      const id = canonical(addr);
      nodeMap.set(id, {
        id,
        label: agent.name || agent.agentId || fmt.address(addr),
        type: 'agent',
        tier: agent.tier ?? 0,
        reputation: agent.reputationScore || 0,
        color: agentColor(agent.name || ''),
        radius: 14,  // will be updated after flows are aggregated
        earned: 0,
      });
    }

    // Seeded agents from config (if not in store yet)
    const seeded = config?.seededAgents || {};
    for (const [name, info] of Object.entries(seeded)) {
      const id = canonical(info.evmAddress || name);
      if (!nodeMap.has(id)) {
        nodeMap.set(id, {
          id,
          label: name,
          type: 'agent',
          tier: 0,
          reputation: 0,
          color: agentColor(name),
          radius: 14,
          earned: 0,
        });
      }
    }

    // ── Edges (aggregate guardFlows by from→to:type) ──────

    const edgeMap = new Map();

    for (const flow of guardFlows) {
      const srcId = resolveId(flow.from, treasuryAddress);
      const dstId = resolveId(flow.to, treasuryAddress);
      if (!srcId || !dstId || srcId === dstId) continue;

      // Ensure unknown endpoints have a node
      if (!nodeMap.has(srcId)) {
        nodeMap.set(srcId, {
          id: srcId, label: flow.fromName || fmt.address(flow.from),
          type: 'agent', tier: 0, reputation: 0,
          color: agentColor(flow.fromName || ''), radius: 12, earned: 0,
        });
      }
      if (!nodeMap.has(dstId)) {
        nodeMap.set(dstId, {
          id: dstId, label: flow.toName || fmt.address(flow.to),
          type: 'agent', tier: 0, reputation: 0,
          color: agentColor(flow.toName || ''), radius: 12, earned: 0,
        });
      }

      // Accumulate earned on destination node
      const dstNode = nodeMap.get(dstId);
      if (dstNode) {
        dstNode.earned = (dstNode.earned || 0) + Number(flow.amount || 0);
      }

      // Edge key: source→target:type
      const edgeKey = `${srcId}→${dstId}:${flow.type}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          id: edgeKey,
          source: srcId,
          target: dstId,
          type: flow.type,
          color: FLOW_COLORS[flow.type] || '#6b7280',
          totalAmount: 0,
          count: 0,
          lastTimestamp: 0,
        });
      }
      const edge = edgeMap.get(edgeKey);
      edge.totalAmount += Number(flow.amount || 0);
      edge.count++;
      edge.lastTimestamp = Math.max(edge.lastTimestamp, flow.timestamp || 0);
    }

    // ── Scale node radii based on earned ─────────────────

    const maxEarned = Math.max(...[...nodeMap.values()].map((n) => n.earned), 1);
    for (const node of nodeMap.values()) {
      if (node.type === 'agent') {
        // radius: 10 (no earnings) → 22 (max earnings), log-scaled
        const ratio = node.earned > 0 ? Math.log1p(node.earned) / Math.log1p(maxEarned) : 0;
        node.radius = 10 + Math.round(ratio * 12);
      }
    }

    // ── Mark recent edges ─────────────────────────────────

    const edges = [...edgeMap.values()].map((e) => ({
      ...e,
      isRecent: (now - e.lastTimestamp) < RECENT_WINDOW,
      strokeWidth: Math.max(1, Math.min(6, Math.log1p(e.totalAmount / 1e8) * 0.8)),
    }));

    return {
      nodes: [...nodeMap.values()],
      edges,
    };
  }, [agents, guardFlows, config]);
}
