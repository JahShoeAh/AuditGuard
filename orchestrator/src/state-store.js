import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let _pool = undefined;

function getPool() {
  if (_pool !== undefined) return _pool;
  if (!process.env.DATABASE_URL) {
    console.warn("[state-store] DATABASE_URL not set — state persistence is disabled.");
    _pool = null;
    return null;
  }
  try {
    const pg = require("pg");
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    return _pool;
  } catch (err) {
    console.warn(
      `[state-store] pg dependency unavailable; state persistence disabled: ${err instanceof Error ? err.message : String(err)}`
    );
    _pool = null;
    return null;
  }
}

/**
 * OrchestratorStateStore provides persistent storage for orchestrator runtime state.
 * Roster and event cache are stored in a generic key-value table.
 */
export class OrchestratorStateStore {
  constructor(db = null) {
    this.db = db ?? getPool();
  }

  /**
   * Save the agent roster to the database.
   * @param {Map} roster - Map of agentId -> agent data
   * @returns {Promise<void>}
   */
  async saveRoster(roster) {
    if (!this.db) return;
    const value = JSON.stringify(Array.from(roster.entries()));
    try {
      await this.db.query(
        `INSERT INTO orchestrator_state (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE
         SET value = $2, updated_at = NOW()`,
        ["roster", value]
      );
    } catch (err) {
      console.error(
        `[state-store] Failed to save roster: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Load the agent roster from the database.
   * @returns {Promise<Map>}
   */
  async loadRoster() {
    if (!this.db) return new Map();
    try {
      const result = await this.db.query(
        `SELECT value FROM orchestrator_state WHERE key = $1`,
        ["roster"]
      );
      if (result.rows.length === 0) return new Map();
      return new Map(JSON.parse(result.rows[0].value));
    } catch (err) {
      console.error(
        `[state-store] Failed to load roster: ${err instanceof Error ? err.message : String(err)}`
      );
      return new Map();
    }
  }

  /**
   * Save the event cache to the database.
   * @param {Map} cache - Map of event data
   * @returns {Promise<void>}
   */
  async saveEventCache(cache) {
    if (!this.db) return;
    const value = JSON.stringify(Array.from(cache.entries()));
    try {
      await this.db.query(
        `INSERT INTO orchestrator_state (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE
         SET value = $2, updated_at = NOW()`,
        ["eventCache", value]
      );
    } catch (err) {
      console.error(
        `[state-store] Failed to save event cache: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Load the event cache from the database.
   * @returns {Promise<Map>}
   */
  async loadEventCache() {
    if (!this.db) return new Map();
    try {
      const result = await this.db.query(
        `SELECT value FROM orchestrator_state WHERE key = $1`,
        ["eventCache"]
      );
      if (result.rows.length === 0) return new Map();
      return new Map(JSON.parse(result.rows[0].value));
    } catch (err) {
      console.error(
        `[state-store] Failed to load event cache: ${err instanceof Error ? err.message : String(err)}`
      );
      return new Map();
    }
  }

  /**
   * Health check for database connectivity.
   * @returns {Promise<void>}
   * @throws {Error} if database is unavailable or query fails
   */
  async healthCheck() {
    if (!this.db) {
      throw new Error('Database not configured');
    }
    await this.db.query('SELECT 1');
  }

  /**
   * Close the database connection pool.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.db) {
      try {
        await this.db.end();
      } catch (err) {
        console.error(
          `[state-store] Failed to close database pool: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
