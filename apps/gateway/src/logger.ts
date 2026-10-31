import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "password",
  "token",
  "apiKey",
  "api_key",
  "*.password",
  "*.token",
  "*.authorization",
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "edgeguard-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
    },
  });
}

export type { Logger };
