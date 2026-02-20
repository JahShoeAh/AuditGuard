import { OrchestratorAgent } from "./orchestrator.js";
import { createLogger } from "./logger.js";

const log = createLogger("bootstrap");
let orchestrator;

function start() {
  orchestrator = new OrchestratorAgent();
  orchestrator.start();
}

process.on("SIGTERM", () => {
  log.info("SIGTERM received — shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("SIGINT received — shutting down gracefully");
  process.exit(0);
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
