#!/usr/bin/env node
/**
 * db-reset-events.js
 * Truncates all event-related tables and resets their sequences.
 * Usage: node scripts/db-reset-events.js
 */

require("dotenv").config();
const { execSync } = require("child_process");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set in .env");

const sql =
  "TRUNCATE audit_events, bid_skips, audit_jobs, registered_agents, " +
  "audit_schedules, audit_vaults, audit_reports RESTART IDENTITY CASCADE;";

execSync(`psql "${url}" -c "${sql}"`, { stdio: "inherit" });
