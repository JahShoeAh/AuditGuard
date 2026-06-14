import promClient from 'prom-client';

const register = new promClient.Registry();

// Add default metrics (CPU, memory, event loop lag)
promClient.collectDefaultMetrics({ register });

// Orchestrator-specific metrics
export const auctionsCreated = new promClient.Counter({
  name: 'auditguard_auctions_created_total',
  help: 'Total auctions created',
  registers: [register],
});

export const winnersSelected = new promClient.Counter({
  name: 'auditguard_winners_selected_total',
  help: 'Total winners selected',
  registers: [register],
});

export const settlementsCompleted = new promClient.Counter({
  name: 'auditguard_settlements_completed_total',
  help: 'Total payment settlements completed',
  registers: [register],
});

export const activeJobs = new promClient.Gauge({
  name: 'auditguard_active_jobs',
  help: 'Number of active audit jobs',
  registers: [register],
});

export const activeAgents = new promClient.Gauge({
  name: 'auditguard_active_agents',
  help: 'Number of active agents',
  registers: [register],
});

export const hcsMessagesProcessed = new promClient.Counter({
  name: 'auditguard_hcs_messages_processed_total',
  help: 'Total HCS messages processed',
  labelNames: ['message_type', 'topic'],
  registers: [register],
});

export const hcsMessageLatency = new promClient.Histogram({
  name: 'auditguard_hcs_message_latency_ms',
  help: 'HCS message processing latency in milliseconds',
  labelNames: ['message_type'],
  buckets: [10, 50, 100, 500, 1000, 5000],
  registers: [register],
});

export const contractCallDuration = new promClient.Histogram({
  name: 'auditguard_contract_call_duration_ms',
  help: 'Contract call duration in milliseconds',
  labelNames: ['method'],
  buckets: [100, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

export const contractCallErrors = new promClient.Counter({
  name: 'auditguard_contract_call_errors_total',
  help: 'Total contract call errors',
  labelNames: ['method', 'error_type'],
  registers: [register],
});

// Export metrics for Prometheus scraping
export function getMetrics() {
  return register.metrics();
}
