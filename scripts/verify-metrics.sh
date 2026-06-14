#!/bin/bash
# Verify Prometheus metrics endpoints for all services
# Run after starting orchestrator and agents

set -e

echo "🔍 Verifying Prometheus metrics endpoints..."
echo ""

services=(
  "9090:Orchestrator"
  "9091:Scanner"
  "9092:Static Analysis"
  "9093:Fuzzer"
  "9094:LLM"
  "9095:Dependency"
  "9096:Report"
  "9097:Alert"
)

failed=0
passed=0

for service in "${services[@]}"; do
  port="${service%%:*}"
  name="${service##*:}"

  printf "%-20s (port %s) ... " "$name" "$port"

  if curl -sf http://localhost:$port/metrics > /dev/null 2>&1; then
    echo "✅ OK"
    ((passed++))
  else
    echo "❌ FAILED"
    ((failed++))
  fi
done

echo ""
echo "Results: $passed passed, $failed failed"

if [ $failed -gt 0 ]; then
  echo ""
  echo "⚠️  Some services are not responding. Make sure all services are running:"
  echo "    npm run orchestrator   (orchestrator)"
  echo "    npm run agents         (all agents)"
  exit 1
fi

echo ""
echo "✅ All metrics endpoints are working!"
echo ""
echo "Example queries:"
echo "  curl http://localhost:9090/metrics | grep auditguard_auctions_created_total"
echo "  curl http://localhost:9091/metrics | grep auditguard_agent_bids_submitted_total"
