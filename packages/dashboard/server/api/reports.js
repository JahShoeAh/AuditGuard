import express from 'express';
import { getReportsByDeployer, getReportById, saveReport } from '../../../sdk/db/report-db.js';
import { normalizeDeployer, reportId } from '../../../sdk/db/report-types.js';

const router    = express.Router();
const JOB_ID_RE = /^[a-zA-Z0-9-]+$/;

// GET /api/reports?deployer={addr}
router.get('/', async (req, res) => {
  const { deployer } = req.query;
  if (!deployer) {
    return res.status(400).json({ success: false, error: 'Missing required parameter: deployer' });
  }
  try {
    const data = await getReportsByDeployer(normalizeDeployer(deployer));
    res.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error('[API] GET /reports:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/reports/:jobId  (includes mdContent fetched from S3)
router.get('/:jobId', async (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) {
    return res.status(400).json({ success: false, error: 'Invalid job ID format' });
  }
  try {
    const data = await getReportById(req.params.jobId);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /reports/:jobId:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/reports  (called from orchestrator report-writer)
router.post('/', async (req, res) => {
  const required = ['jobId', 'contractAddress', 'deployerAddress', 'contentHash'];
  const missing  = required.filter(f => !req.body[f]);
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(', ')}` });
  }
  try {
    const id = await saveReport({
      ...req.body,
      id: reportId(req.body.jobId),
      deployerAddress: normalizeDeployer(req.body.deployerAddress),
      contractAddress: normalizeDeployer(req.body.contractAddress),
      timestamp: req.body.timestamp ?? Date.now(),
      source: req.body.source ?? 'orchestrator',
    });
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[API] POST /reports:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
