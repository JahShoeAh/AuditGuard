# Orchestrator State Persistence

## Overview

The orchestrator now persists critical runtime state to PostgreSQL, ensuring that agent roster information and event caches survive process restarts. This eliminates the need to rebuild agent state from scratch after deployment updates or crashes.

## Architecture

### Components

1. **OrchestratorStateStore** (`src/state-store.js`)
   - Handles database persistence for orchestrator state
   - Uses PostgreSQL with JSONB storage for flexible state structures
   - Gracefully degrades when database is unavailable

2. **Database Schema** (`src/schema.sql`)
   - `orchestrator_state` table stores key-value pairs with JSONB values
   - Keys: `roster`, `eventCache`
   - Indexed by `updated_at` for efficient queries

3. **OrchestratorAgent** (`src/orchestrator.js`)
   - New methods: `loadPersistedState()`, `savePersistedState()`
   - Automatically loads state on startup
   - Periodically saves state every 60 seconds
   - Saves state on graceful shutdown (SIGTERM/SIGINT)

## Persisted State

### 1. Agent Roster

The agent roster (`roster.agents` Map) contains all registered agents with:
- Agent ID
- EVM address
- Specializations
- Stake amount
- Reputation score
- Tier (PREMIUM/COMMODITY)
- Last seen timestamp

**Why persist:** Prevents loss of agent liveness tracking and avoids re-syncing from on-chain registry on every restart.

### 2. Event Cache

The recent discovery cache (`recentDiscovery` Map) prevents duplicate contract discoveries within a TTL window.

**Why persist:** Ensures discovery deduplication works across restarts, preventing redundant audit job creation.

## Usage

### Automatic Persistence

State persistence is enabled by default when `DATABASE_URL` is configured:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/auditguard
```

The orchestrator will:
1. Load persisted state on startup (before subscribing to HCS topics)
2. Save state every 60 seconds
3. Save state on graceful shutdown

### Manual Testing

Run the verification script to simulate orchestrator restart:

```bash
npm run verify:persistence
```

This will:
1. Create an orchestrator with sample agents
2. Save state to database
3. Simulate restart by loading state into a new instance
4. Verify all agents and cache entries were restored

### Unit Testing

Run the state persistence test suite:

```bash
npm run test:persistence
```

## Database Setup

### Create the table

The `orchestrator_state` table is created automatically when running the schema:

```bash
psql "$DATABASE_URL" -f orchestrator/src/schema.sql
```

### Manual table creation

```sql
CREATE TABLE IF NOT EXISTS orchestrator_state (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_state_updated
  ON orchestrator_state(updated_at DESC);
```

## Graceful Degradation

When `DATABASE_URL` is not configured or the database is unavailable:
- The orchestrator starts normally (in-memory only mode)
- State persistence operations become no-ops
- Warning messages are logged
- No errors are thrown

This ensures the orchestrator remains operational even without persistence.

## Implementation Details

### Save Frequency

- **Periodic:** Every 60 seconds (configurable via `stateSaveInterval` in `index.js`)
- **Shutdown:** On SIGTERM or SIGINT signals
- **Error Handling:** Failures are logged but do not crash the orchestrator

### Load Strategy

State is loaded once during startup, before the orchestrator subscribes to HCS topics. This ensures:
1. Agent roster is pre-populated with known agents
2. Discovery cache prevents duplicate events from the lookback window
3. On-chain roster bootstrap (if enabled) merges with persisted state

### Data Format

State is serialized using `JSON.stringify(Array.from(map.entries()))` and deserialized using `new Map(JSON.parse(value))`. This preserves Map structure while storing as PostgreSQL JSONB.

## Monitoring

Check logs for persistence activity:

```
[state-store] Saved 7 agents to persistent storage
[state-store] Saved 15 event cache entries to persistent storage
[orchestrator] Restored 7 agents from persistent storage
[orchestrator] Restored 15 event cache entries from persistent storage
```

## Troubleshooting

### State not persisting

1. Verify `DATABASE_URL` is set in `.env`
2. Check PostgreSQL is running and accessible
3. Ensure `orchestrator_state` table exists
4. Check logs for error messages

### State not loading on restart

1. Verify table has data: `SELECT * FROM orchestrator_state;`
2. Check that `loadPersistedState()` is called before `start()`
3. Verify JSONB deserialization is successful

### Performance impact

- Save operations are asynchronous and non-blocking
- Database queries use indexed lookups (by primary key)
- Typical overhead: <50ms per save/load operation
- No impact on HCS message processing

## Future Enhancements

Potential improvements not yet implemented:

1. **Versioned State Schema** - Migration path for schema changes
2. **Selective Persistence** - Configure which state Maps to persist
3. **Compression** - GZIP compress JSONB for large rosters
4. **Metrics** - Prometheus counters for save/load operations
5. **State Snapshots** - Periodic full state dumps for disaster recovery

## Security Considerations

- Database credentials stored in `.env` (not committed)
- State contains agent addresses and reputation data (non-sensitive)
- No private keys or sensitive user data is persisted
- Access control managed at PostgreSQL connection level

## Maintenance

### Cleaning old state

State is updated in-place (ON CONFLICT DO UPDATE). To reset state:

```sql
DELETE FROM orchestrator_state WHERE key IN ('roster', 'eventCache');
```

### Inspecting persisted state

```sql
SELECT key, jsonb_pretty(value), updated_at
FROM orchestrator_state
ORDER BY updated_at DESC;
```

## Related Files

- `orchestrator/src/state-store.js` - State store implementation
- `orchestrator/src/orchestrator.js` - Persistence integration
- `orchestrator/src/index.js` - Lifecycle management
- `orchestrator/src/schema.sql` - Database schema
- `orchestrator/test/state-persistence.test.js` - Test suite
- `orchestrator/scripts/verify-persistence.js` - Verification script
