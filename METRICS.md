# Prometheus Metrics Export

AuditGuard exposes Prometheus-compatible metrics for operational visibility across all services.

## Overview

- **Orchestrator**: Port `9090` (configurable via `ORCHESTRATOR_METRICS_PORT`)
- **Scanner Agent**: Port `9091` (configurable via `SCANNER_METRICS_PORT`)
- **Static Analysis Agent**: Port `9092` (configurable via `STATIC_METRICS_PORT`)
- **Fuzzer Agent**: Port `9093` (configurable via `FUZZER_METRICS_PORT`)
- **LLM Agent**: Port `9094` (configurable via `LLM_METRICS_PORT`)
- **Dependency Agent**: Port `9095` (configurable via `DEPENDENCY_METRICS_PORT`)
- **Report Agent**: Port `9096` (configurable via `REPORT_METRICS_PORT`)
- **Alert Agent**: Port `9097` (configurable via `ALERT_METRICS_PORT`)

## Accessing Metrics

All services expose metrics at the `/metrics` endpoint:

```bash
# Orchestrator metrics
curl http://localhost:9090/metrics

# Scanner agent metrics
curl http://localhost:9091/metrics

# All agent metrics
for port in {9091..9097}; do
  echo "=== Port $port ==="
  curl -s http://localhost:$port/metrics | head -20
done
```

## Metric Types

### Orchestrator Metrics

**Business Metrics:**
- `auditguard_auctions_created_total` (counter) - Total auctions created
- `auditguard_winners_selected_total` (counter) - Total winners selected
- `auditguard_settlements_completed_total` (counter) - Total payment settlements
- `auditguard_active_jobs` (gauge) - Number of active audit jobs
- `auditguard_active_agents` (gauge) - Number of active agents

**HCS Performance:**
- `auditguard_hcs_messages_processed_total{message_type, topic}` (counter) - HCS messages processed
- `auditguard_hcs_message_latency_ms{message_type}` (histogram) - Message processing latency

**Contract Performance:**
- `auditguard_contract_call_duration_ms{method}` (histogram) - Contract call duration
- `auditguard_contract_call_errors_total{method, error_type}` (counter) - Contract errors

### Agent Metrics

**Business Metrics:**
- `auditguard_agent_bids_submitted_total{agent_id}` (counter) - Bids submitted
- `auditguard_agent_bids_won_total{agent_id}` (counter) - Bids won
- `auditguard_agent_jobs_completed_total{agent_id}` (counter) - Jobs completed
- `auditguard_agent_findings_submitted_total{agent_id, severity}` (counter) - Findings by severity
- `auditguard_agent_pending_jobs{agent_id}` (gauge) - Current pending jobs

**Performance:**
- `auditguard_agent_messages_received_total{agent_id, message_type}` (counter) - Messages received
- `auditguard_agent_message_processing_ms{agent_id, message_type}` (histogram) - Message latency

### Default System Metrics

All services include Node.js default metrics:
- `process_cpu_user_seconds_total` - User CPU time
- `process_cpu_system_seconds_total` - System CPU time
- `process_resident_memory_bytes` - Memory usage
- `nodejs_eventloop_lag_seconds` - Event loop lag
- `nodejs_heap_size_total_bytes` - Heap size
- `nodejs_heap_size_used_bytes` - Used heap
- `nodejs_gc_duration_seconds` - GC duration

## Prometheus Configuration

Example `prometheus.yml` configuration:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'auditguard-orchestrator'
    static_configs:
      - targets: ['localhost:9090']
        labels:
          service: 'orchestrator'
          environment: 'testnet'

  - job_name: 'auditguard-agents'
    static_configs:
      - targets:
        - 'localhost:9091'  # Scanner
        - 'localhost:9092'  # Static Analysis
        - 'localhost:9093'  # Fuzzer
        - 'localhost:9094'  # LLM
        - 'localhost:9095'  # Dependency
        - 'localhost:9096'  # Report
        - 'localhost:9097'  # Alert
        labels:
          environment: 'testnet'
