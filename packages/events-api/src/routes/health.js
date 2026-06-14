import { Router } from "express";
import { getDb } from "../db.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const checks = {
    database: false,
    orchestrator: false,
  };

  const details = {};

  // Check database
  try {
    const db = getDb();
    await db.healthCheck();
    checks.database = true;
    details.database = 'Connected';
  } catch (err) {
    details.database = `Error: ${err.message}`;
  }

  // Ping orchestrator (optional check)
  try {
    const orchestratorUrl = process.env.ORCHESTRATOR_HEALTH_URL || 'http://localhost:8080/healthz';
    const response = await fetch(orchestratorUrl, { signal: AbortSignal.timeout(2000) });
    checks.orchestrator = response.ok;
    details.orchestrator = response.ok ? 'Reachable' : `Status ${response.status}`;
  } catch (err) {
    checks.orchestrator = false;
    details.orchestrator = 'Unreachable (optional)';
  }

  const healthy = checks.database; // Orchestrator is optional
  const statusCode = healthy ? 200 : 503;

  return res.status(statusCode).json({
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
    details,
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/healthz", (_req, res) => {
  return res.status(200).json({ status: 'alive', uptime: process.uptime() });
});

healthRouter.get("/ready", async (_req, res) => {
  try {
    const db = getDb();
    await db.healthCheck();
    return res.status(200).json({ ready: true });
  } catch {
    return res.status(503).json({ ready: false });
  }
});
