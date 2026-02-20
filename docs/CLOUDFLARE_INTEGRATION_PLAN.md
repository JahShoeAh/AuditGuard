# AuditGuard Cloudflare Integration Plan

## Verified Inputs

- Existing monorepo packages:
  - `packages/dashboard` (Vite static frontend)
  - `agents` and `orchestrator` (long-running Node processes)
- Reference repos analyzed locally:
  - `/Users/joshcho/ethdenver-command`
  - `/Users/joshcho/ethdenver-command-api`
- Implemented in this branch:
  - `packages/cloudflare-api` Worker + D1 event store
  - optional relay from HCS clients (`EVENT_RELAY_URL`)

## Target Deployment Topology

1. `packages/dashboard` deployed to Cloudflare Workers static assets.
2. `packages/cloudflare-api` deployed as Cloudflare Worker with D1 binding.
3. `agents` and `orchestrator` continue running on your Node host and stream event copies to Cloudflare API.

This avoids trying to move stateful Hedera agent processes into Workers while still giving you SQL observability in D1.

## Naming Convention (AuditGuard)

1. Worker names:
   - Dashboard: `auditguard-dashboard`
   - API: `auditguard-api`
2. Canonical URL structure:
   - Dashboard: `https://auditguard.<your-domain>/dashboard`
   - API: `https://auditguard.<your-domain>/api/*`
3. Dashboard runtime config:
   - `VITE_EVENTS_API_BASE_URL=/api`

## Phase 1: Deploy Dashboard to Cloudflare

1. Build dashboard:
```bash
npm --prefix packages/dashboard run build
```

2. Deploy static assets:
```bash
npm --prefix packages/dashboard run deploy:cf
```

3. Optional upload-size dry run:
```bash
npm --prefix packages/dashboard run size:upload
```

## Phase 2: Create and Migrate D1

1. Create D1 DB:
```bash
npm --workspace packages/cloudflare-api run db:create
```

2. Copy `database_id` into `packages/cloudflare-api/wrangler.jsonc`.

3. Apply local migrations:
```bash
npm --workspace packages/cloudflare-api run db:migrate:local
```

4. Apply remote migrations:
```bash
npm --workspace packages/cloudflare-api run db:migrate:remote
```

## Phase 3: Deploy Cloudflare Events API

1. Set ingest token secret:
```bash
npx wrangler secret put INGEST_TOKEN --config packages/cloudflare-api/wrangler.jsonc
```

2. Deploy worker:
```bash
npm --workspace packages/cloudflare-api run deploy:cf
```

3. Confirm health:
```bash
curl https://auditguard.<your-domain>/api/health
```

## Phase 4: Wire Runtime Relay

Set root `.env` values for your running orchestrator/agents:

```env
EVENT_RELAY_URL=https://auditguard.<your-domain>/api/events
EVENT_RELAY_TOKEN=<same as INGEST_TOKEN>
```

After restart, every successful HCS publish is mirrored to D1.

Set dashboard event source in `.env`:

```env
VITE_EVENTS_API_BASE_URL=/api
```

## Phase 5: Validate Data Path

1. Start your stack and generate at least one auction invite flow.
2. Query latest events:
```bash
curl "https://auditguard.<your-domain>/api/events?limit=50"
```

3. Query skip reasons specifically:
```bash
curl "https://auditguard.<your-domain>/api/bid-skips?limit=50"
```

## Ingest Token Policy (Item 2)

Enforced policy:

1. Production and staging: `INGEST_TOKEN` required.
2. Local development (`wrangler dev --local`): token optional if `APP_ENV=local`.
3. Unsigned ingest is rejected in non-local environments.

Reasoning:

1. `/api/events` is a write endpoint from external runtimes (agents/orchestrator), so unauthenticated access lets anyone poison your analytics/audit trail.
2. The token is low-friction to rotate and does not impact dashboard read endpoints.
3. Keeping token optional only in local mode preserves developer velocity without weakening deployed environments.

Implementation notes:

1. Worker default is `APP_ENV=production` in `packages/cloudflare-api/wrangler.jsonc`.
2. For local optional-auth mode, set `APP_ENV=local` in `packages/cloudflare-api/.dev.vars`:

```env
APP_ENV=local
```
