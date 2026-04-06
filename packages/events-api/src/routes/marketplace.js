'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /marketplace/listings — active listings from audit_events
router.get('/listings', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const events = db.getAuditEvents({ type: 'DATA_LISTING_CREATED', limit });
  const listings = events.map((e) => {
    let payload = {};
    try { payload = JSON.parse(e.payload_json || '{}'); } catch {}
    return {
      listingId: payload.listingId,
      jobId: payload.jobId,
      seller: payload.seller,
      title: payload.title,
      category: payload.category,
      price: payload.price,
      contentHash: payload.contentHash,
      receivedAt: e.received_at,
    };
  });
  res.json({ listings });
});

// GET /marketplace/purchases — purchase history (auth required, filtered to wallet)
router.get('/purchases', requireAuth, (req, res) => {
  const purchases = db.getMarketplacePurchases({ buyerAddress: req.walletAddress });
  res.json({ purchases });
});

// GET /marketplace/purchases/:listingId — purchase status
router.get('/purchases/:listingId', (req, res) => {
  const purchase = db.getMarketplacePurchase(req.params.listingId);
  if (!purchase) {
    return res.status(404).json({ error: 'Purchase not found' });
  }
  res.json({ purchase });
});

module.exports = router;
