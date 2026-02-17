/**
 * Demo runner — launches all agents with compressed timers for presentation.
 *
 * Usage: npm run demo
 *
 * Sets DEMO_MODE=true so all agents use compressed timers:
 *   - Scanner: 30s interval (instead of 5 min)
 *   - Audit times: 3-30s (instead of 10-180s)
 *   - Aggregation window: 30s (instead of 2 min)
 *   - Hot lead delay: 10s (instead of 60s)
 */

// Set demo mode env vars before importing agents
process.env.DEMO_MODE = "true";

import { spawn, ChildProcess } from "child_process";
import { createAgentLogger } from "./shared/index.js";

const log = createAgentLogger("demo-runner", "scanner");

const DEMO_DURATION_MS = 10 * 60 * 1000; // 10 minutes max

const agents = [
  { name: "scanner", script: "scanner/index.ts", delay: 0 },
  { name: "static", script: "static-analysis/index.ts", delay: 2000 },
  { name: "fuzzer", script: "fuzzer/index.ts", delay: 2000 },
  { name: "llm", script: "llm-contextual/index.ts", delay: 3000 },
  { name: "dependency", script: "dependency/index.ts", delay: 3000 },
  { name: "report", script: "report/index.ts", delay: 1000 },
  { name: "alert", script: "alert/index.ts", delay: 1000 },
];

async function main() {
  log.info("╔══════════════════════════════════════╗");
  log.info("║      AuditGuard Demo Runner          ║");
  log.info("║      DEMO MODE — compressed timers   ║");
  log.info("╚══════════════════════════════════════╝");
  log.info(`Launching ${agents.length} agents...`);
  log.info(`Demo duration: ${DEMO_DURATION_MS / 1000}s\n`);

  const processes: ChildProcess[] = [];
  let cycle = 0;

  for (const agent of agents) {
    if (agent.delay > 0) {
      await new Promise((r) => setTimeout(r, agent.delay));
    }

    log.info(`▶ Starting ${agent.name}...`);

    const proc = spawn("npx", ["tsx", agent.script], {
      stdio: "inherit",
      cwd: import.meta.dirname || process.cwd(),
      env: {
        ...process.env,
        DEMO_MODE: "true",
      },
    });

    proc.on("error", (err) => {
      log.error(`${agent.name} failed to start: ${err}`);
    });

    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log.warn(`${agent.name} exited with code ${code}`);
      }
    });

    processes.push(proc);
  }

  log.info(`\n✓ All ${agents.length} agents launched.\n`);

  // Auto-shutdown after demo duration
  const demoTimer = setTimeout(() => {
    log.info("\n⏰ Demo duration reached. Shutting down...");
    shutdown(processes);
  }, DEMO_DURATION_MS);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", () => {
    clearTimeout(demoTimer);
    log.info("\n⏹ Manual shutdown requested...");
    shutdown(processes);
  });
}

function shutdown(processes: ChildProcess[]) {
  for (const proc of processes) {
    proc.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000);
}

main().catch(console.error);
