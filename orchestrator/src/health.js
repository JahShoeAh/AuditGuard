/**
 * Health check for orchestrator.
 * Validates database, Hedera RPC, HCS topics, contracts, and roster.
 */

export async function checkHealth(orchestrator) {
  const checks = {
    database: false,
    hedera_rpc: false,
    hcs_topics: false,
    contracts: false,
    roster: false,
  };

  const details = {};

  // Check PostgreSQL (state store)
  try {
    if (orchestrator.stateStore && typeof orchestrator.stateStore.healthCheck === 'function') {
      await orchestrator.stateStore.healthCheck();
      checks.database = true;
      details.database = 'Connected';
    } else {
      // No database configured or available
      checks.database = true;
      details.database = 'N/A (in-memory)';
    }
  } catch (err) {
    details.database = `Error: ${err.message}`;
  }

  // Check Hedera RPC
  try {
    const provider = orchestrator.contracts?.provider;
    if (provider) {
      const blockNumber = await provider.getBlockNumber();
      checks.hedera_rpc = true;
      details.hedera_rpc = `Block ${blockNumber}`;
    } else {
      details.hedera_rpc = 'Provider not initialized';
    }
  } catch (err) {
    details.hedera_rpc = `Error: ${err.message}`;
  }

  // Check HCS connectivity (verify subscription is active)
  try {
    const isConnected = orchestrator.hcs?.isConnected?.() ?? true;
    checks.hcs_topics = isConnected;
    details.hcs_topics = isConnected ? 'Connected' : 'Disconnected';
  } catch (err) {
    details.hcs_topics = `Error: ${err.message}`;
  }

  // Check contract calls
  try {
    if (orchestrator.contracts && typeof orchestrator.contracts.getJobCount === 'function') {
      const jobCount = await orchestrator.contracts.getJobCount();
      checks.contracts = true;
      details.contracts = `${jobCount} jobs`;
    } else {
      // Try alternative method to verify contract connectivity
      await orchestrator.contracts.auction.jobCount();
      checks.contracts = true;
      details.contracts = 'Connected';
    }
  } catch (err) {
    details.contracts = `Error: ${err.message}`;
  }

  // Check roster state
  try {
    if (orchestrator.roster) {
      const totalCount = orchestrator.roster.agents?.size ?? 0;
      // Count active agents (heartbeat within last 30s)
      const cutoff = Date.now() - 30000;
      let activeCount = 0;
      if (orchestrator.roster.agents) {
        for (const agent of orchestrator.roster.agents.values()) {
          if ((agent.lastSeen ?? 0) >= cutoff) {
            activeCount++;
          }
        }
      }
      checks.roster = true;
      details.roster = `${activeCount}/${totalCount} agents active`;
    } else {
      details.roster = 'Roster not initialized';
    }
  } catch (err) {
    details.roster = `Error: ${err.message}`;
  }

  const healthy = Object.values(checks).every(Boolean);

  return {
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
    details,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}
