'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * POST /auth/challenge?wallet=0x...
 * Returns { nonce, expiresAt } for the wallet to sign.
 */
async function challenge(req, res) {
  const wallet = (req.query.wallet || '').toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const nonce = `AuditGuard-auth:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = Date.now() + NONCE_TTL_MS;
  db.insertNonce(wallet, nonce, expiresAt);

  return res.json({ nonce, expiresAt });
}

/**
 * POST /auth/verify
 * Body: { wallet, nonce, signature }
 * Returns { token }
 */
async function verify(req, res) {
  const { wallet, nonce, signature } = req.body || {};
  if (!wallet || !nonce || !signature) {
    return res.status(400).json({ error: 'wallet, nonce, and signature are required' });
  }

  const normalizedWallet = wallet.toLowerCase();
  const row = db.getNonce(normalizedWallet, nonce);
  if (!row) {
    return res.status(401).json({ error: 'Nonce not found, expired, or already used' });
  }

  try {
    const recovered = ethers.verifyMessage(nonce, signature).toLowerCase();
    if (recovered !== normalizedWallet) {
      return res.status(401).json({ error: 'Signature does not match wallet' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  db.markNonceUsed(normalizedWallet, nonce);

  const token = jwt.sign({ walletAddress: normalizedWallet }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return res.json({ token });
}

/**
 * Middleware: verifies JWT and sets req.walletAddress
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.walletAddress = payload.walletAddress;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { challenge, verify, requireAuth };
