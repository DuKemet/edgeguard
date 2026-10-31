interface Config {
  baseUrl: string;
  pattern: "mixed" | "allowed" | "abuse" | "errors";
  durationSeconds: number;
  concurrency: number;
  maxRequests: number;
  requestTimeoutMs: number;
  delayMs: number;
}

type Pattern = Config["pattern"];

interface Target {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

const ALLOWED_TARGETS: Target[] = [
  { method: "GET", path: "/api/products?limit=10" },
  { method: "GET", path: "/api/products/p-100" },
  { method: "GET", path: "/api/orders" },
  { method: "GET", path: "/api/profile" },
  { method: "POST", path: "/api/orders", body: { productId: "p-105", quantity: 1 } },
  { method: "POST", path: "/api/echo", body: { source: "loadgen" } },
];

const ERROR_TARGETS: Target[] = [
  { method: "GET", path: "/api/error?status=500" },
  { method: "GET", path: "/api/error?status=503" },
  { method: "GET", path: "/api/slow?ms=400" },
];

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function loadConfig(): Config {
  const pattern = (process.env.LOADGEN_PATTERN ?? "mixed") as Pattern;
  if (!["mixed", "allowed", "abuse", "errors"].includes(pattern)) {
    throw new Error("LOADGEN_PATTERN must be mixed, allowed, abuse or errors");
  }
  const baseUrl = (process.env.LOADGEN_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  return {
    baseUrl,
    pattern,
    durationSeconds: integer("LOADGEN_DURATION", 30, 5, 600),
    concurrency: integer("LOADGEN_CONCURRENCY", 8, 1, 64),
    maxRequests: integer("LOADGEN_MAX_REQUESTS", 20_000, 1, 200_000),
    requestTimeoutMs: integer("LOADGEN_TIMEOUT_MS", 5_000, 100, 30_000),
    delayMs: integer("LOADGEN_DELAY_MS", 25, 0, 5_000),
  };
}

function clientAddress(worker: number): string {
  const third = 100 + (worker % 100);
  return `198.51.100.${third}`;
}

function targetFor(pattern: Pattern, worker: number, sequence: number): Target {
  if (pattern === "allowed") {
    return ALLOWED_TARGETS[sequence % ALLOWED_TARGETS.length]!;
  }
  if (pattern === "errors") {
    return ERROR_TARGETS[sequence % ERROR_TARGETS.length]!;
  }
  if (pattern === "abuse") {
    if (sequence % 25 === 0) {
      return ALLOWED_TARGETS[sequence % ALLOWED_TARGETS.length]!;
    }
    return { method: "GET", path: "/api/profile" };
  }
  const roll = sequence % 10;
  if (roll < 6) return ALLOWED_TARGETS[sequence % ALLOWED_TARGETS.length]!;
  if (roll < 8) return { method: "GET", path: "/api/profile" };
  if (roll < 9) return ERROR_TARGETS[sequence % ERROR_TARGETS.length]!;
  return { method: "GET", path: "/api/orders" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[index] ?? 0);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  const deadline = startedAt + config.durationSeconds * 1_000;
  const statuses = new Map<number, number>();
  const latencies: number[] = [];
  let sent = 0;
  let networkErrors = 0;
  let aborted = false;

  const shutdown = () => {
    aborted = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  process.stdout.write(
    JSON.stringify({
      level: "info",
      message: "load generation started",
      target: config.baseUrl,
      pattern: config.pattern,
      concurrency: config.concurrency,
      durationSeconds: config.durationSeconds,
    }) + "\n",
  );

  const report = () => {
    const elapsed = Math.max(1, (Date.now() - startedAt) / 1_000);
    process.stdout.write(
      JSON.stringify({
        level: "info",
        message: "progress",
        elapsedSeconds: Math.round(elapsed * 10) / 10,
        sent,
        requestsPerSecond: Math.round((sent / elapsed) * 10) / 10,
        networkErrors,
        statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
        p95Ms: percentile(latencies, 0.95),
      }) + "\n",
    );
  };

  const timer = setInterval(report, 5_000);
  timer.unref();

  const worker = async (workerId: number) => {
    let sequence = 0;
    while (!aborted && Date.now() < deadline && sent < config.maxRequests) {
      const target = targetFor(config.pattern, workerId, sequence);
      const requestStarted = Date.now();
      try {
        const response = await fetch(`${config.baseUrl}${target.path}`, {
          method: target.method,
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": clientAddress(workerId),
            "x-loadgen-worker": String(workerId),
          },
          body: target.body === undefined ? undefined : JSON.stringify(target.body),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        await response.arrayBuffer();
        latencies.push(Date.now() - requestStarted);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      } catch {
        networkErrors += 1;
      }
      sent += 1;
      sequence += 1;
      if (config.delayMs > 0) await sleep(config.delayMs);
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, (_, index) => worker(index)));
  clearInterval(timer);
  report();

  const elapsedSeconds = Math.round(((Date.now() - startedAt) / 1_000) * 10) / 10;
  const summary = {
    durationSeconds: elapsedSeconds,
    sent,
    networkErrors,
    requestsPerSecond: Math.round((sent / Math.max(1, elapsedSeconds)) * 10) / 10,
    statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
  process.stdout.write(JSON.stringify({ level: "info", message: "load generation complete", ...summary }) + "\n");
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      level: "error",
      message: "load generation failed",
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exit(1);
});
