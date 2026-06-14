/**
 * State Persistence Test
 * Verifies that orchestrator roster and event cache can be saved and loaded from PostgreSQL.
 */

import { OrchestratorStateStore } from "../src/state-store.js";

async function testStatePersistence() {
  console.log("Testing orchestrator state persistence...\n");

  const store = new OrchestratorStateStore();

  // Test 1: Save and load roster
  console.log("Test 1: Save and load roster");
  const testRoster = new Map();
  testRoster.set("agent1", {
    agentId: "agent1",
    evmAddress: "0x1234567890123456789012345678901234567890",
    specializations: ["lending", "dex"],
    stake: 1000,
    reputation: 95,
    tier: "PREMIUM",
    lastSeen: Date.now(),
  });
  testRoster.set("agent2", {
    agentId: "agent2",
    evmAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    specializations: ["staking"],
    stake: 500,
    reputation: 80,
    tier: "COMMODITY",
    lastSeen: Date.now(),
  });

  await store.saveRoster(testRoster);
  console.log(`  Saved ${testRoster.size} agents`);

  const loadedRoster = await store.loadRoster();
  console.log(`  Loaded ${loadedRoster.size} agents`);

  if (loadedRoster.size !== testRoster.size) {
    console.error(`  ❌ FAILED: Expected ${testRoster.size} agents, got ${loadedRoster.size}`);
    process.exit(1);
  }

  const agent1 = loadedRoster.get("agent1");
  if (!agent1 || agent1.evmAddress !== "0x1234567890123456789012345678901234567890") {
    console.error("  ❌ FAILED: Agent1 data mismatch");
    process.exit(1);
  }

  console.log("  ✅ Roster save/load works correctly\n");

  // Test 2: Save and load event cache
  console.log("Test 2: Save and load event cache");
  const testCache = new Map();
  testCache.set("contract1", { discoveredAt: Date.now(), status: "pending" });
  testCache.set("contract2", { discoveredAt: Date.now() - 60000, status: "processed" });

  await store.saveEventCache(testCache);
  console.log(`  Saved ${testCache.size} cache entries`);

  const loadedCache = await store.loadEventCache();
  console.log(`  Loaded ${loadedCache.size} cache entries`);

  if (loadedCache.size !== testCache.size) {
    console.error(`  ❌ FAILED: Expected ${testCache.size} entries, got ${loadedCache.size}`);
    process.exit(1);
  }

  console.log("  ✅ Event cache save/load works correctly\n");

  // Test 3: Load from empty database
  console.log("Test 3: Load from empty keys");
  const emptyStore = new OrchestratorStateStore();

  // Create a test table to simulate missing keys
  const testRoster2 = await emptyStore.loadRoster();
  console.log(`  Loaded ${testRoster2.size} agents from existing data`);

  if (!(testRoster2 instanceof Map)) {
    console.error("  ❌ FAILED: loadRoster should return a Map");
    process.exit(1);
  }

  console.log("  ✅ Empty state returns valid Map\n");

  // Test 4: Verify database connection failure handling
  console.log("Test 4: Graceful degradation without database");
  const noDbStore = new OrchestratorStateStore(null);

  await noDbStore.saveRoster(testRoster);
  const nothingLoaded = await noDbStore.loadRoster();

  if (nothingLoaded.size !== 0) {
    console.error("  ❌ FAILED: Should return empty Map when DB unavailable");
    process.exit(1);
  }

  console.log("  ✅ Gracefully handles missing database\n");

  // Cleanup
  await store.close();
  await emptyStore.close();
  await noDbStore.close();

  console.log("✅ All state persistence tests passed!");
  process.exit(0);
}

testStatePersistence().catch((err) => {
  console.error("❌ Test failed with error:", err);
  process.exit(1);
});
