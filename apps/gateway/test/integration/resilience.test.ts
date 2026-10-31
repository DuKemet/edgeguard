import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  requestAgent,
  startRuntime,
  startUpstream,
  testRedisUrl,
  type GatewayRuntime,
  type TestUpstream,
} from "../helpers/runtime";

async function redisReachable(): Promise<boolean> {
  const client = new Redis(testRedisUrl(), {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    client.disconnect();
    return false;
  }
}

const available = await redisReachable();
const describeRedis = available ? describe : describe.skip;

describe("redis outage fallback", () => {
  let runtime: GatewayRuntime;
  let upstream: TestUpstream;
  let requiredRuntime: GatewayRuntime;

  beforeAll(async () => {
    upstream = await startUpstream();
    runtime = await startRuntime({
      UPSTREAM_URL: upstream.url,
      REDIS_URL: "redis://127.0.0.1:6399",
      REDIS_CONNECT_TIMEOUT_MS: "300",
      REDIS_COMMAND_TIMEOUT_MS: "300",
    });
    requiredRuntime = await startRuntime({
      UPSTREAM_URL: upstream.url,
      REDIS_URL: "redis://127.0.0.1:6399",
      REDIS_CONNECT_TIMEOUT_MS: "300",
      REDIS_COMMAND_TIMEOUT_MS: "300",
      REDIS_REQUIRED: "true",
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await requiredRuntime?.close();
    await upstream?.close();
  });

  it("serves requests with the local limiter and marks the response degraded", async () => {
    const response = await requestAgent(runtime.app).get("/api/products").expect(200);
    expect(response.headers["x-edgeguard-redis"]).toBe("degraded");
    expect(response.headers["x-edgeguard-rule"]).toBe("products");
    expect(runtime.redis.isReady()).toBe(false);
  });

  it("enforces limits locally while redis is unavailable", async () => {
    await runtime.deps.rules.update("profile", { limit: 5, windowSeconds: 3_600, burst: 0 });
    for (let index = 0; index < 5; index += 1) {
      await requestAgent(runtime.app).get("/api/profile").expect(200);
    }
    const limited = await requestAgent(runtime.app).get("/api/profile").expect(429);
    expect(limited.body.error.details.reason).toBe("rate_limit");
  });

  it("reports degraded readiness unless redis is required", async () => {
    const degraded = await requestAgent(runtime.app).get("/health/ready").expect(200);
    expect(degraded.body.status).toBe("degraded");
    expect(degraded.body.checks.redis).toBe("down");

    const failed = await requestAgent(requiredRuntime.app).get("/health/ready").expect(503);
    expect(failed.body.status).toBe("degraded");
  });
});

describeRedis("isolation lifecycle", () => {
  let runtime: GatewayRuntime;
  let upstream: TestUpstream;

  beforeAll(async () => {
    upstream = await startUpstream();
    runtime = await startRuntime({ UPSTREAM_URL: upstream.url });
  });

  afterAll(async () => {
    await runtime?.close();
    await upstream?.close();
  });

  it("expires temporary isolation automatically", async () => {
    const clientId = "abcdef1234567890";
    const block = await runtime.deps.blocks.block({
      clientId,
      maskedIp: "203.0.113.xxx",
      reason: "test isolation",
      category: "manual",
      seconds: 1,
    });
    expect(block.remainingSeconds).toBeLessThanOrEqual(1);

    const active = await runtime.deps.blocks.isBlocked(clientId);
    expect(active).not.toBeNull();
    expect(active?.clientId).toBe(clientId);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await runtime.deps.blocks.isBlocked(clientId)).toBeNull();
    expect(await runtime.deps.blocks.listActive()).toHaveLength(0);
  });

  it("stores and removes blocks in redis", async () => {
    const clientId = "fedcba0987654321";
    await runtime.deps.blocks.block({
      clientId,
      maskedIp: "198.51.100.xxx",
      reason: "durable isolation",
      category: "rate_limit_violation",
      seconds: 30,
    });
    const stored = await runtime.redis.client.get(
      `${runtime.config.redisPrefix}:block:${clientId}`,
    );
    expect(stored).toBeTruthy();
    expect(await runtime.deps.blocks.unblock(clientId)).toBe(true);
    expect(
      await runtime.redis.client.get(`${runtime.config.redisPrefix}:block:${clientId}`),
    ).toBeNull();
  });
});
