import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import pino from "pino";
import supertest from "supertest";
import { createApp, createAppDependencies, type AppDependencies } from "../../src/app";
import { parseConfig, type GatewayConfig } from "../../src/config";
import { GatewayMetrics } from "../../src/metrics";
import { RedisManager } from "../../src/redis";

export const TEST_ADMIN_HASH =
  "$2a$10$R09DVx/ut7inN0V6a63FaOONsj80JOgxNBGp27Up5gCi39fpjjgrK";
export const TEST_VIEWER_HASH =
  "$2a$10$0Aqv/Z/jDZiqj5ilhr9.YOg.sZ3RMTWiXNqc2vs4hPwp92.1wbZAK";
export const TEST_ADMIN_PASSWORD = "test-admin-password";
export const TEST_VIEWER_PASSWORD = "test-viewer-password";
export const TEST_JWT_SECRET = "edgeguard-test-jwt-secret-with-32-chars-minimum";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
}

export function uniquePrefix(label = "test"): string {
  return `edgeguard_${label}_${process.pid}_${randomBytes(4).toString("hex")}`;
}

export function testConfig(overrides: Record<string, string | undefined> = {}): GatewayConfig {
  return parseConfig({
    NODE_ENV: "test",
    PORT: "8080",
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    JWT_SECRET: TEST_JWT_SECRET,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: TEST_ADMIN_HASH,
    VIEWER_USERNAME: "viewer",
    VIEWER_PASSWORD_HASH: TEST_VIEWER_HASH,
    REDIS_URL: testRedisUrl(),
    REDIS_PREFIX: uniquePrefix(),
    REDIS_CONNECT_TIMEOUT_MS: "1000",
    REDIS_COMMAND_TIMEOUT_MS: "2000",
    UPSTREAM_URL: "http://127.0.0.1:4000",
    UPSTREAM_ALLOWED_HOSTS: "127.0.0.1",
    ALLOW_PRIVATE_UPSTREAMS: "true",
    UPSTREAM_TIMEOUT_MS: "2000",
    TRUST_PROXY: "false",
    CORS_ORIGINS: "http://localhost:5173",
    MAX_RESPONSE_BYTES: "65536",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export function silentLogger() {
  return pino({ level: "silent" });
}

export interface GatewayRuntime {
  app: ReturnType<typeof createApp>;
  deps: AppDependencies;
  redis: RedisManager;
  config: GatewayConfig;
  close: () => Promise<void>;
  cleanupKeys: () => Promise<void>;
}

export async function startRuntime(
  overrides: Record<string, string | undefined> = {},
): Promise<GatewayRuntime> {
  const config = testConfig(overrides);
  const logger = silentLogger();
  const metrics = new GatewayMetrics(config.version);
  const redis = new RedisManager({
    url: config.redisUrl,
    connectTimeoutMs: config.redisConnectTimeoutMs,
    commandTimeoutMs: config.redisCommandTimeoutMs,
    logger,
    onError: (operation) => metrics.redisErrors.inc({ operation }),
  });
  await redis.connect();
  const deps = createAppDependencies({ config, logger, redis });
  await deps.rules.init();
  await deps.settings.init();
  const app = createApp(deps);

  const cleanupKeys = async () => {
    if (!redis.isReady()) return;
    const keys = await redis.client.keys(`${config.redisPrefix}:*`);
    if (keys.length > 0) await redis.client.del(...keys);
  };

  return {
    app,
    deps,
    redis,
    config,
    cleanupKeys,
    async close() {
      await cleanupKeys();
      await redis.close();
    },
  };
}

export interface TestUpstream {
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }>;
  close: () => Promise<void>;
}

export async function startUpstream(): Promise<TestUpstream> {
  const requests: TestUpstream["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";
      requests.push({ method: req.method ?? "GET", url, headers: req.headers, body });

      if (url.startsWith("/api/slow")) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ slow: true }));
        }, 600);
        return;
      }
      if (url.startsWith("/api/error")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream down" }));
        return;
      }
      if (url.startsWith("/api/large")) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": "4096",
        });
        res.end(Buffer.alloc(4096, 0x61));
        return;
      }
      if (url.startsWith("/api/echo")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-upstream": "demo",
          server: "test-upstream",
        });
        res.end(JSON.stringify({ method: req.method, url, body }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "demo",
      });
      res.end(JSON.stringify({ ok: true, url }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test upstream failed to bind to a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function login(
  app: GatewayRuntime["app"],
  username = "admin",
  password = TEST_ADMIN_PASSWORD,
): Promise<string> {
  const response = await requestAgent(app)
    .post("/admin/auth/login")
    .send({ username, password })
    .expect(200);
  return response.body.token as string;
}

export function requestAgent(app: GatewayRuntime["app"]) {
  return supertest(app);
}
