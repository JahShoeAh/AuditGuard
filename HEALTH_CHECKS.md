# Health Check Infrastructure

Comprehensive health check endpoints across all AuditGuard services (orchestrator, agents, events-api).

## Endpoints

All services expose three health check endpoints:

### 1. `/health` - Comprehensive Health Check
Returns detailed health status with component-level checks.

**Response (200 OK when healthy, 503 Service Unavailable when unhealthy):**
```json
{
  "status": "healthy",
  "checks": {
    "database": true,
    "hedera_rpc": true,
    "hcs_topics": true,
    "contracts": true,
    "roster": true
  },
  "details": {
    "database": "Connected",
    "hedera_rpc": "Block 12345678",
    "hcs_topics": "Connected",
    "contracts": "1234 jobs",
    "roster": "5/7 agents active"
  },
  "timestamp": "2026-06-13T21:00:00.000Z",
  "uptime": 3600.5
}
```

### 2. `/healthz` - Liveness Probe
Always returns 200 if the process is running. Use for Kubernetes liveness probes.

**Response (200 OK):**
```json
{
  "status": "alive",
  "uptime": 3600.5
}
```

### 3. `/ready` - Readiness Probe
Returns 200 only if all critical checks pass. Use for Kubernetes readiness probes.

**Response (200 OK when ready, 503 when not ready):**
```json
{
  "ready": true
}
```

## Service Ports

### Orchestrator
- Health: `http://localhost:8080/health`
- Liveness: `http://localhost:8080/healthz`
- Readiness: `http://localhost:8080/ready`

### Agents
| Agent | Health Port | URL |
|-------|-------------|-----|
| Scanner | 8091 | http://localhost:8091/health |
| Static Analysis | 8092 | http://localhost:8092/health |
| Fuzzer | 8093 | http://localhost:8093/health |
| LLM Contextual | 8094 | http://localhost:8094/health |
| Dependency | 8095 | http://localhost:8095/health |
| Report | 8096 | http://localhost:8096/health |
| Alert | 8097 | http://localhost:8097/health |

### Events API
- Health: `http://localhost:3000/health`
- Liveness: `http://localhost:3000/healthz`
- Readiness: `http://localhost:3000/ready`

## Health Checks Performed

### Orchestrator (`/health`)
- **Database**: PostgreSQL connectivity via state store
- **Hedera RPC**: Provider connection + latest block number
- **HCS Topics**: Topic subscription status
- **Contracts**: On-chain job count query
- **Roster**: Active agent count (heartbeat within 30s)

### Agents (`/health`)
- **HCS**: Topic subscription connectivity
- **Contracts**: Provider connection + latest block number
- **Wallet**: HBAR balance > 0
- **Pending Jobs**: Number of jobs awaiting processing
- **Memory**: Heap usage and RSS

### Events API (`/health`)
- **Database**: PostgreSQL connectivity
- **Orchestrator**: Optional ping to orchestrator healthz endpoint

## Environment Variables

```bash
# Health check ports
ORCHESTRATOR_HEALTH_PORT=8080
SCANNER_HEALTH_PORT=8091
STATIC_HEALTH_PORT=8092
FUZZER_HEALTH_PORT=8093
LLM_HEALTH_PORT=8094
DEPENDENCY_HEALTH_PORT=8095
REPORT_HEALTH_PORT=8096
ALERT_HEALTH_PORT=8097

# Events API orchestrator health check
ORCHESTRATOR_HEALTH_URL=http://localhost:8080/healthz
```

## Usage Examples

### Check if orchestrator is healthy
```bash
curl http://localhost:8080/health
```

### Check if scanner agent is ready
```bash
curl http://localhost:8091/ready
```

### Monitor all services
```bash
for port in 8080 8091 8092 8093 8094 8095 8096 8097; do
  echo "Port $port:"
  curl -s http://localhost:$port/health | jq '.status'
done
```

### Docker healthcheck
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1
```

### Kubernetes liveness probe
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
```

### Kubernetes readiness probe
```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
```

## Agent Health Response

Agent health responses include additional fields:

```json
{
  "status": "healthy",
  "agent_id": "scanner-001",
  "checks": {
    "hcs": true,
    "contracts": true,
    "wallet": true
  },
  "details": {
    "hcs": "Connected",
    "contracts": "Block 12345678",
    "wallet": "1000000000 tinybar"
  },
  "pending_jobs": 5,
  "uptime": 3600.5,
  "memory": {
    "rss": 150000000,
    "heapTotal": 100000000,
    "heapUsed": 80000000,
    "external": 5000000,
    "arrayBuffers": 1000000
  },
  "timestamp": "2026-06-13T21:00:00.000Z"
}
```

## Testing

Run health check tests:
```bash
npm run test -- tests/health-endpoints.test.ts
```

## Implementation Details

### Orchestrator
- Health module: `orchestrator/src/health.js`
- Server: `orchestrator/src/index.js`

### Agents
- Health module: `agents/shared/health.ts`
- Exported from: `agents/shared/index.ts`
- Integrated in each agent's `index.ts`

### Events API
- Health routes: `packages/events-api/src/routes/health.js`

## Status Codes

| Status | HTTP Code | Meaning |
|--------|-----------|---------|
| healthy | 200 | All checks passed |
| unhealthy | 503 | One or more checks failed |
| alive | 200 | Process is running (liveness) |
| ready (true) | 200 | Service is ready to accept traffic |
| ready (false) | 503 | Service is not ready |

## Monitoring Integration

Health endpoints are designed for:
- **Kubernetes**: Liveness and readiness probes
- **Docker**: HEALTHCHECK directive
- **Load Balancers**: Backend health checks
- **Monitoring Tools**: Prometheus, Datadog, New Relic
- **Uptime Monitoring**: Pingdom, UptimeRobot, etc.

## Failure Scenarios

### Database Failure
```json
{
  "status": "unhealthy",
  "checks": {
    "database": false
  },
  "details": {
    "database": "Error: Connection refused"
  }
}
```

### RPC Failure
```json
{
  "status": "unhealthy",
  "checks": {
    "hedera_rpc": false
  },
  "details": {
    "hedera_rpc": "Error: Network timeout"
  }
}
```

### Zero Balance (Agent)
```json
{
  "status": "unhealthy",
  "checks": {
    "wallet": false
  },
  "details": {
    "wallet": "0 tinybar"
  }
}
```
