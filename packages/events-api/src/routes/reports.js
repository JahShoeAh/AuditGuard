import { Router } from "express";
import {
  saveReport,
  getReportsByDeployer,
  getReportById,
} from "../../../sdk/db/report-db.js";

export const reportsRouter = Router();

// POST /api/reports — called by report agent to persist a completed report
reportsRouter.post("/reports", async (req, res) => {
  const body = req.body;
  if (!body?.jobId) {
    return res.status(400).json({ success: false, error: "jobId is required" });
  }

  try {
    const id = await saveReport({
      jobId:              String(body.jobId),
      contractAddress:    body.contractAddress   ?? "",
      deployerAddress:    body.deployerAddress   ?? "",
      hederaAccountId:    body.hederaAccountId   ?? null,
      chain:              body.chain             ?? "hedera-testnet",
      contractType:       body.contractType      ?? "unknown",
      contentHash:        body.contentHash       ?? "",
      mdContent:          body.mdContent         ?? "",
      agentAddresses:     body.agentAddresses    ?? [],
      agentCount:         body.agentCount        ?? 0,
      findingCount:       body.findingCount      ?? 0,
      findingsBySeverity: body.findingsBySeverity ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      timestamp:          body.timestamp         ?? Date.now(),
      tags:               body.tags              ?? [],
      source:             body.source            ?? "agent",
    });
    return res.status(201).json({ success: true, id });
  } catch (err) {
    console.error("[reports] POST /api/reports error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports?deployer={addr} — list all reports for a deployer
reportsRouter.get("/reports", async (req, res) => {
  const deployer = req.query.deployer;
  if (!deployer) {
    return res.status(400).json({ success: false, error: "deployer query param is required" });
  }

  try {
    const data = await getReportsByDeployer(String(deployer));
    return res.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error("[reports] GET /api/reports error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/:jobId — single report with mdContent
reportsRouter.get("/reports/:jobId", async (req, res) => {
  try {
    const report = await getReportById(String(req.params.jobId));
    if (!report) {
      return res.status(404).json({ success: false, error: "Report not found" });
    }
    return res.json({ success: true, data: report });
  } catch (err) {
    console.error("[reports] GET /api/reports/:jobId error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
