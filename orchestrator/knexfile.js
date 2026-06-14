import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const dotenv = _require("dotenv");
  dotenv.config({ path: join(__dirname, "..", ".env") });
} catch {
  // dotenv optional
}

export default {
  development: {
    client: "pg",
    connection: process.env.DATABASE_URL || "postgresql://auditguard:dev@localhost:5432/auditguard",
    migrations: {
      directory: "./src/migrations",
      tableName: "knex_migrations",
      extension: "sql",
    },
    pool: {
      min: 2,
      max: 10
    }
  },

  production: {
    client: "pg",
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: "./src/migrations",
      tableName: "knex_migrations",
      extension: "sql",
    },
    pool: {
      min: 2,
      max: 10
    }
  }
};
