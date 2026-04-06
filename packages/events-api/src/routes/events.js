'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /events — paginated audit events with optional ?type= and ?since= cursor
router.get('/', (req, res) => {
  const type = req.query.type || null;
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const events = db.getAuditEvents({ type, since, limit, offset });
  const parsed = events.map((e) => {
    let payload = null;
    try { payload = JSON.parse(e.payload_json || 'null'); } catch {}
    return {
      id: e.id,
      source: e.source,
      topicId: e.topic_id,
      messageType: e.message_type,
      agentId: e.agent_id,
      messageTimestamp: e.message_timestamp,
      payload,
      receivedAt: e.received_at,
    };
  });

  const lastId = events.length > 0 ? events[0].id : since;
  res.json({ events: parsed, cursor: lastId });
});

module.exports = router;
