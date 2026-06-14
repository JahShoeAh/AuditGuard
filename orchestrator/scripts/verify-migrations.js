/**
 * Verify migration framework setup
 * Checks that all migration files exist and are properly structured
 */

import { readdir, readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "src", "migrations");

const REQUIRED_MIGRATIONS = [
  "001_initial_schema.sql",
  "002_add_orchestrator_state.sql",
  "003_add_indexes.sql",
];

const REQUIRED_FILES = [
  { path: "knexfile.js", description: "Knex configuration" },
  { path: "src/migrate.js", description: "Migration runner" },
  { path: "src/migrations", description: "Migrations directory" },
];

async function verifyMigrationSetup() {
  console.log("Verifying migration framework setup...\n");

  let errors = 0;

  // Check required files exist
  console.log("1. Checking required files:");
  for (const file of REQUIRED_FILES) {
    try {
      const fullPath = join(__dirname, "..", file.path);
      await access(fullPath);
      console.log(`   ✓ ${file.description} (${file.path})`);
    } catch (err) {
      console.error(`   ✗ ${file.description} (${file.path}) - NOT FOUND`);
      errors++;
    }
  }

  // Check migration files
  console.log("\n2. Checking migration files:");
  try {
    const files = await readdir(migrationsDir);
    const sqlFiles = files.filter(f => f.endsWith(".sql")).sort();

    for (const expected of REQUIRED_MIGRATIONS) {
      if (sqlFiles.includes(expected)) {
        const content = await readFile(join(migrationsDir, expected), "utf-8");
        const hasCreateTable = content.includes("CREATE TABLE");
        const hasIfNotExists = content.includes("IF NOT EXISTS");

        if (hasCreateTable && hasIfNotExists) {
          console.log(`   ✓ ${expected} (${content.length} bytes, idempotent)`);
        } else {
          console.log(`   ⚠ ${expected} (${content.length} bytes, may not be idempotent)`);
        }
      } else {
        console.error(`   ✗ ${expected} - NOT FOUND`);
        errors++;
      }
    }

    // Check for unexpected files
    const unexpected = sqlFiles.filter(f => !REQUIRED_MIGRATIONS.includes(f));
    if (unexpected.length > 0) {
      console.log(`\n   Additional migrations found: ${unexpected.join(", ")}`);
    }
  } catch (err) {
    console.error(`   ✗ Failed to read migrations directory: ${err.message}`);
    errors++;
  }

  // Check package.json scripts
  console.log("\n3. Checking package.json scripts:");
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);

    const requiredScripts = ["migrate", "migrate:make", "migrate:rollback"];
    for (const script of requiredScripts) {
      if (pkg.scripts && pkg.scripts[script]) {
        console.log(`   ✓ ${script}: ${pkg.scripts[script]}`);
      } else {
        console.error(`   ✗ ${script} script not found`);
        errors++;
      }
    }

    // Check if start script runs migrations
    if (pkg.scripts.start && pkg.scripts.start.includes("migrate")) {
      console.log(`   ✓ start script runs migrations: ${pkg.scripts.start}`);
    } else {
      console.error(`   ✗ start script does not run migrations`);
      errors++;
    }

    // Check if knex is installed
    if (pkg.dependencies && pkg.dependencies.knex) {
      console.log(`   ✓ knex dependency: ${pkg.dependencies.knex}`);
    } else {
      console.error(`   ✗ knex dependency not found`);
      errors++;
    }
  } catch (err) {
    console.error(`   ✗ Failed to read package.json: ${err.message}`);
    errors++;
  }

  // Check knexfile.js configuration
  console.log("\n4. Checking Knex configuration:");
  try {
    const knexfilePath = join(__dirname, "..", "knexfile.js");
    const content = await readFile(knexfilePath, "utf-8");

    const checks = [
      { pattern: /client:\s*["']pg["']/, name: "PostgreSQL client" },
      { pattern: /migrations:/, name: "Migrations config" },
      { pattern: /directory:\s*["'].\/src\/migrations["']/, name: "Migrations directory" },
      { pattern: /tableName:\s*["']knex_migrations["']/, name: "Migrations table name" },
      { pattern: /extension:\s*["']sql["']/, name: "SQL file extension" },
      { pattern: /development:/, name: "Development environment" },
      { pattern: /production:/, name: "Production environment" },
    ];

    for (const check of checks) {
      if (check.pattern.test(content)) {
        console.log(`   ✓ ${check.name}`);
      } else {
        console.error(`   ✗ ${check.name} - NOT FOUND`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`   ✗ Failed to read knexfile.js: ${err.message}`);
    errors++;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  if (errors === 0) {
    console.log("✓ All checks passed! Migration framework is properly configured.");
    console.log("\nNext steps:");
    console.log("  1. Set DATABASE_URL in .env");
    console.log("  2. Run: npm run migrate");
    console.log("  3. Verify: psql $DATABASE_URL -c '\\dt'");
    return 0;
  } else {
    console.error(`✗ ${errors} error(s) found. Please fix the issues above.`);
    return 1;
  }
}

verifyMigrationSetup()
  .then(code => process.exit(code))
  .catch(err => {
    console.error("Verification failed:", err.message);
    process.exit(1);
  });
