import winston from "winston";

export function createLogger(scope = "orchestrator") {
  return winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp({ format: "HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} [${scope}] ${level.toUpperCase()}: ${message}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
