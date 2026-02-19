#!/usr/bin/env bash
set -o pipefail

# Keep core system bins first so npm can spawn `sh` reliably in non-login shells.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SUMMARY="recon/test-matrix.csv"
: > "$SUMMARY"
echo "suite,command,exit_code,duration_sec,log" >> "$SUMMARY"

run_suite() {
  local suite="$1"
  shift
  local cmd="$*"
  local log="recon/test-logs/${suite}.log"
  local start end dur rc

  start=$(date +%s)
  /bin/bash -c "$cmd" >"$log" 2>&1
  rc=$?
  end=$(date +%s)
  dur=$((end - start))

  echo "${suite},\"${cmd//\"/\"\"}\",${rc},${dur},${log}" >> "$SUMMARY"
  echo "[$suite] exit=${rc} duration=${dur}s"
}

run_suite "contracts_auditguard" 'npm exec -- hardhat test packages/contracts/test/AuditGuard.test.js --config packages/contracts/hardhat.config.js'
run_suite "contracts_auditscheduler" 'npm exec -- hardhat test packages/contracts/test/AuditScheduler.test.js --config packages/contracts/hardhat.config.js'
run_suite "agents_vitest_all" 'npm --workspace agents run test'
run_suite "orchestrator_mocks" 'node orchestrator/test/run-tests.js'
run_suite "orchestrator_offline_live_flow" 'node orchestrator/test/offline-live-flow.test.js'
run_suite "orchestrator_e2e_simulation" 'node orchestrator/test/e2e-simulation.test.js'
run_suite "dashboard_store_test" 'npm --prefix packages/dashboard run test -- src/__tests__/store.test.js'
run_suite "dashboard_event_listener_test" 'npm --prefix packages/dashboard run test -- src/__tests__/event-listener.test.js'
run_suite "dashboard_build" 'npm --prefix packages/dashboard run build'
run_suite "dashboard_preview_smoke" 'npm --prefix packages/dashboard run preview -- --host 127.0.0.1 --port 4173 > recon/test-logs/dashboard_preview_server.log 2>&1 & pid=$!; sleep 5; curl -sf http://127.0.0.1:4173 >/dev/null 2>&1; rc=$?; kill $pid >/dev/null 2>&1; wait $pid >/dev/null 2>&1 || true; exit $rc'
run_suite "inft_module_load_smoke" "node -e 'require(\"./packages/inft/src/inft-service.js\"); console.log(\"inft-service module load ok\");'"
run_suite "inft_discovery_listener_startup" 'node packages/inft/src/discovery-listener.js > recon/test-logs/inft_discovery_listener_runtime.log 2>&1 & pid=$!; sleep 5; if kill -0 $pid >/dev/null 2>&1; then kill $pid >/dev/null 2>&1; wait $pid >/dev/null 2>&1 || true; exit 0; else wait $pid; exit $?; fi'
run_suite "inft_event_listener_startup" 'node packages/inft/src/event-listener.js > recon/test-logs/inft_event_listener_runtime.log 2>&1 & pid=$!; sleep 5; if kill -0 $pid >/dev/null 2>&1; then kill $pid >/dev/null 2>&1; wait $pid >/dev/null 2>&1 || true; exit 0; else wait $pid; exit $?; fi'

echo "\nSummary:"
cat "$SUMMARY"
