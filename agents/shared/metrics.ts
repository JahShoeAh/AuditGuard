/**
 * Lightweight performance metrics tracker for AuditGuard agents.
 * Each agent maintains its own instance; metrics are logged periodically.
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
