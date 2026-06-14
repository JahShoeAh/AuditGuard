#!/usr/bin/env node
/**
 * Verification script for persistent orchestrator roster storage.
 * Simulates orchestrator lifecycle with restart to verify state persistence.
 */

import { OrchestratorAgent } from "../src/orchestrator.js";
import { createLogger } from "../src/logger.js";
import { Roster } from "../src/roster.js";
import { OrchestratorStateStore } from "../src/state-store.js";

const log = createLogger("persistence-verify");

async function verifyPersistence() {
  log.info("=== Orchestrator Persistence Verification ===\n");

  // Phase 1: Create orchestrator and populate roster
  log.info("Phase 1: Starting first orchestrator instance");

  const stateStore1 = new OrchestratorStateStore();
  const roster1 = new Roster(log);

  // Simulate some agents joining the roster
  roster1.upsert({
    agentId: "scanner-001",
    evmAddress: "0x1111111111111111111111111111111111111111",
    specializations: ["any"],
    stake: 1000,
    reputation: 95,
    tier: "PREMIUM",
  });

  roster1.upsert({
    agentId: "static-001",
    evmAddress: "0x2222222222222222222222222222222222222222",
    specializations: ["lending", "dex"],
    stake: 800,
    reputation: 88,
    tier: "COMMODITY",
  });

  roster1.upsert({
    agentId: "fuzzer-001",
    evmAddress: "0x3333333333333333333333333333333333333333",
    specializations: ["staking", "vault"],
    stake: 600,
    reputation: 75,
    tier: "COMMODITY",
  });

  log.info(`Roster populated with ${roster1.agents.size} agents`);

  // Create recentDiscovery cache
  const recentDiscovery1 = new Map();
  recentDiscovery1.set("0xcontract1", { discoveredAt: Date.now(), processed: false });
  recentDiscovery1.set("0xcontract2", { discoveredAt: Date.now() - 30000, processed: true });

  log.info(`Event cache populated with ${recentDiscovery1.size} entries`);

  // Save state
  await stateStore1.saveRoster(roster1.agents);
  await stateStore1.saveEventCache(recentDiscovery1);

  log.info("State saved to database");
  await stateStore1.close();

  log.info("First orchestrator instance shut down\n");

  // Phase 2: Simulate restart - create new orchestrator and load state
  log.info("Phase 2: Starting second orchestrator instance (simulating restart)");

  const stateStore2 = new OrchestratorStateStore();

  // Load persisted state
  const loadedRoster = await stateStore2.loadRoster();
  const loadedCache = await stateStore2.loadEventCache();

  log.info(`Loaded ${loadedRoster.size} agents from persistent storage`);
  log.info(`Loaded ${loadedCache.size} event cache entries from persistent storage`);

  // Verify roster integrity
  const expectedAgents = ["scanner-001", "static-001", "fuzzer-001"];
  let allAgentsPresent = true;

  for (const agentId of expectedAgents) {
    const agent = loadedRoster.get(agentId);
    if (!agent) {
      log.error(`❌ Missing agent: ${agentId}`);
      allAgentsPresent = false;
    } else {
      log.info(`✅ Agent ${agentId} restored (stake: ${agent.stake}, rep: ${agent.reputation})`);
    }
  }

  // Verify event cache integrity
  const expectedContracts = ["0xcontract1", "0xcontract2"];
  let allCachePresent = true;

  for (const contractAddr of expectedContracts) {
    const entry = loadedCache.get(contractAddr);
    if (!entry) {
      log.error(`❌ Missing cache entry: ${contractAddr}`);
      allCachePresent = false;
    } else {
      log.info(`✅ Cache entry ${contractAddr} restored (processed: ${entry.processed})`);
    }
  }

  await stateStore2.close();

  // Phase 3: Verification results
  log.info("\n=== Verification Results ===");

  if (allAgentsPresent && loadedRoster.size === 3) {
    log.info("✅ Roster persistence: PASSED");
  } else {
    log.error("❌ Roster persistence: FAILED");
    process.exit(1);
  }

  if (allCachePresent && loadedCache.size === 2) {
    log.info("✅ Event cache persistence: PASSED");
  } else {
    log.error("❌ Event cache persistence: FAILED");
    process.exit(1);
  }

  log.info("\n✅ All persistence verification tests passed!");
  log.info("Orchestrator roster and event cache survive restarts.");

  process.exit(0);
}

verifyPersistence().catch((err) => {
  log.error(`Verification failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
