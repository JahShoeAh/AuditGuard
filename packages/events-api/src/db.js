'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.EVENTS_DB_PATH
  || path.join(__dirname, '..', 'data', 'events.db');

let db;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT,
      topic_id    TEXT,
      message_type TEXT,
      agent_id    TEXT,
      message_timestamp TEXT,
      payload_json TEXT,
      raw_json    TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bid_skips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER REFERENCES audit_events(id),
      job_id      TEXT,
      agent_id    TEXT,
      reason_code TEXT,
      reason      TEXT,
      invite_budget REAL,
      bid_amount  REAL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_clients (
      job_id           TEXT PRIMARY KEY,
      contract_address TEXT,
      deployer_address TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_reports (
      job_id          TEXT PRIMARY KEY,
      contract_address TEXT,
      deployer_address TEXT,
      report_hash     TEXT,
      findings_json   TEXT,
      total_findings  INTEGER DEFAULT 0,
      critical_count  INTEGER DEFAULT 0,
      settled_at      TEXT,
      raw_json        TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS marketplace_purchases (
      id               TEXT PRIMARY KEY,
      listing_id       TEXT,
      buyer_address    TEXT,
      job_id           TEXT,
      contract_address TEXT,
      tx_hash          TEXT,
      price_guard      REAL,
      category         TEXT,
      purchased_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hcs_cursors (
      topic_key  TEXT PRIMARY KEY,
      last_seq   INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_nonces (
      wallet_address TEXT,
      nonce          TEXT,
      expires_at     INTEGER,
      used           INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(message_type);
    CREATE INDEX IF NOT EXISTS idx_audit_events_agent ON audit_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_reports_deployer ON audit_reports(deployer_address);
    CREATE INDEX IF NOT EXISTS idx_job_clients_deployer ON job_clients(deployer_address);
  `);
}

// ── Audit events ────────────────────────────────────────────

function insertAuditEvent({ source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson }) {
  return getDb()
    .prepare(`INSERT INTO audit_events (source, topic_id, message_type, agent_id, message_timestamp, payload_json, raw_json)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(source, topicId, messageType, agentId, messageTimestamp, payloadJson, rawJson);
}

function getAuditEvents({ type, since, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM audit_events WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND message_type = ?'; params.push(type); }
  if (since) { sql += ' AND id > ?'; params.push(since); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params);
}

function getLastAuditEventId() {
  const row = getDb().prepare('SELECT MAX(id) as maxId FROM audit_events').get();
  return row?.maxId ?? 0;
}

// ── Job clients ─────────────────────────────────────────────

function upsertJobClient({ jobId, contractAddress, deployerAddress }) {
  return getDb()
    .prepare(`INSERT OR REPLACE INTO job_clients (job_id, contract_address, deployer_address)
              VALUES (?, ?, ?)`)
    .run(jobId, contractAddress, deployerAddress);
}

function getJobClient(jobId) {
  return getDb().prepare('SELECT * FROM job_clients WHERE job_id = ?').get(jobId);
}

// ── Audit reports ────────────────────────────────────────────

function upsertAuditReport({ jobId, contractAddress, deployerAddress, reportHash, findingsJson, totalFindings, criticalCount, settledAt, rawJson }) {
  return getDb()
    .prepare(`INSERT OR REPLACE INTO audit_reports
              (job_id, contract_address, deployer_address, report_hash, findings_json, total_findings, critical_count, settled_at, raw_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobId, contractAddress, deployerAddress, reportHash, findingsJson, totalFindings, criticalCount, settledAt, rawJson);
}

function getAuditReport(jobId) {
  return getDb().prepare('SELECT * FROM audit_reports WHERE job_id = ?').get(jobId);
}

function listAuditReports({ limit = 20, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT job_id, contract_address, deployer_address, report_hash, total_findings, critical_count, settled_at, created_at FROM audit_reports ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

// ── Marketplace purchases ────────────────────────────────────

function insertMarketplacePurchase({ id, listingId, buyerAddress, jobId, contractAddress, txHash, priceGuard, category }) {
  return getDb()
    .prepare(`INSERT OR IGNORE INTO marketplace_purchases (id, listing_id, buyer_address, job_id, contract_address, tx_hash, price_guard, category)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, listingId, buyerAddress, jobId, contractAddress, txHash, priceGuard, category);
}

function getMarketplacePurchases({ buyerAddress, limit = 50 } = {}) {
  if (buyerAddress) {
    return getDb().prepare('SELECT * FROM marketplace_purchases WHERE LOWER(buyer_address) = LOWER(?) ORDER BY purchased_at DESC LIMIT ?').all(buyerAddress, limit);
  }
  return getDb().prepare('SELECT * FROM marketplace_purchases ORDER BY purchased_at DESC LIMIT ?').all(limit);
}

function getMarketplacePurchase(listingId) {
  return getDb().prepare('SELECT * FROM marketplace_purchases WHERE listing_id = ?').get(listingId);
}

// ── HCS cursors ──────────────────────────────────────────────

function getHcsCursor(topicKey) {
  return getDb().prepare('SELECT last_seq FROM hcs_cursors WHERE topic_key = ?').get(topicKey);
}

function setHcsCursor(topicKey, lastSeq) {
  return getDb()
    .prepare(`INSERT OR REPLACE INTO hcs_cursors (topic_key, last_seq, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(topicKey, lastSeq);
}

// ── Auth nonces ──────────────────────────────────────────────

function insertNonce(walletAddress, nonce, expiresAt) {
  return getDb()
    .prepare('INSERT INTO auth_nonces (wallet_address, nonce, expires_at) VALUES (?, ?, ?)')
    .run(walletAddress, nonce, expiresAt);
}

function getNonce(walletAddress, nonce) {
  return getDb()
    .prepare('SELECT * FROM auth_nonces WHERE wallet_address = ? AND nonce = ? AND used = 0 AND expires_at > ?')
    .get(walletAddress, nonce, Date.now());
}

function markNonceUsed(walletAddress, nonce) {
  return getDb()
    .prepare('UPDATE auth_nonces SET used = 1 WHERE wallet_address = ? AND nonce = ?')
    .run(walletAddress, nonce);
}

module.exports = {
  getDb,
  insertAuditEvent,
  getAuditEvents,
  getLastAuditEventId,
  upsertJobClient,
  getJobClient,
  upsertAuditReport,
  getAuditReport,
  listAuditReports,
  insertMarketplacePurchase,
  getMarketplacePurchases,
  getMarketplacePurchase,
  getHcsCursor,
  setHcsCursor,
  insertNonce,
  getNonce,
  markNonceUsed,
};
