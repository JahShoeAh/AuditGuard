/**
 * Migration Framework Integration Test
 *
 * Tests that migrations can be run successfully and are idempotent.
 * Requires a running PostgreSQL instance with DATABASE_URL configured.
 */

import knex from "knex";
import knexConfig from "../knexfile.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Skip if DATABASE_URL not configured
if (!process.env.DATABASE_URL) {
  console.log("⊘ Skipping migration tests - DATABASE_URL not configured");
  process.exit(0);
}

const env = process.env.NODE_ENV || "development";
const config = knexConfig[env];

async function testMigrations() {
  const db = knex(config);
  let exitCode = 0;

  try {
    console.log("Testing migration framework...\n");

    // Test 1: Run migrations
    console.log("1. Running migrations...");
    const [batch, migrations] = await db.migrate.latest();

    if (migrations.length > 0) {
      console.log(`   ✓ Applied ${migrations.length} migration(s):`);
      migrations.forEach(name => console.log(`     - ${name}`));
    } else {
      console.log("   ✓ All migrations already applied");
    }

    // Test 2: Verify idempotency
    console.log("\n2. Testing idempotency (running migrations again)...");
    const [batch2, migrations2] = await db.migrate.latest();

    if (migrations2.length === 0) {
      console.log("   ✓ No additional migrations applied (idempotent)");
    } else {
      console.error(`   ✗ Unexpected migrations applied: ${migrations2.join(", ")}`);
      exitCode = 1;
    }

    // Test 3: Verify migration tracking table exists
    console.log("\n3. Verifying migration tracking table...");
    const hasTable = await db.schema.hasTable("knex_migrations");

    if (hasTable) {
      const migrationRecords = await db("knex_migrations").select("*").orderBy("id");
      console.log(`   ✓ knex_migrations table exists with ${migrationRecords.length} record(s)`);

      const expectedMigrations = [
        "001_initial_schema.sql",
        "002_add_orchestrator_state.sql",
        "003_add_indexes.sql",
      ];

      const appliedNames = migrationRecords.map(r => r.name);
      for (const expected of expectedMigrations) {
        if (appliedNames.includes(expected)) {
          console.log(`     ✓ ${expected}`);
        } else {
          console.error(`     ✗ ${expected} not found in migration history`);
          exitCode = 1;
        }
      }
    } else {
      console.error("   ✗ knex_migrations table does not exist");
      exitCode = 1;
    }

    // Test 4: Verify key tables were created
    console.log("\n4. Verifying schema tables...");
    const expectedTables = [
      "audit_reports",
      "audit_events",
      "bid_skips",
      "pending_findings",
      "audit_jobs",
      "registered_agents",
      "audit_schedules",
      "audit_vaults",
      "orchestrator_state",
    ];

    for (const tableName of expectedTables) {
      const exists = await db.schema.hasTable(tableName);
      if (exists) {
        console.log(`   ✓ ${tableName}`);
      } else {
        console.error(`   ✗ ${tableName} not found`);
        exitCode = 1;
      }
    }

    // Test 5: Verify orchestrator_state table structure
    console.log("\n5. Verifying orchestrator_state table structure...");
    const hasOrchestratorState = await db.schema.hasTable("orchestrator_state");

    if (hasOrchestratorState) {
      const columns = await db("orchestrator_state").columnInfo();
      const requiredColumns = ["key", "value", "updated_at"];

      for (const col of requiredColumns) {
        if (columns[col]) {
          console.log(`   ✓ Column '${col}' exists`);
        } else {
          console.error(`   ✗ Column '${col}' missing`);
          exitCode = 1;
        }
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    if (exitCode === 0) {
      console.log("✓ All migration tests passed!");
    } else {
      console.error("✗ Some migration tests failed");
    }

  } catch (err) {
    console.error("\n✗ Migration test failed:", err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    await db.destroy();
    process.exit(exitCode);
  }
}

testMigrations();
