import { Router } from 'express';
import { getReportsByDeployer, getReportById, saveReport }
  from '../../../../packages/sdk/db/report-db.js';
import { normalizeDeployer, reportId }
  from '../../../../packages/sdk/db/report-types.js';

const router    = Router();
const JOB_ID_RE = /^[a-zA-Z0-9-]+$/;

// GET /api/reports?deployer={addr}
// Returns all reports for a deployer. Does NOT include mdContent.
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

// GET /api/reports/:jobId
// Returns the report including mdContent (stored inline in DB).
router.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_RE.test(jobId)) {
    return res.status(400).json({ success: false, error: 'Invalid job ID format' });
  }
  try {
    const data = await getReportById(jobId);
    if (!data) return res.status(404).json({ success: false, error: 'Report not found' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /reports/:jobId:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/reports
// Creates a new report record. Body: Partial<StoredAuditReport> + optional mdContent.
router.post('/', async (req, res) => {
  const required = ['jobId', 'contractAddress', 'deployerAddress', 'contentHash'];
  const missing  = required.filter((f) => !req.body[f]);
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(', ')}` });
  }
  try {
    const id = await saveReport({
      ...req.body,
      id:              reportId(req.body.jobId),
      deployerAddress: normalizeDeployer(req.body.deployerAddress),
      contractAddress: normalizeDeployer(req.body.contractAddress),
      mdContent:       req.body.mdContent  ?? '',
      timestamp:       req.body.timestamp  ?? Date.now(),
      source:          req.body.source     ?? 'agent',
    });
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[API] POST /reports:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save report' });
  }
});

export default router;
