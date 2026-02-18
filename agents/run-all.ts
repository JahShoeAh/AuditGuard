/**
 * AuditGuard Agent Launcher — runs all 7 agents concurrently
 * with health monitoring and auto-restart.
 *
 * Usage:
 *   npx tsx run-all.ts                     # normal mode
 *   DEMO_MODE=true npx tsx run-all.ts      # compressed timers for demos
 */

import { spawn, type ChildProcess } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

interface AgentDef {
    name: string;
    script: string;
    color: string;
}

interface AgentState {
    def: AgentDef;
    child: ChildProcess | null;
    restarts: number;
    lastStarted: number;
    healthy: boolean;
}

const MAX_RESTARTS = 3;
const RESTART_BACKOFF_BASE_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const AGENTS: AgentDef[] = [
    { name: "Scanner", script: "scanner/index.ts", color: "\x1b[36m" },
    { name: "Static", script: "static-analysis/index.ts", color: "\x1b[32m" },
    { name: "Fuzzer", script: "fuzzer/index.ts", color: "\x1b[33m" },
    { name: "LLM", script: "llm-contextual/index.ts", color: "\x1b[35m" },
    { name: "Dependency", script: "dependency/index.ts", color: "\x1b[34m" },
    { name: "Report", script: "report/index.ts", color: "\x1b[37m" },
    { name: "Alert", script: "alert/index.ts", color: "\x1b[31m" },
];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pad(name: string, len = 12): string {
    return name.padEnd(len);
}

function timestamp(): string {
    return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const states: AgentState[] = [];
let shuttingDown = false;

function spawnAgent(state: AgentState): void {
    if (shuttingDown) return;

    const { def } = state;
    const isDemo = process.env.DEMO_MODE === "true";

    const child = spawn("npx", ["tsx", join(__dir, def.script)], {
        cwd: __dir,
        env: { ...process.env, DEMO_MODE: isDemo ? "true" : "false" },
        stdio: ["ignore", "pipe", "pipe"],
    });

    state.child = child;
    state.lastStarted = Date.now();
    state.healthy = true;

    const prefix = `${def.color}${BOLD}[${pad(def.name)}]${RESET} `;

    child.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
            process.stdout.write(`${DIM}${timestamp()}${RESET} ${prefix}${line}\n`);
        }
    });

    child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
            process.stderr.write(`${DIM}${timestamp()}${RESET} ${prefix}\x1b[31m${line}${RESET}\n`);
        }
    });

    child.on("exit", (code) => {
        state.healthy = false;
        state.child = null;

        if (shuttingDown) {
            console.log(`${prefix}${DIM}stopped${RESET}`);
            return;
        }

        console.log(`${prefix}${DIM}exited with code ${code}${RESET}`);

        if (state.restarts < MAX_RESTARTS) {
            const backoff = RESTART_BACKOFF_BASE_MS * Math.pow(2, state.restarts);
            state.restarts++;
            console.log(
                `${prefix}\x1b[33mrestarting in ${backoff / 1000}s ` +
                `(attempt ${state.restarts}/${MAX_RESTARTS})${RESET}`
            );
            setTimeout(() => spawnAgent(state), backoff);
        } else {
            console.log(
                `${prefix}\x1b[31mmax restarts (${MAX_RESTARTS}) reached — agent will not be restarted${RESET}`
            );
        }
    });
}

function runHealthCheck(): void {
    const now = Date.now();
    let healthyCount = 0;
    let totalCount = states.length;

    for (const state of states) {
        if (state.child && !state.child.killed) {
            healthyCount++;
        }
    }

    const status = healthyCount === totalCount ? "\x1b[32mHEALTHY" : "\x1b[33mDEGRADED";
    console.log(
        `\n${DIM}${timestamp()}${RESET} ${BOLD}[HealthCheck]${RESET} ` +
        `${status} (${healthyCount}/${totalCount} agents running)${RESET}`
    );

    for (const state of states) {
        const alive = state.child && !state.child.killed;
        const icon = alive ? "\x1b[32m●" : "\x1b[31m○";
        const uptime = alive ? `${Math.round((now - state.lastStarted) / 1000)}s` : "down";
        console.log(
            `  ${icon}${RESET} ${pad(state.def.name)} restarts=${state.restarts} uptime=${uptime}`
        );
    }
    console.log("");
}

async function main() {
    const isDemo = process.env.DEMO_MODE === "true";

    console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${BOLD}║       AuditGuard Agent Swarm${isDemo ? " (DEMO MODE)" : ""}                    ║${RESET}`);
    console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n`);

    for (const def of AGENTS) {
        const state: AgentState = {
            def,
            child: null,
            restarts: 0,
            lastStarted: 0,
            healthy: false,
        };
        states.push(state);
        spawnAgent(state);
        console.log(`  ${def.color}●${RESET} ${def.name} started (PID ${state.child?.pid})`);
    }

    console.log(`\n  ${DIM}Auto-restart: up to ${MAX_RESTARTS} retries per agent${RESET}`);
    console.log(`  ${DIM}Health checks every ${HEALTH_CHECK_INTERVAL_MS / 1000}s${RESET}`);
    console.log(`  ${DIM}Press Ctrl+C to stop all agents${RESET}\n`);

    // Periodic health check
    const healthInterval = setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);

    const shutdown = () => {
        shuttingDown = true;
        clearInterval(healthInterval);
        console.log(`\n${BOLD}Shutting down all agents...${RESET}`);
        for (const state of states) {
            state.child?.kill("SIGTERM");
        }
        setTimeout(() => {
            for (const state of states) {
                if (state.child && !state.child.killed) state.child.kill("SIGKILL");
            }
            process.exit(0);
        }, 5000);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise(() => { });
}

main().catch((err) => {
    console.error(`Fatal: ${err}`);
    process.exit(1);
});
