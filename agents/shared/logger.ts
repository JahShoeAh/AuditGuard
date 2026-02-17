import winston from "winston";
import type { AgentRole } from "./types.js";

const AGENT_COLORS: Record<string, string> = {
  scanner: "\x1b[36m",        // cyan
  static_analysis: "\x1b[32m", // green
  fuzzer: "\x1b[33m",          // yellow
  llm_contextual: "\x1b[35m",  // magenta
  dependency: "\x1b[34m",      // blue
  report: "\x1b[37m",          // white
  alert: "\x1b[31m",           // red
};
const RESET = "\x1b[0m";

export function createAgentLogger(agentId: string, role: AgentRole) {
  const color = AGENT_COLORS[role] || "\x1b[0m";
  const tag = `[${role.toUpperCase().padEnd(16)}]`;

  return winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp({ format: "HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message }) => {
        const lvl = level.toUpperCase().padEnd(5);
        return `${timestamp} ${color}${tag}${RESET} ${lvl} ${message}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
