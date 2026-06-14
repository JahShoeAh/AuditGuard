# Database Migration Quick Start

## Overview

The orchestrator uses **Knex.js** for versioned database migrations. This replaces the manual `schema.sql` approach with automated, idempotent upgrades.

## Quick Start

### 1. Prerequisites

Ensure PostgreSQL is running and `DATABASE_URL` is set in `.env`:

```bash
# .env
DATABASE_URL=postgresql://auditguard:dev@localhost:5432/auditguard
```

### 2. Run Migrations

```bash
# Apply all pending migrations
npm run migrate

# Or start the orchestrator (runs migrations automatically)
npm start
```

### 3. Verify Setup

```bash
# Check migration framework is properly configured
npm run verify:migrations

# Run integration tests (requires live database)
npm run test:migrations
```

## Common Commands

```bash
# Apply pending migrations
npm run migrate

# Create a new migration
npm run migrate:make add_new_feature

# Rollback last batch
npm run migrate:rollback

# Verify migration setup
npm run verify:migrations
```

## Migration Files

Located in `/orchestrator/src/migrations/`:

- **001_initial_schema.sql** - Base tables (9 tables)
- **002_add_orchestrator_state.sql** - Orchestrator state persistence
- **003_add_indexes.sql** - Performance indexes (19 indexes)

## What Gets Created

After running migrations, your database will have:

**Tables:**
- `audit_reports` - Audit report records
- `audit_events` - HCS event log
- `bid_skips` - Bid skip tracking
- `pending_findings` - Agent findings store
- `audit_jobs` - Job lifecycle cache
- `registered_agents` - Agent roster cache
- `audit_schedules` - Scheduler cache
- `audit_vaults` - Vault registry cache
- `orchestrator_state` - Runtime state (roster, event cache)
- `knex_migrations` - Migration tracking (Knex internal)

**Indexes:**
19 performance indexes across all tables

## Idempotency

All migrations use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making them safe to run multiple times.

```bash
npm run migrate  # First run: applies 3 migrations
npm run migrate  # Second run: "Database is already up to date"
```

## Troubleshooting

### "DATABASE_URL is not configured"

Set in `.env`:
```bash
DATABASE_URL=postgresql://username:password@host:port/database
```

### Connection refused

Start PostgreSQL:
```bash
# macOS
brew services start postgresql

# Linux
sudo systemctl start postgresql
```

### Check migration status

```bash
psql $DATABASE_URL -c "SELECT * FROM knex_migrations ORDER BY id;"
```

## For More Details

- **Full Guide:** `MIGRATION_GUIDE.md` - Complete documentation
- **Implementation:** `MIGRATION_IMPLEMENTATION.md` - Technical details
- **Deprecated:** `src/schema.sql` - Old manual schema (reference only)

## Key Points

1. Migrations run automatically on `npm start`
2. All schema changes should go through migration files
3. Migrations are versioned and tracked
4. Safe to run multiple times (idempotent)
5. Rollback support available if needed
6. Works across dev/staging/production environments

## Next Steps

After initial setup:
1. Run `npm run migrate` to apply migrations
2. Verify with `psql $DATABASE_URL -c '\dt'`
3. Start orchestrator with `npm start`
4. Future schema changes: `npm run migrate:make <name>`
