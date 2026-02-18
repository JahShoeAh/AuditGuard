/**
 * AuditGuard metrics module.
 *
 * Two APIs:
 *   1. AgentMetrics class — per-agent domain metrics (bids, audits, settlements)
 *   2. Functional infra API — process-level health monitoring (cycles, errors, heartbeats)
 */

export interface MetricsSummary {
  agentId: string;
  uptimeMs: number;
  bids: { total: number; wins: number; winRate: number };
  audits: { total: number; avgDurationMs: number; totalFindings: number };
  commerce: { dataListings: number; dataPurchases: number; subAuctionsBid: number };
  settlements: { total: number; totalGuardReceived: number };
}

export class AgentMetrics {
  private agentId: string;
  private startedAt: number;
  private bidCount = 0;
  private winCount = 0;
  private auditCount = 0;
  private auditDurationsMs: number[] = [];
  private findingsTotal = 0;
  private dataListings = 0;
  private dataPurchases = 0;
  private subAuctionsBid = 0;
  private settlementsReceived = 0;
  private guardReceived = 0;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.startedAt = Date.now();
  }

  recordBid(): void { this.bidCount++; }
  recordWin(): void { this.winCount++; }
  recordAuditStart(): number { return Date.now(); }

  recordAuditEnd(startTime: number, findingsCount: number): void {
    this.auditCount++;
    this.auditDurationsMs.push(Date.now() - startTime);
    this.findingsTotal += findingsCount;
  }

  recordDataListing(): void { this.dataListings++; }
  recordDataPurchase(): void { this.dataPurchases++; }
  recordSubAuctionBid(): void { this.subAuctionsBid++; }

  recordSettlement(guardAmount: number): void {
    this.settlementsReceived++;
    this.guardReceived += guardAmount;
  }

  getSummary(): MetricsSummary {
    const avgDuration = this.auditDurationsMs.length > 0
      ? this.auditDurationsMs.reduce((a, b) => a + b, 0) / this.auditDurationsMs.length
      : 0;

    return {
      agentId: this.agentId,
      uptimeMs: Date.now() - this.startedAt,
      bids: {
        total: this.bidCount,
        wins: this.winCount,
        winRate: this.bidCount > 0 ? this.winCount / this.bidCount : 0,
      },
      audits: {
        total: this.auditCount,
        avgDurationMs: Math.round(avgDuration),
        totalFindings: this.findingsTotal,
      },
      commerce: {
        dataListings: this.dataListings,
        dataPurchases: this.dataPurchases,
        subAuctionsBid: this.subAuctionsBid,
      },
      settlements: {
        total: this.settlementsReceived,
        totalGuardReceived: this.guardReceived,
      },
    };
  }

  logSummary(logger: { info: (msg: string) => void }): void {
    const s = this.getSummary();
    const upMin = Math.round(s.uptimeMs / 60_000);
    logger.info(
      `[Metrics] uptime=${upMin}m bids=${s.bids.total} wins=${s.bids.wins} ` +
      `winRate=${(s.bids.winRate * 100).toFixed(0)}% audits=${s.audits.total} ` +
      `avgAuditTime=${s.audits.avgDurationMs}ms findings=${s.audits.totalFindings} ` +
      `listings=${s.commerce.dataListings} purchases=${s.commerce.dataPurchases} ` +
      `settlements=${s.settlements.total} guard=${s.settlements.totalGuardReceived.toFixed(2)}`
    );
  }
}

// ── Infrastructure health monitoring (functional API) ────────────────────────
// Tracks process-level health: cycles, errors, restarts, heartbeats, messages.
// Used by run-all.ts and run-demo.ts for the health dashboard.

export interface InfraMetrics {
  name: string;
  cycles: number;
  errors: number;
  restarts: number;
  messagesPublished: number;
  messagesSubscribed: number;
  lastHeartbeatAt: number;
  startedAt: number;
  latencySamples: number[];
}

export interface AggregateMetrics {
  totalCycles: number;
  totalErrors: number;
  totalRestarts: number;
  totalMessagesPublished: number;
  totalMessagesSubscribed: number;
  healthyAgents: number;
  totalAgents: number;
}

const LATENCY_WINDOW = 50;
const HEARTBEAT_TIMEOUT_MS = 30_000;

const _store = new Map<string, InfraMetrics>();

export function initAgent(name: string): void {
  _store.set(name, {
    name,
    cycles: 0,
    errors: 0,
    restarts: 0,
    messagesPublished: 0,
    messagesSubscribed: 0,
    lastHeartbeatAt: Date.now(),
    startedAt: Date.now(),
    latencySamples: [],
  });
}

