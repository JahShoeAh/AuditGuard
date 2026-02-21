#!/bin/bash
# scripts/start-dev.sh — starts all AuditGuard services for local development.

# Load .env so all child processes inherit DATABASE_URL, keys, etc.
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Override with dev-specific values (win over .env)
export APP_ENV=local
export EVENT_RELAY_URL=http://localhost:4000/api/events

if [[ "$1" == "--test" ]]; then
  export VITE_TEST_MODE=true
else
  export DEMO_MODE=true
fi

# Append homebrew as fallback (don't override conda/nvm node)
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

cleanup() {
  echo ""
  echo "[startup] Shutting down..."
  kill 0 2>/dev/null
  wait 2>/dev/null
}
trap cleanup INT TERM

echo "[startup] Launching events-api..."
(cd packages/events-api && exec node src/index.js) > /tmp/ag-events-api.log 2>&1 &

sleep 1

echo "[startup] events-api log:"
cat /tmp/ag-events-api.log
echo "---"

npm --prefix packages/dashboard run dev &
npm run orchestrator &
npm run agents &
npm run inft:listen &
npm run inft:listen:events &

echo "[startup] All services launched."

wait
