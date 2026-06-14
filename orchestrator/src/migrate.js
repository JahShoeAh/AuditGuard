import knex from "knex";
import knexConfig from "../knexfile.js";

async function migrate() {
  const env = process.env.NODE_ENV || "development";
  const config = knexConfig[env];

  if (!config.connection) {
    console.error("Migration failed: DATABASE_URL is not configured");
    console.error("Please set DATABASE_URL in your .env file");
    process.exit(1);
  }

  const db = knex(config);

  try {
    console.log(`Running migrations in ${env} environment...`);
    const [batch, migrations] = await db.migrate.latest();

    if (migrations.length === 0) {
      console.log("✓ Database is already up to date");
    } else {
      console.log(`✓ Ran ${migrations.length} migration(s):`);
      migrations.forEach(name => console.log(`  - ${name}`));
    }
  } catch (err) {
    console.error("Migration failed:", err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

migrate();
