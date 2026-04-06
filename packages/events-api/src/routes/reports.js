'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// GET /reports — public metadata list
router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const reports = db.listAuditReports({ limit, offset });
  res.json({ reports });
});

// GET /reports/:jobId — full report, deployer-gated
router.get('/:jobId', requireAuth, (req, res) => {
  const { jobId } = req.params;
  const report = db.getAuditReport(jobId);
  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const client = db.getJobClient(jobId);
  if (!client) {
    return res.status(403).json({ error: 'No deployer record for this job' });
  }

  if (client.deployer_address.toLowerCase() !== req.walletAddress.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: only the contract deployer can access this report' });
  }

  let findings = null;
  try {
    findings = report.findings_json ? JSON.parse(report.findings_json) : null;
  } catch {
    findings = null;
  }

  res.json({
    jobId: report.job_id,
    contractAddress: report.contract_address,
    deployerAddress: report.deployer_address,
    reportHash: report.report_hash,
    findings,
    totalFindings: report.total_findings,
    criticalCount: report.critical_count,
    settledAt: report.settled_at,
    createdAt: report.created_at,
  });
});

// POST /internal/reports — called by orchestrator (protected by X-Internal-Key header)
router.post('/internal/reports', (req, res) => {
  const key = req.headers['x-internal-key'] || '';
  if (INTERNAL_API_KEY && key !== INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { jobId, contractAddress, deployerAddress, reportHash, findings, totalFindings, criticalCount, settledAt } = req.body || {};
  if (!jobId) {
    return res.status(400).json({ error: 'jobId required' });
  }

  db.upsertAuditReport({
    jobId,
    contractAddress: contractAddress || null,
    deployerAddress: deployerAddress?.toLowerCase() || null,
    reportHash: reportHash || null,
    findingsJson: findings ? JSON.stringify(findings) : null,
    totalFindings: Number(totalFindings) || 0,
    criticalCount: Number(criticalCount) || 0,
    settledAt: settledAt || new Date().toISOString(),
    rawJson: JSON.stringify(req.body),
  });

  res.json({ ok: true });
});

module.exports = router;
