import { createServer } from "node:http";
import { SERVICE_VERSION } from "@edgeguard/shared";
import { createDemoApp } from "./app";
import { DemoMetrics } from "./metrics";

function integerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    process.stderr.write(`Invalid ${name}: expected an integer between ${min} and ${max}\n`);
    process.exit(1);
  }
  return parsed;
}

const port = integerFromEnv("DEMO_PORT", 4000, 1, 65_535);
const host = process.env.DEMO_HOST?.trim() || "0.0.0.0";
const metrics = new DemoMetrics(SERVICE_VERSION);
const app = createDemoApp({ metrics });
const server = createServer(app);

server.listen(port, host, () => {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "edgeguard-demo-api",
      message: "demo api listening",
      host,
      port,
      version: SERVICE_VERSION,
    }) + "\n",
  );
});

const shutdown = (signal: string) => {
  process.stdout.write(
    JSON.stringify({ level: "info", service: "edgeguard-demo-api", message: "shutting down", signal }) +
      "\n",
  );
  server.close(() => process.exit(0));
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
