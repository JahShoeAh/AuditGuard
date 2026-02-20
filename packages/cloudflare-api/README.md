# AuditGuard Cloudflare Events API

Cloudflare Worker + D1 service for persisting AuditGuard event traffic (including `BID_SKIPPED` reason codes).

Naming convention:
- Worker name: `auditguard-api`
- Canonical API path: `https://auditguard.<your-domain>/api/*`

## What It Stores

- `audit_events`: raw HCS message envelope and payload for all ingested events
- `bid_skips`: extracted skip diagnostics from `BID_SKIPPED` messages

## Endpoints

- `GET /api/health`
- `POST /api/events` (auth enforced outside local dev)
- `GET /api/events?limit=100&type=BID_SUBMITTED&agentId=...&topicId=...`
- `GET /api/bid-skips?limit=100&reasonCode=...&agentId=...`

## Local Setup

1. Install root dependencies from repository root:
```bash
npm install
```

2. Create D1 database (one-time):
```bash
npm --workspace packages/cloudflare-api run db:create
```

3. Put returned `database_id` in `packages/cloudflare-api/wrangler.jsonc` under `d1_databases[0].database_id`.

4. Apply local migrations:
```bash
npm --workspace packages/cloudflare-api run db:migrate:local
```

5. Start worker locally:
```bash
npm --workspace packages/cloudflare-api run dev
```

Local optional-auth mode (no `INGEST_TOKEN` required):

1. Create `packages/cloudflare-api/.dev.vars`
2. Add:
```env
APP_ENV=local
```

## Remote Deploy

1. Apply remote migration:
```bash
npm --workspace packages/cloudflare-api run db:migrate:remote
```

2. Set ingest token:
```bash
npx wrangler secret put INGEST_TOKEN --config packages/cloudflare-api/wrangler.jsonc
```

3. Deploy:
```bash
npm --workspace packages/cloudflare-api run deploy:cf
```

## Wiring Agents + Orchestrator

Set these env vars in root `.env`:

- `EVENT_RELAY_URL=https://auditguard.<your-domain>/api/events`
- `EVENT_RELAY_TOKEN=<same token as INGEST_TOKEN secret>`

When set, `agents/shared/hcs-client.ts` and `orchestrator/src/hcs-client.js` will POST every successfully published HCS message to this API.
