import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";
import type { AgentRole } from "./types.js";

const AGENTS_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOG_DIR = resolve(AGENTS_ROOT_DIR, "logs");

function resolveLogDirectory(): string {
  const configuredDir = process.env.AGENT_LOG_DIR?.trim();
  if (!configuredDir) return DEFAULT_LOG_DIR;
  return isAbsolute(configuredDir) ? configuredDir : resolve(process.cwd(), configuredDir);
}

function resolveLogFilePath(role: AgentRole): string {
  const logDir = resolveLogDirectory();
  mkdirSync(logDir, { recursive: true });
  return join(logDir, `${role}.log`);
}

export function createAgentLogger(agentId: string, role: AgentRole) {
  const tag = `[${role.toUpperCase().padEnd(16)}][${agentId}]`;
  const logFilePath = resolveLogFilePath(role);
  const transports: winston.transport[] = [
    new winston.transports.File({ filename: logFilePath }),
  ];

  if ((process.env.AGENT_LOG_STDOUT ?? "true") !== "false") {
    transports.push(new winston.transports.Console());
  }

  return winston.createLogger({
    level: process.env.AGENT_LOG_LEVEL ?? "info",
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message }) => {
        const lvl = level.toUpperCase().padEnd(5);
        return `${timestamp} ${tag} ${lvl} ${String(message)}`;
      })
    ),
    transports,
  });
}
