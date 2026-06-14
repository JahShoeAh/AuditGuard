import { OrchestratorAgent } from "./orchestrator.js";
import { createLogger } from "./logger.js";
import { OrchestratorStateStore } from "./state-store.js";
import express from 'express';
import { getMetrics } from './metrics.js';
import { checkHealth } from './health.js';

const log = createLogger("bootstrap");
let orchestrator;
let stateStore;
let stateSaveInterval;
let metricsServer;
let healthServer;

async function start() {
  stateStore = new OrchestratorStateStore();
  orchestrator = new OrchestratorAgent({ stateStore });

  // Load persisted state before starting
  await orchestrator.loadPersistedState();

  orchestrator.start();

  // Periodic state persistence every 60 seconds
  stateSaveInterval = setInterval(async () => {
    try {
      await orchestrator.savePersistedState();
    } catch (err) {
      log.error(`Periodic state save failed: ${err.message}`);
    }
  }, 60000);

  // Start Prometheus metrics server
  const METRICS_PORT = parseInt(process.env.ORCHESTRATOR_METRICS_PORT || '9090', 10);
  const metricsApp = express();
  metricsApp.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.end(await getMetrics());
    } catch (err) {
      log.error(`Metrics endpoint error: ${err.message}`);
      res.status(500).send('Internal Server Error');
    }
  });

  metricsServer = metricsApp.listen(METRICS_PORT, () => {
    log.info(`[metrics] Prometheus metrics available at http://localhost:${METRICS_PORT}/metrics`);
  });

  // Start health check server
  const HEALTH_PORT = parseInt(process.env.ORCHESTRATOR_HEALTH_PORT || '8080', 10);
  const healthApp = express();

  // Comprehensive health check endpoint
  healthApp.get('/health', async (req, res) => {
    try {
      const health = await checkHealth(orchestrator);
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Liveness probe (always returns 200 if process is running)
  healthApp.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'alive', uptime: process.uptime() });
  });

  // Readiness probe (returns 200 only if all checks pass)
  healthApp.get('/ready', async (req, res) => {
    try {
      const health = await checkHealth(orchestrator);
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json({ ready: health.status === 'healthy' });
    } catch (err) {
      res.status(503).json({ ready: false, error: err.message });
    }
  });

  healthServer = healthApp.listen(HEALTH_PORT, () => {
    log.info(`[health] Health checks available at http://localhost:${HEALTH_PORT}/health`);
  });

  log.info("Orchestrator bootstrap complete with persistent state enabled");
}

async function shutdown() {
  log.info("Shutting down gracefully — saving state...");

  if (stateSaveInterval) {
    clearInterval(stateSaveInterval);
    stateSaveInterval = null;
  }

  if (metricsServer) {
    try {
      await new Promise((resolve, reject) => {
        metricsServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log.info("Metrics server closed");
    } catch (err) {
      log.error(`Failed to close metrics server: ${err.message}`);
    }
  }

  if (healthServer) {
    try {
      await new Promise((resolve, reject) => {
        healthServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log.info("Health server closed");
    } catch (err) {
      log.error(`Failed to close health server: ${err.message}`);
    }
  }

  try {
    if (orchestrator) {
      await orchestrator.savePersistedState();
    }
  } catch (err) {
    log.error(`Failed to save state during shutdown: ${err.message}`);
  }

  try {
    if (stateStore) {
      await stateStore.close();
    }
  } catch (err) {
    log.error(`Failed to close state store: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => {
  log.info("SIGTERM received");
  shutdown();
});

process.on("SIGINT", () => {
  log.info("SIGINT received");
  shutdown();
});

process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  log.error("Fatal runtime error — exiting to avoid duplicate in-process listeners");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});

try {
  start();
} catch (err) {
  log.error(`Failed to start orchestrator: ${err.message}`);
  process.exit(1);
}
