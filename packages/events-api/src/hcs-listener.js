'use strict';

const { Client, TopicMessageQuery, AccountId, PrivateKey } = require('@hashgraph/sdk');
const db = require('./db');

const MIRROR_GRPC = process.env.HEDERA_MIRROR_GRPC || 'hcs.testnet.mirrornode.hedera.com:5600';
const OPERATOR_ID = process.env.HEDERA_OPERATOR_ID;
const OPERATOR_KEY = process.env.HEDERA_OPERATOR_KEY;

let _wss = null;
let _client = null;

function buildClient() {
  if (_client) return _client;
  if (!OPERATOR_ID || !OPERATOR_KEY) {
    console.warn('[hcs-listener] HEDERA_OPERATOR_ID/KEY not set — HCS listener disabled');
    return null;
  }
  _client = Client.forTestnet();
  _client.setOperator(AccountId.fromString(OPERATOR_ID), PrivateKey.fromStringDer(OPERATOR_KEY));
  return _client;
}

function broadcastToClients(data) {
  if (!_wss) return;
  const payload = JSON.stringify(data);
  _wss.clients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  });
}

function parseMsgContent(contentBytes) {
  try {
    return JSON.parse(Buffer.from(contentBytes).toString('utf8'));
  } catch {
    return null;
  }
}

function subscribeToTopic(topicId, topicKey, client) {
  if (!topicId || !client) return;

  const cursor = db.getHcsCursor(topicKey);
  const startSeq = cursor?.last_seq ?? 0;

  console.log(`[hcs-listener] Subscribing to ${topicKey} (${topicId}) from seq ${startSeq}`);

  new TopicMessageQuery()
    .setTopicId(topicId)
    .setStartTime(0)
    .subscribe(client, (err, msg) => {
      if (err) {
        console.warn(`[hcs-listener] ${topicKey} subscription error:`, err.message || err);
        return;
      }
      if (!msg) return;

      const seqNum = Number(msg.sequenceNumber || 0);
      if (seqNum <= startSeq) return;

      const parsed = parseMsgContent(msg.contents);
      if (!parsed) return;

      const messageType = parsed.type || 'UNKNOWN';
      const agentId = parsed.agentId || null;
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const msgTs = msg.consensusTimestamp?.toString() || null;

      // Persist to audit_events
      const result = db.insertAuditEvent({
        source: topicKey,
        topicId,
        messageType,
        agentId,
        messageTimestamp: msgTs,
        payloadJson: JSON.stringify(payload),
        rawJson: JSON.stringify(parsed),
      });

      const eventId = result.lastInsertRowid;

      // Handle specific message types
      if (messageType === 'JOB_CREATED' && payload.jobId) {
        db.upsertJobClient({
          jobId: String(payload.jobId),
          contractAddress: payload.contractAddress || null,
          deployerAddress: (payload.deployerAddress || payload.deployer || '').toLowerCase() || null,
        });
      }

      if ((messageType === 'REPORT_PUBLISHED' || messageType === 'PAYMENT_SETTLED') && payload.jobId) {
        const client = db.getJobClient(String(payload.jobId));
        if (client) {
          db.upsertAuditReport({
            jobId: String(payload.jobId),
            contractAddress: client.contract_address,
            deployerAddress: client.deployer_address,
            reportHash: payload.reportHash || null,
            findingsJson: payload.findings ? JSON.stringify(payload.findings) : null,
            totalFindings: Number(payload.totalFindings) || 0,
            criticalCount: Number(payload.criticalFindings || payload.criticalCount) || 0,
            settledAt: messageType === 'PAYMENT_SETTLED' ? new Date().toISOString() : null,
            rawJson: JSON.stringify(parsed),
          });
        }
      }

      if (messageType === 'DATA_PURCHASED' && payload.listingId) {
        const purchaseId = `${topicId}:${seqNum}`;
        db.insertMarketplacePurchase({
          id: purchaseId,
          listingId: String(payload.listingId),
          buyerAddress: (payload.buyer || '').toLowerCase(),
          jobId: payload.jobId ? String(payload.jobId) : null,
          contractAddress: payload.contractAddress || null,
          txHash: payload.txHash || null,
          priceGuard: Number(payload.price) || 0,
          category: payload.category || null,
        });
      }

      // Update cursor
      db.setHcsCursor(topicKey, seqNum);

      // Broadcast to WebSocket clients
      broadcastToClients({
        eventId,
        topicKey,
        topicId,
        messageType,
        agentId,
        payload,
        sequenceNumber: seqNum,
        timestamp: msgTs,
      });
    });
}

function start(topics, wss) {
  _wss = wss;
  const client = buildClient();
  if (!client) return;

  subscribeToTopic(topics.discovery, 'discovery', client);
  subscribeToTopic(topics.auditLog, 'auditLog', client);
  subscribeToTopic(topics.agentComms, 'agentComms', client);

  console.log('[hcs-listener] Subscriptions started');
}

module.exports = { start };
