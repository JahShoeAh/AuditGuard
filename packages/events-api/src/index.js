'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const db = require('./db');
const auth = require('./auth');
const hcsListener = require('./hcs-listener');
const reportsRouter = require('./routes/reports');
const marketplaceRouter = require('./routes/marketplace');
const eventsRouter = require('./routes/events');

const PORT = Number(process.env.PORT) || 3001;
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';

const app = express();

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map((s) => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Auth routes ───────────────────────────────────────────────
app.post('/auth/challenge', auth.challenge);
app.post('/auth/verify', auth.verify);

// ── Data routes ───────────────────────────────────────────────
app.use('/reports', reportsRouter);
app.use('/marketplace', marketplaceRouter);
app.use('/events', eventsRouter);

// ── Internal report store (also mounted at root level) ────────
app.post('/internal/reports', reportsRouter);

// ── HTTP + WebSocket server ───────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/events/stream' });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  ws.on('close', () => console.log('[ws] client disconnected'));
  // Send last event id on connect
  ws.send(JSON.stringify({ type: 'connected', lastEventId: db.getLastAuditEventId() }));
});

// ── Start ─────────────────────────────────────────────────────
function start() {
  // Ensure DB is initialized
  db.getDb();

  // Start HCS listener
  const hcsTopics = {
    discovery: process.env.HCS_TOPIC_DISCOVERY || process.env.HEDERA_TOPIC_DISCOVERY,
    auditLog: process.env.HCS_TOPIC_AUDIT_LOG || process.env.HEDERA_TOPIC_AUDIT_LOG,
    agentComms: process.env.HCS_TOPIC_AGENT_COMMS || process.env.HEDERA_TOPIC_AGENT_COMMS,
  };

  // Try to load topics from SDK config if not in env
  if (!hcsTopics.discovery) {
    try {
      const sdkConfig = require('../../sdk/config.json');
      hcsTopics.discovery = sdkConfig.hcsTopics?.discovery;
      hcsTopics.auditLog = sdkConfig.hcsTopics?.auditLog;
      hcsTopics.agentComms = sdkConfig.hcsTopics?.agentComms;
    } catch {
      console.warn('[events-api] Could not load SDK config for HCS topics');
    }
  }

  hcsListener.start(hcsTopics, wss);

  server.listen(PORT, () => {
    console.log(`[events-api] Listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, server, wss };
