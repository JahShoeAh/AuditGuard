/**
 * Agent health check infrastructure.
 * Validates HCS, contract connectivity, and wallet balance.
 */

import express from 'express';
import type { HCSClient } from './hcs-client.js';
import type { ContractClient } from './contract-client.js';

export interface AgentHealthConfig {
  agentId: string;
  port: number;
  hcs?: HCSClient;
  contracts?: ContractClient;
  getPendingJobsCount?: () => number;
}

export async function checkAgentHealth(config: AgentHealthConfig) {
  const checks = {
    hcs: false,
    contracts: false,
    wallet: false,
  };

  const details: Record<string, string> = {};

  // Check HCS connectivity
  if (config.hcs) {
    try {
      const connected = config.hcs.isConnected?.() ?? true;
      checks.hcs = connected;
      details.hcs = connected ? 'Connected' : 'Disconnected';
    } catch (err) {
      details.hcs = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    checks.hcs = true; // No HCS client = not required
    details.hcs = 'N/A';
  }

  // Check contract connectivity
  if (config.contracts) {
    try {
      const blockNumber = await config.contracts.provider.getBlockNumber();
      checks.contracts = true;
      details.contracts = `Block ${blockNumber}`;
    } catch (err) {
      details.contracts = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Check wallet balance
    try {
      const balance = await config.contracts.getHbarBalance();
      checks.wallet = balance > 0n;
      details.wallet = `${balance} tinybar`;
    } catch (err) {
      details.wallet = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    checks.contracts = true;
    checks.wallet = true;
    details.contracts = 'N/A';
    details.wallet = 'N/A';
  }

  const healthy = Object.values(checks).every(Boolean);

  return {
    status: healthy ? 'healthy' : 'unhealthy',
    agent_id: config.agentId,
    checks,
    details,
    pending_jobs: config.getPendingJobsCount?.() ?? 0,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
}

export function startHealthServer(config: AgentHealthConfig) {
  const app = express();

  app.get('/health', async (req, res) => {
    try {
      const health = await checkAgentHealth(config);
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        agent_id: config.agentId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'alive', agent_id: config.agentId, uptime: process.uptime() });
  });

  app.get('/ready', async (req, res) => {
    try {
      const health = await checkAgentHealth(config);
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json({ ready: health.status === 'healthy' });
    } catch (err) {
      res.status(503).json({ ready: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(config.port, () => {
    console.log(`[${config.agentId}] Health checks available at http://localhost:${config.port}/health`);
  });

  return app;
}
