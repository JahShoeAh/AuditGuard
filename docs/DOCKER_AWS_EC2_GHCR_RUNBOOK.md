# Docker + AWS EC2 + GHCR Runbook (backend runtime)

## 1. Scope (Verified from this codebase)

Container runtime starts `npm run dev:backend` and runs four long-running backend processes from `package.json`:

1. `npm run orchestrator`
2. `npm run agents`
3. `npm run inft:listen`
4. `npm run inft:listen:events`

For full flow (scanner -> auction invite/bids -> findings -> report), the critical backend runtimes are:

1. `orchestrator` (`orchestrator/src/orchestrator.js`)
2. `agents` supervisor (`agents/run-all.ts`) which spawns scanner/static/fuzzer/llm/dependency/report/alert

Cloudflare API ingestion is produced by:

1. `agents/shared/hcs-client.ts` relay (`EVENT_RELAY_URL`, `EVENT_RELAY_TOKEN`)
2. `orchestrator/src/hcs-client.js` relay (`EVENT_RELAY_URL`, `EVENT_RELAY_TOKEN`)

Dashboard reads those events from:

1. `packages/dashboard/src/services/event-listener.js` (`VITE_EVENTS_API_BASE_URL`)

## 2. What this repository now includes

1. `Dockerfile.devall` to containerize the backend workload (`dev:backend`).
2. `.dockerignore` to keep secrets/build context clean.
3. `.github/workflows/ghcr-build-devall.yml` to build and push to GHCR.
4. `scripts/ec2/run-devall-container.sh` to pull and run the image on EC2.

## 3. Prerequisites (no implicit assumptions)

### AWS / EC2

1. An EC2 instance with Docker installed and running.
2. Security Group rules:
   1. SSH (`22`) from your admin IP.

### GitHub / GHCR

1. GitHub Actions enabled for this repository.
2. Repository permissions allow Actions to write packages.
3. A GHCR credential for EC2 pulls:
   1. Username: your GitHub username.
   2. Token: PAT with `read:packages` scope.

### Runtime environment file on EC2

Create an env file on EC2 (example path: `/opt/auditguard/.env`) containing the same working values you use locally for backend runtimes, including at least:

1. Hedera/operator/agent credentials used by orchestrator + agents.
2. `EVENT_RELAY_URL=https://<your-cloudflare-api-domain>/api/events`
3. `EVENT_RELAY_TOKEN=<same INGEST_TOKEN configured in Cloudflare API Worker>`

## 4. Build and push to GHCR (GitHub Actions)

Workflow file: `.github/workflows/ghcr-build-devall.yml`

Trigger it by:

1. Push to `main` or `integration`, or
2. Run manually via `workflow_dispatch`.

Published image naming:

1. `ghcr.io/<owner>/<repo>-devall:<tag>`

Tag strategy in workflow:

1. Branch tag (`main`, `integration`)
2. Commit SHA tag (`sha-<commit>`)
3. `latest` on default branch

## 5. Run on EC2

### 5.1 Log in to GHCR on EC2

```bash
echo "<GHCR_PAT>" | docker login ghcr.io -u "<GHCR_USERNAME>" --password-stdin
```

### 5.2 Pull and run container

Use the provided script:

```bash
IMAGE="ghcr.io/<owner>/<repo>-devall:main" \
ENV_FILE="/opt/auditguard/.env" \
CONTAINER_NAME="auditguard-devall" \
scripts/ec2/run-devall-container.sh
```

Optional: publish a port only if you intentionally expose one:

```bash
IMAGE="ghcr.io/<owner>/<repo>-devall:main" \
ENV_FILE="/opt/auditguard/.env" \
HOST_PORT="5173" \
CONTAINER_PORT="5173" \
scripts/ec2/run-devall-container.sh
```

If script is not yet on EC2, copy it first:

```bash
scp scripts/ec2/run-devall-container.sh <user>@<ec2-host>:~/
ssh <user>@<ec2-host> 'chmod +x ~/run-devall-container.sh'
```

Then run:

```bash
IMAGE="ghcr.io/<owner>/<repo>-devall:main" \
ENV_FILE="/opt/auditguard/.env" \
~/run-devall-container.sh
```

## 6. Cloudflare integration checks

After container starts:

1. Confirm the relay producer is active in logs:
```bash
docker logs -f auditguard-devall
```
2. Confirm Cloudflare API receives events:
```bash
curl "https://<your-cloudflare-api-domain>/api/events?limit=20"
```
3. Open deployed frontend and validate feed/report updates:
```text
https://<your-cloudflare-dashboard-domain>/
```

## 7. Upgrade and rollback

### Upgrade

1. Build/push new image via Actions.
2. Re-run `run-devall-container.sh` with new tag.

### Rollback

1. Re-run `run-devall-container.sh` with a previous known-good SHA tag.

## 8. Operational notes

1. This container does not run the dashboard frontend; frontend stays on Cloudflare.
2. For production hardening later, split backend processes into separate services.
3. Keep `EVENT_RELAY_TOKEN` rotated and never commit runtime `.env` files.

## 9. Official references

1. GitHub Actions variables and contexts: https://docs.github.com/actions/learn-github-actions/variables
2. GitHub Actions encrypted secrets: https://docs.github.com/actions/security-guides/encrypted-secrets
3. GitHub Container Registry (working with the registry): https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry
4. Publishing Docker images from GitHub Actions: https://docs.github.com/actions/publishing-packages/publishing-docker-images
5. Docker Engine install on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
6. AWS EC2 security groups: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html
7. Cloudflare Workers secrets (`wrangler secret`): https://developers.cloudflare.com/workers/configuration/secrets/
