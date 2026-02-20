import { loadConfig } from "./config.js";
import { UcpAgent } from "./agent.js";
import { createUcpServer } from "./server.js";

let httpServer = null;
let agent = null;
let shuttingDown = false;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(
      `[startup] Configuration error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  agent = new UcpAgent(config);

  try {
    await agent.init();
  } catch (error) {
    console.error(
      `[startup] Agent initialization failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  const app = createUcpServer(agent);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(config.port, resolve);
    httpServer.on("error", reject);
  });

  agent.log(`HTTP server listening on port ${config.port}`);
  agent.log(`Route ready: POST /health`);
  agent.log(`Route ready: POST /task`);
  agent.log(`Route ready: GET /status`);

  if (config.ucpEndpoint) {
    agent.log(`Public endpoint: ${config.ucpEndpoint}`);
  } else {
    agent.log(
      "WARNING: UCP_AGENT_ENDPOINT is not set. Dashboard health checks and orchestrator HTTP delivery will fail until a public URL is configured. Example: `ngrok http 3737` then set UCP_AGENT_ENDPOINT to the HTTPS forwarding URL."
    );
  }

  if (!config.skipOnChainRegister) {
    try {
      await agent.registerOnChain();
    } catch (error) {
      agent.log(
        `Non-fatal registerAgent warning: ${error instanceof Error ? error.message : String(error)}`
      );
      agent.log("Hint: set UCP_SKIP_ONCHAIN_REGISTER=true if this wallet is already registered.");
    }
  }

  try {
    await agent.announceOnHcs();
  } catch (error) {
    agent.log(
      `Non-fatal AGENT_REGISTERED publish warning: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  agent.subscribeToHcs();

  agent.log(
    `Ready: agentId=${config.agentId}, wallet=${agent.evmAddress}, specializations=${config.specializations.join(
      ","
    )}, stake=${config.stakeGuard} GUARD`
  );
  agent.log("Waiting for auction invites... (Ctrl+C to stop)");
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log("[shutdown] SIGINT received, stopping UCP agent...");

  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  if (agent) {
    await agent.shutdown();
  }

  console.log("[shutdown] Complete.");
}

process.on("SIGINT", async () => {
  try {
    await shutdown();
    process.exit(0);
  } catch (error) {
    console.error(
      `[shutdown] Error: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`
    );
    process.exit(1);
  }
});

main().catch((error) => {
  console.error(
    `[fatal] ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`
  );
  process.exit(1);
});
