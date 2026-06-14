# Database Migration Framework

## Overview

The orchestrator now uses Knex.js for versioned database migrations, replacing the manual `schema.sql` approach. This enables automated, idempotent database upgrades.

## Migration Files

Migrations are located in `/orchestrator/src/migrations/`:

- **001_initial_schema.sql** - Base tables (audit_reports, audit_events, bid_skips, pending_findings, audit_jobs, registered_agents, audit_schedules, audit_vaults)
- **002_add_orchestrator_state.sql** - Orchestrator state table for roster/event cache persistence
- **003_add_indexes.sql** - Performance indexes for all tables

## Commands

### Running Migrations

```bash
# Run all pending migrations
npm run migrate

# Migrations run automatically on orchestrator startup
npm start
```

### Creating New Migrations

```bash
# Create a new migration file
npm run migrate:make <migration_name>

# Example:
npm run migrate:make add_audit_metrics_table
```

### Rolling Back Migrations

```bash
# Rollback last batch of migrations
npm run migrate:rollback
```

## Configuration

### Environment Variables

Set `DATABASE_URL` in your `.env` file:

```bash
DATABASE_URL=postgresql://auditguard:dev@localhost:5432/auditguard
```

### Knex Configuration

Configuration is in `/orchestrator/knexfile.js`. It supports:
- `development` environment (default)
- `production` environment (set `NODE_ENV=production`)

## Migration State

Knex tracks applied migrations in the `knex_migrations` table:

```sql
SELECT * FROM knex_migrations ORDER BY id;
```

This ensures migrations are idempotent - running `npm run migrate` multiple times is safe.

## Verification Steps

1. **Initial Setup** (clean database):
   ```bash
   npm run migrate
   ```
   Expected output:
   ```
   Running migrations in development environment...
   ✓ Ran 3 migration(s):
     - 001_initial_schema.sql
     - 002_add_orchestrator_state.sql
     - 003_add_indexes.sql
   ```

2. **Idempotency Test** (run again):
   ```bash
   npm run migrate
   ```
   Expected output:
   ```
   Running migrations in development environment...
   ✓ Database is already up to date
   ```

3. **Verify Tables**:
   ```bash
   psql $DATABASE_URL -c "\dt"
   ```
   Should show: audit_events, audit_jobs, audit_reports, audit_schedules, audit_vaults, bid_skips, knex_migrations, orchestrator_state, pending_findings, registered_agents

4. **Verify Indexes**:
   ```bash
   psql $DATABASE_URL -c "\di"
   ```
   Should show all indexes from migration 003

5. **Check Migration History**:
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM knex_migrations ORDER BY id;"
   ```

## Integration with Orchestrator

The orchestrator startup sequence (`npm start`) now:
1. Runs `npm run migrate` (applies any pending migrations)
2. Starts the orchestrator service

This ensures the database schema is always up-to-date before the orchestrator starts.

## Troubleshooting

### "DATABASE_URL is not configured"

Ensure `DATABASE_URL` is set in `.env`:
```bash
echo "DATABASE_URL=postgresql://auditguard:dev@localhost:5432/auditguard" >> .env
```

### Connection Refused

Ensure PostgreSQL is running:
```bash
# macOS (Homebrew)
brew services start postgresql

# Linux (systemd)
sudo systemctl start postgresql
```

### Migration Lock Timeout

If a migration is interrupted, Knex may leave a lock. Clear it:
```bash
psql $DATABASE_URL -c "DELETE FROM knex_migrations_lock WHERE is_locked=1;"
```

## Benefits Over Manual Schema.sql

1. **Versioning** - Each schema change is tracked and numbered
2. **Idempotent** - Safe to run migrations multiple times
3. **Rollback** - Can undo migrations if needed
4. **Automation** - Runs automatically on startup
5. **Team Coordination** - No manual schema sync required
6. **Audit Trail** - Migration history in `knex_migrations` table