```

## Grafana Dashboards

### Example Queries

**Auction throughput:**
```promql
rate(auditguard_auctions_created_total[5m])
```

**Agent win rate:**
```promql
rate(auditguard_agent_bids_won_total[5m]) / rate(auditguard_agent_bids_submitted_total[5m])
```

**Message processing latency (p95):**
```promql
histogram_quantile(0.95, rate(auditguard_hcs_message_latency_ms_bucket[5m]))
```

**Contract call errors by method:**
```promql
sum by (method) (rate(auditguard_contract_call_errors_total[5m]))
```

**Active agents over time:**
```promql
auditguard_active_agents
```

**Memory usage trend:**
```promql
process_resident_memory_bytes / 1024 / 1024
```

## Implementation

### Orchestrator

Metrics are defined in `orchestrator/src/metrics.js` and instrumented in:
- `orchestrator/src/orchestrator.js` - Message handlers and contract calls
- `orchestrator/src/index.js` - HTTP server initialization

### Agents

Metrics are defined in `agents/shared/metrics.ts` and exported via:
- `createPrometheusMetrics(agentId)` - Creates metrics registry
- `startPrometheusServer(metrics, port, logger)` - Starts HTTP server

Each agent initializes metrics in their `main()` function:

```typescript
import { createPrometheusMetrics, startPrometheusServer } from '../shared/index.js';

const METRICS_PORT = parseInt(process.env.SCANNER_METRICS_PORT || '9091', 10);
const prometheusMetrics = createPrometheusMetrics(AGENT_ID);
await startPrometheusServer(prometheusMetrics, METRICS_PORT, log);
```

## Testing

Verify metrics endpoints are working:

```bash
# Test orchestrator
cd orchestrator
node test/metrics.test.js

# Check all endpoints
for port in 9090 {9091..9097}; do
  echo "Testing port $port..."
  curl -f http://localhost:$port/metrics > /dev/null 2>&1 && echo "✅ $port OK" || echo "❌ $port FAILED"
done
```

## Alerting

Example Prometheus alerting rules:

```yaml
groups:
  - name: auditguard
    interval: 30s
    rules:
      - alert: HighContractErrorRate
        expr: rate(auditguard_contract_call_errors_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High contract call error rate"

      - alert: NoActiveAgents
        expr: auditguard_active_agents == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "No active agents responding to PING"

      - alert: HighMessageLatency
        expr: histogram_quantile(0.95, rate(auditguard_hcs_message_latency_ms_bucket[5m])) > 5000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High HCS message processing latency (p95 > 5s)"

      - alert: HighEventLoopLag
        expr: nodejs_eventloop_lag_seconds > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Node.js event loop is blocked"
```

## Environment Variables

Add to `.env`:

```bash
# Metrics ports (Prometheus scraping)
ORCHESTRATOR_METRICS_PORT=9090
SCANNER_METRICS_PORT=9091
STATIC_METRICS_PORT=9092
FUZZER_METRICS_PORT=9093
LLM_METRICS_PORT=9094
DEPENDENCY_METRICS_PORT=9095
REPORT_METRICS_PORT=9096
ALERT_METRICS_PORT=9097
```

## Production Considerations

1. **Security**: Metrics endpoints are unauthenticated by default. In production, use:
   - Network isolation (bind to localhost only)
   - Reverse proxy with authentication
   - VPC/firewall rules

2. **Cardinality**: Label cardinality is bounded:
   - `agent_id`: 7 agents
   - `message_type`: ~10 types
   - `method`: ~15 contract methods
   - `severity`: 4 levels (critical, high, medium, low)

3. **Performance**: Metrics collection adds minimal overhead (~1-2% CPU/memory)

4. **Retention**: Configure Prometheus retention based on needs:
   ```bash
   prometheus --storage.tsdb.retention.time=30d
   ```

## Troubleshooting

**Port already in use:**
```bash
lsof -ti:9090 | xargs kill -9
```

**Metrics not updating:**
- Check service logs for metric instrumentation
- Verify operations are actually occurring (create auctions, submit bids)
- Check Prometheus targets are UP in `/targets`

**High memory usage:**
- Reduce metric retention time
- Reduce cardinality (remove unused labels)
- Check for metric label explosion
