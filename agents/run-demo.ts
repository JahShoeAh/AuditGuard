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
 *
 * Features:
 *   - Lifecycle stage labels: DISCOVERY → BIDDING → AUDIT → REPORT → SETTLEMENT
 *   - Cycle counter with per-agent status grid (every 60s)
 *   - Final summary on shutdown (total cycles, duration)
 */

// Set demo mode env vars before importing agents
process.env.DEMO_MODE = "true";

import { spawn, ChildProcess } from "child_process";
import { createAgentLogger } from "./shared/index.js";

const log = createAgentLogger("demo-runner", "scanner");

const DEMO_DURATION_MS = 10 * 60 * 1000; // 10 minutes max
const CYCLE_SUMMARY_INTERVAL_MS = 60_000; // print cycle summary every 60s
const LIFECYCLE_STAGE_MS = 12_000; // rotate through stages every 12s

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

type AgentStatus = "starting" | "running" | "completed" | "error";

const LIFECYCLE_STAGES = [
  { label: "DISCOVERY", color: CYAN },
  { label: "BIDDING", color: YELLOW },
  { label: "AUDIT", color: MAGENTA },
  { label: "REPORT", color: GREEN },
  { label: "SETTLEMENT", color: "\x1b[34m" },
];

const agents = [
  { name: "scanner", script: "scanner/index.ts", delay: 0, color: CYAN },
  { name: "static", script: "static-analysis/index.ts", delay: 2000, color: GREEN },
  { name: "fuzzer", script: "fuzzer/index.ts", delay: 2000, color: YELLOW },
  { name: "llm", script: "llm-contextual/index.ts", delay: 3000, color: MAGENTA },
  { name: "dependency", script: "dependency/index.ts", delay: 3000, color: "\x1b[34m" },
  { name: "report", script: "report/index.ts", delay: 1000, color: "\x1b[37m" },
  { name: "alert", script: "alert/index.ts", delay: 1000, color: RED },
];

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function printLifecycleStage(stageIndex: number): void {
  const stage = LIFECYCLE_STAGES[stageIndex % LIFECYCLE_STAGES.length];
  const arrow = LIFECYCLE_STAGES.map((s, i) => {
    const isCurrent = i === stageIndex % LIFECYCLE_STAGES.length;
    const prefix = isCurrent ? `${BOLD}${s.color}` : DIM;
    return `${prefix}${s.label}${RESET}`;
  }).join(`  ${DIM}→${RESET}  `);
  console.log(`\n  ${DIM}${timestamp()}${RESET} ${arrow}\n`);
}

function printCycleSummary(
  cycle: number,
  startedAt: number,
  statusMap: Map<string, AgentStatus>,
): void {
  const elapsed = Date.now() - startedAt;
  const remaining = DEMO_DURATION_MS - elapsed;
  console.log(`\n${BOLD}╔══════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Demo Cycle #${String(cycle).padEnd(4)} │ Elapsed: ${formatDuration(elapsed).padEnd(10)}║${RESET}`);
  console.log(`${BOLD}║  Remaining: ${formatDuration(Math.max(0, remaining)).padEnd(10)}                          ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════╣${RESET}`);

  for (const agent of agents) {
    const status = statusMap.get(agent.name) ?? "starting";
    const icon =
      status === "running" ? `${GREEN}●${RESET}` :
      status === "starting" ? `${YELLOW}◐${RESET}` :
      status === "completed" ? `${DIM}✓${RESET}` :
      `${RED}✗${RESET}`;
    const label = `${agent.color}${agent.name.padEnd(12)}${RESET}`;
    const statusText = status.padEnd(10);
    console.log(`${BOLD}║${RESET}  ${icon} ${label} ${DIM}${statusText}${RESET}               ${BOLD}║${RESET}`);
  }
  console.log(`${BOLD}╚══════════════════════════════════════════════╝${RESET}\n`);
}

function printFinalSummary(totalCycles: number, startedAt: number): void {
  const duration = Date.now() - startedAt;
  console.log(`\n${BOLD}╔══════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║         AuditGuard Demo — Final Summary      ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Total cycles completed: ${GREEN}${String(totalCycles).padEnd(20)}${RESET}${BOLD}║${RESET}`);
  console.log(`${BOLD}║${RESET}  Total demo duration:    ${GREEN}${formatDuration(duration).padEnd(20)}${RESET}${BOLD}║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════╝${RESET}\n`);
}

async function main() {
  const startedAt = Date.now();
  let cycle = 0;
  let stageIndex = 0;
  const statusMap = new Map<string, AgentStatus>(
    agents.map((a) => [a.name, "starting" as AgentStatus])
  );

  log.info("╔══════════════════════════════════════╗");
  log.info("║      AuditGuard Demo Runner          ║");
  log.info("║      DEMO MODE — compressed timers   ║");
  log.info("╚══════════════════════════════════════╝");
  log.info(`Launching ${agents.length} agents...`);
  log.info(`Demo duration: ${DEMO_DURATION_MS / 1000}s`);
  log.info(`Cycle summary every: ${CYCLE_SUMMARY_INTERVAL_MS / 1000}s\n`);

  const processes: ChildProcess[] = [];

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

    proc.on("spawn", () => {
      statusMap.set(agent.name, "running");
    });

    proc.on("error", (err) => {
      statusMap.set(agent.name, "error");
      log.error(`${agent.name} failed to start: ${err}`);
    });

    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        statusMap.set(agent.name, "error");
        log.warn(`${agent.name} exited with code ${code}`);
      } else {
        statusMap.set(agent.name, "completed");
      }
    });

    processes.push(proc);
  }

  log.info(`\n✓ All ${agents.length} agents launched.\n`);

  // Advance lifecycle stage label every 12s
  printLifecycleStage(stageIndex);
  const stageTimer = setInterval(() => {
    stageIndex++;
    printLifecycleStage(stageIndex);
  }, LIFECYCLE_STAGE_MS);

  // Print cycle summary every 60s
  const cycleTimer = setInterval(() => {
    cycle++;
    printCycleSummary(cycle, startedAt, statusMap);
  }, CYCLE_SUMMARY_INTERVAL_MS);

  // Auto-shutdown after demo duration
  const demoTimer = setTimeout(() => {
    log.info("\n⏰ Demo duration reached. Shutting down...");
    shutdown(processes, cycle, startedAt, stageTimer, cycleTimer);
  }, DEMO_DURATION_MS);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", () => {
    clearTimeout(demoTimer);
    log.info("\n⏹ Manual shutdown requested...");
    shutdown(processes, cycle, startedAt, stageTimer, cycleTimer);
  });
}

function shutdown(
  processes: ChildProcess[],
  totalCycles: number,
  startedAt: number,
  stageTimer: ReturnType<typeof setInterval>,
  cycleTimer: ReturnType<typeof setInterval>,
) {
  clearInterval(stageTimer);
  clearInterval(cycleTimer);
  printFinalSummary(totalCycles, startedAt);
  for (const proc of processes) {
    proc.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000);
}

main().catch(console.error);
