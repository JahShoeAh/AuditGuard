/**
 * AuditGuard Agent Launcher — runs all 7 agents concurrently.
 *
 * Usage:
 *   npx tsx run-all.ts                     # normal mode
 *   DEMO_MODE=true npx tsx run-all.ts      # compressed timers for demos
 *
 * Each agent runs as a separate tsx process with color-coded output.
 * Ctrl+C gracefully shuts down all agents.
 */

import { spawn, type ChildProcess } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

interface AgentDef {
    name: string;
    script: string;
    color: string;   // ANSI color code
}

const AGENTS: AgentDef[] = [
    { name: "Scanner", script: "scanner/index.ts", color: "\x1b[36m" },  // cyan
    { name: "Static", script: "static-analysis/index.ts", color: "\x1b[32m" },  // green
    { name: "Fuzzer", script: "fuzzer/index.ts", color: "\x1b[33m" },  // yellow
    { name: "LLM", script: "llm-contextual/index.ts", color: "\x1b[35m" },  // magenta
    { name: "Dependency", script: "dependency/index.ts", color: "\x1b[34m" },  // blue
    { name: "Report", script: "report/index.ts", color: "\x1b[37m" },  // white
    { name: "Alert", script: "alert/index.ts", color: "\x1b[31m" },  // red
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

async function main() {
    const isDemo = process.env.DEMO_MODE === "true";

    console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${BOLD}║       AuditGuard Agent Swarm${isDemo ? " (DEMO MODE)" : ""}                    ║${RESET}`);
    console.log(`${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}\n`);

    const children: ChildProcess[] = [];

    for (const agent of AGENTS) {
        const child = spawn("npx", ["tsx", join(__dir, agent.script)], {
            cwd: __dir,
            env: { ...process.env, DEMO_MODE: isDemo ? "true" : "false" },
            stdio: ["ignore", "pipe", "pipe"],
        });

        children.push(child);

        const prefix = `${agent.color}${BOLD}[${pad(agent.name)}]${RESET} `;

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
            console.log(`${prefix}${DIM}exited with code ${code}${RESET}`);
        });

        console.log(`  ${agent.color}●${RESET} ${agent.name} started (PID ${child.pid})`);
    }

    console.log(`\n  ${DIM}Press Ctrl+C to stop all agents${RESET}\n`);

    // Graceful shutdown
    const shutdown = () => {
        console.log(`\n${BOLD}Shutting down all agents...${RESET}`);
        for (const child of children) {
            child.kill("SIGTERM");
        }
        setTimeout(() => {
            // Force kill after 5 seconds
            for (const child of children) {
                if (!child.killed) child.kill("SIGKILL");
            }
            process.exit(0);
        }, 5000);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep alive
    await new Promise(() => { });
}

main().catch((err) => {
    console.error(`Fatal: ${err}`);
    process.exit(1);
});