export function recordCycle(name: string, durationMs: number): void {
  const m = _store.get(name);
  if (!m) return;
  m.cycles++;
  m.latencySamples.push(durationMs);
  if (m.latencySamples.length > LATENCY_WINDOW) m.latencySamples.shift();
}

export function recordError(name: string): void {
  const m = _store.get(name);
  if (m) m.errors++;
}

export function recordRestart(name: string): void {
  const m = _store.get(name);
  if (m) m.restarts++;
}

export function recordHeartbeat(name: string): void {
  const m = _store.get(name);
  if (m) m.lastHeartbeatAt = Date.now();
}

export function recordMessage(name: string, direction: "pub" | "sub"): void {
  const m = _store.get(name);
  if (!m) return;
  if (direction === "pub") m.messagesPublished++;
  else m.messagesSubscribed++;
}

export function getMetrics(name: string): InfraMetrics | undefined {
  return _store.get(name);
}

export function getAllMetrics(): InfraMetrics[] {
  return Array.from(_store.values());
}

export function getAggregate(): AggregateMetrics {
  const all = getAllMetrics();
  const now = Date.now();
  return {
    totalCycles: all.reduce((s, m) => s + m.cycles, 0),
    totalErrors: all.reduce((s, m) => s + m.errors, 0),
    totalRestarts: all.reduce((s, m) => s + m.restarts, 0),
    totalMessagesPublished: all.reduce((s, m) => s + m.messagesPublished, 0),
    totalMessagesSubscribed: all.reduce((s, m) => s + m.messagesSubscribed, 0),
    healthyAgents: all.filter((m) => now - m.lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS).length,
    totalAgents: all.length,
  };
}

export function formatMetricsSummary(): string {
  const all = getAllMetrics();
  if (all.length === 0) return "(no agents tracked)";
  const now = Date.now();
  const W = { name: 14, cycles: 6, errors: 6, restarts: 8, pub: 9, sub: 10 };
  const sep = `├${"─".repeat(W.name + 2)}┼${"─".repeat(W.cycles + 2)}┼${"─".repeat(W.errors + 2)}┼${"─".repeat(W.restarts + 2)}┼${"─".repeat(W.pub + 2)}┼${"─".repeat(W.sub + 2)}┤`;
  const lines: string[] = [
    `┌${"─".repeat(W.name + 2)}┬${"─".repeat(W.cycles + 2)}┬${"─".repeat(W.errors + 2)}┬${"─".repeat(W.restarts + 2)}┬${"─".repeat(W.pub + 2)}┬${"─".repeat(W.sub + 2)}┐`,
    `│ ${"Agent".padEnd(W.name)} │ ${"Cycles".padStart(W.cycles)} │ ${"Errors".padStart(W.errors)} │ ${"Restarts".padStart(W.restarts)} │ ${"Pub".padStart(W.pub)} │ ${"Sub".padStart(W.sub)} │`,
    sep,
  ];
  for (const m of all) {
    const healthy = now - m.lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS;
    const dot = healthy ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    lines.push(
      `│ ${dot} ${m.name.padEnd(W.name - 2)} │ ${String(m.cycles).padStart(W.cycles)} │ ${String(m.errors).padStart(W.errors)} │ ${String(m.restarts).padStart(W.restarts)} │ ${String(m.messagesPublished).padStart(W.pub)} │ ${String(m.messagesSubscribed).padStart(W.sub)} │`
    );
  }
  const agg = getAggregate();
  lines.push(sep);
  lines.push(
    `│ ${"TOTAL".padEnd(W.name)} │ ${String(agg.totalCycles).padStart(W.cycles)} │ ${String(agg.totalErrors).padStart(W.errors)} │ ${String(agg.totalRestarts).padStart(W.restarts)} │ ${String(agg.totalMessagesPublished).padStart(W.pub)} │ ${String(agg.totalMessagesSubscribed).padStart(W.sub)} │`
  );
  lines.push(
    `└${"─".repeat(W.name + 2)}┴${"─".repeat(W.cycles + 2)}┴${"─".repeat(W.errors + 2)}┴${"─".repeat(W.restarts + 2)}┴${"─".repeat(W.pub + 2)}┴${"─".repeat(W.sub + 2)}┘`
  );
  lines.push(`  \x1b[32m${agg.healthyAgents}\x1b[0m/${agg.totalAgents} agents healthy (heartbeat < 30s)`);
  return lines.join("\n");
}

let _dumpInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicDump(
  intervalMs = 30_000,
  logFn: (s: string) => void = console.log,
): void {
  if (_dumpInterval) return;
  _dumpInterval = setInterval(() => logFn(formatMetricsSummary()), intervalMs);
}

export function stopPeriodicDump(): void {
  if (_dumpInterval) {
    clearInterval(_dumpInterval);
    _dumpInterval = null;
  }
}
