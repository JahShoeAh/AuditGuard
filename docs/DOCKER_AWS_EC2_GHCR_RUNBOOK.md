# Docker + AWS EC2 + GHCR Runbook (backend runtime)

## 1. Scope (Verified from this codebase)

Container runtime starts `npm run dev:backend` and runs five long-running backend processes from `package.json`:

1. `npm run orchestrator`
2. `npm run agents`
3. `npm run inft:listen`
4. `npm run inft:listen:events`
5. `node packages/events-api/src/index.js` (Events API on port 4000)

For full flow (scanner -> auction invite/bids -> findings -> report), the critical backend runtimes are:

1. `orchestrator` (`orchestrator/src/orchestrator.js`)
2. `agents` supervisor (`agents/run-all.ts`) which spawns scanner/static/fuzzer/llm/dependency/report/alert

Events API ingestion is produced by:

1. `agents/shared/hcs-client.ts` relay (`EVENT_RELAY_URL`, `EVENT_RELAY_TOKEN`)
2. `orchestrator/src/hcs-client.js` relay (`EVENT_RELAY_URL`, `EVENT_RELAY_TOKEN`)

Dashboard reads those events from:

1. `packages/dashboard/src/services/event-listener.js` (`VITE_EVENTS_API_BASE_URL`)

## 2. What this repository now includes

1. `Dockerfile.devall` to containerize the backend workload (`dev:backend`), including the Events API.
2. `.dockerignore` to keep secrets/build context clean.
3. `.github/workflows/ghcr-build-devall.yml` to build and push to GHCR, then deploy to EC2.
4. `.github/workflows/deploy-dashboard-vercel.yml` to build and deploy the dashboard to Vercel.
5. `scripts/ec2/run-devall-container.sh` to pull and run the image on EC2.

## 3. Prerequisites (no implicit assumptions)

### AWS / EC2

1. An EC2 instance with Docker installed and running.
2. Security Group rules:
   1. SSH (`22`) from your admin IP.
   2. TCP `4000` for Events API (restrict to Vercel IP ranges or use a reverse proxy for HTTPS).

### GitHub / GHCR

1. GitHub Actions enabled for this repository.
2. Repository permissions allow Actions to write packages.
3. A GHCR credential for EC2 pulls:
   1. Username: your GitHub username.
   2. Token: PAT with `read:packages` scope.

### Vercel (frontend)

1. Vercel project connected to the repo with root directory set to `packages/dashboard`.
2. Framework preset: Vite. Build command and output directory configured via `packages/dashboard/vercel.json`.

### Runtime environment file on EC2

Create an env file on EC2 (example path: `/opt/auditguard/.env`) containing the same working values you use locally for backend runtimes, including at least:

1. Hedera/operator/agent credentials used by orchestrator + agents.
2. `EVENT_RELAY_URL=http://localhost:4000/api/events` (Events API runs in the same container)
3. `EVENT_RELAY_TOKEN=<ingest token>`
4. `EVENTS_API_PORT=4000`
5. `EVENTS_API_INGEST_TOKEN=<same as EVENT_RELAY_TOKEN>`
6. `EVENTS_API_FRONTEND_ORIGIN=https://<your-vercel-domain>` (CORS origin for dashboard)

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

### 4.1 GitHub Secrets required for backend CI/CD

Set these repository secrets before relying on automatic deploy:

1. `EC2_HOST` - EC2 public hostname or IPv4.
2. `EC2_USERNAME` - SSH username (for Ubuntu AMI, usually `ubuntu`).
3. `EC2_SSH_KEY` - private SSH key content used by Actions to connect.
4. `EC2_PORT` - SSH port (typically `22`).
5. `EC2_ENV_FILE` - absolute path on EC2 to runtime env file (example `/opt/auditguard/.env`).
6. `EC2_CONTAINER_NAME` - container name (example `auditguard-devall`).
7. `GHCR_USERNAME` - GitHub username used for package login.
8. `GHCR_READ_TOKEN` - token with package read permission for pulling from GHCR.

### 4.2 Backend deployment behavior

1. On push to `main`/`integration`, image is built and pushed to GHCR.
2. On push to `main`, workflow automatically SSHes to EC2 and redeploys:
   1. Pulls image `ghcr.io/<owner>/<repo>-devall:sha-<commit>`.
   2. Stops/removes existing container.
   3. Starts new container with `--env-file` and `-p 4000:4000`.

## 5. Frontend CI/CD (Vercel)

Workflow file: `.github/workflows/deploy-dashboard-vercel.yml`

### 5.1 GitHub Secrets required for frontend CI/CD

1. `VERCEL_TOKEN` - Vercel deployment token.
2. `VERCEL_ORG_ID` - Vercel team/org ID.
3. `VERCEL_PROJECT_ID` - Vercel project ID for dashboard.
4. `VITE_EVENTS_API_BASE_URL` - EC2 events API URL (e.g. `https://api.auditguard.dev/api`).

### 5.2 Frontend deployment behavior

1. On push to `main` with dashboard/sdk/lockfile changes, workflow:
   1. Installs dependencies.
   2. Builds dashboard with Vite environment variables.
   3. Deploys to Vercel production via `amondnet/vercel-action`.

## 6. Run on EC2 (manual fallback)

### 6.1 Log in to GHCR on EC2

```bash
echo "<GHCR_PAT>" | docker login ghcr.io -u "<GHCR_USERNAME>" --password-stdin
```

### 6.2 Pull and run container

Use the provided script:

```bash
IMAGE="ghcr.io/<owner>/<repo>-devall:main" \
ENV_FILE="/opt/auditguard/.env" \
CONTAINER_NAME="auditguard-devall" \
HOST_PORT="4000" \
CONTAINER_PORT="4000" \
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
HOST_PORT="4000" \
CONTAINER_PORT="4000" \
~/run-devall-container.sh
```

## 7. Integration checks

After container starts:

1. Confirm the relay producer is active in logs:
```bash
docker logs -f auditguard-devall
```
2. Confirm Events API is responding:
```bash
curl "http://<ec2-host>:4000/api/health"
curl "http://<ec2-host>:4000/api/events?limit=20"
```
3. Open deployed Vercel frontend and validate feed/report updates:
```text
https://<your-vercel-domain>/
```

## 8. Upgrade and rollback

### Upgrade

1. Build/push new image via Actions.
2. Re-run `run-devall-container.sh` with new tag.

### Rollback

1. Re-run `run-devall-container.sh` with a previous known-good SHA tag.

## 9. Operational notes

1. This container does not run the dashboard frontend; frontend is deployed to Vercel.
2. Events API runs inside the same container and stores data in SQLite at `data/events.db`.
3. For production hardening later, split backend processes into separate services.
4. Consider placing Caddy or nginx in front of port 4000 for HTTPS termination.
5. Keep `EVENT_RELAY_TOKEN` rotated and never commit runtime `.env` files.

## 10. Official references

1. GitHub Actions variables and contexts: https://docs.github.com/actions/learn-github-actions/variables
2. GitHub Actions encrypted secrets: https://docs.github.com/actions/security-guides/encrypted-secrets
3. GitHub Container Registry (working with the registry): https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry
4. Publishing Docker images from GitHub Actions: https://docs.github.com/actions/publishing-packages/publishing-docker-images
5. Docker Engine install on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
6. AWS EC2 security groups: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html
7. Vercel CLI & deployment: https://vercel.com/docs/cli
