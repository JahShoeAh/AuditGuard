#!/bin/bash
# scripts/start-dev.sh — starts all AuditGuard services for local development.

export APP_ENV=local
export EVENT_RELAY_URL=http://localhost:4000/api/events

if [[ "$1" == "--test" ]]; then
  export VITE_TEST_MODE=true
else
  export DEMO_MODE=true
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cleanup() {
  echo ""
  echo "[startup] Shutting down..."
  kill 0 2>/dev/null
  wait 2>/dev/null
}
trap cleanup INT TERM

# ── Events API (port 4000) — log to file so crashes are visible ──
echo "[startup] Launching events-api..."
(cd packages/events-api && exec node src/index.js) > /tmp/ag-events-api.log 2>&1 &

# ── Dashboard API (port 3002) — log to file so crashes are visible ──
echo "[startup] Launching dashboard-server..."
(cd packages/dashboard && exec node server/index.js) > /tmp/ag-dashboard-api.log 2>&1 &

sleep 1

# Show if they started or crashed
echo "[startup] events-api log:"
cat /tmp/ag-events-api.log
echo "[startup] dashboard-api log:"
cat /tmp/ag-dashboard-api.log
echo "---"

# ── Core services ──
npm --prefix packages/dashboard run dev &
npm run orchestrator &
npm run agents &
npm run inft:listen &
npm run inft:listen:events &

echo "[startup] All services launched."

wait
