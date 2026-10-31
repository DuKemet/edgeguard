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

describeRedis("proxy integration", () => {
  let runtime: GatewayRuntime;
  let upstream: TestUpstream;

  beforeAll(async () => {
    upstream = await startUpstream();
    runtime = await startRuntime({
      UPSTREAM_URL: upstream.url,
      UPSTREAM_ALLOWED_HOSTS: "127.0.0.1",
      UPSTREAM_TIMEOUT_MS: "300",
      MAX_RESPONSE_BYTES: "2048",
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await upstream?.close();
  });

  it("proxies allowed requests and applies rate-limit headers", async () => {
    const response = await requestAgent(runtime.app)
      .get("/api/products?limit=5")
      .expect(200);
    expect(response.body).toMatchObject({ ok: true, url: "/api/products?limit=5" });
    expect(response.headers["x-edgeguard-rule"]).toBe("products");
    expect(response.headers["ratelimit-limit"]).toBe("30");
    expect(Number(response.headers["ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    expect(response.headers["x-request-id"]).toBeTruthy();
    const forwarded = upstream.requests.at(-1);
    expect(forwarded?.url).toBe("/api/products?limit=5");
    expect(forwarded?.headers["x-request-id"]).toBe(response.headers["x-request-id"]);
    expect(forwarded?.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("preserves request bodies and methods", async () => {
    const payload = { hello: "world" };
    const response = await requestAgent(runtime.app)
      .post("/api/echo")
      .set("content-type", "application/json")
      .send(payload)
      .expect(200);
    expect(response.body).toMatchObject({ method: "POST", url: "/api/echo" });
    expect(JSON.parse(response.body.body as string)).toEqual(payload);
  });

  it("strips unsafe response headers", async () => {
    const response = await requestAgent(runtime.app).get("/api/echo").expect(200);
    expect(response.headers["x-upstream"]).toBe("demo");
    expect(response.headers.server).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects unsupported methods with an Allow header", async () => {
    const response = await requestAgent(runtime.app).trace("/api/products").expect(405);
    expect(response.headers.allow).toContain("GET");
    expect(response.body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("rejects unsafe and malformed request targets", async () => {
    await requestAgent(runtime.app).get("/api/%2e%2e/secret").expect(400);
    await requestAgent(runtime.app).get("/api/%2fetc/passwd").expect(400);
    await requestAgent(runtime.app).get(`/api/${"a".repeat(3_000)}`).expect(400);
  });

  it("proxies upstream 5xx responses but marks them as errors", async () => {
    const response = await requestAgent(runtime.app).get("/api/error").expect(503);
    expect(response.body).toEqual({ error: "upstream down" });
  });

  it("returns 502 when the upstream response exceeds the size limit", async () => {
    const response = await requestAgent(runtime.app).get("/api/large").expect(502);
    expect(response.body.error.code).toBe("BAD_GATEWAY");
  });

  it("returns 504 when the upstream times out", async () => {
    const response = await requestAgent(runtime.app).get("/api/slow").expect(504);
    expect(response.body.error.code).toBe("GATEWAY_TIMEOUT");
  });

  it("serves health checks", async () => {
    const live = await requestAgent(runtime.app).get("/health/live").expect(200);
    expect(live.body.status).toBe("ok");
    const ready = await requestAgent(runtime.app).get("/health/ready").expect(200);
    expect(ready.body.checks.redis).toBe("ok");
  });

  it("exposes Prometheus metrics", async () => {
    const response = await requestAgent(runtime.app).get("/metrics").expect(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("edgeguard_gateway_requests_total");
    expect(response.text).toContain('service="edgeguard-gateway"');
  });
});

describeRedis("rate limiting integration", () => {
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

  it("allows burst capacity then rejects with Retry-After", async () => {
    let limited;
    for (let index = 0; index < 40; index += 1) {
      const response = await requestAgent(runtime.app).get("/api/profile");
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(limited).toBeTruthy();
    expect(limited?.headers["retry-after"]).toBeTruthy();
    expect(limited?.headers["ratelimit-remaining"]).toBe("0");
    expect(limited?.body.error.code).toBe("RATE_LIMITED");
    expect(limited?.body.error.details.reason).toBe("rate_limit");
    expect(limited?.body.error.details.ruleId).toBe("profile");
  });

  it("shares counters between two gateway instances", async () => {
    const secondUpstream = await startUpstream();
    const second = await startRuntime({
      UPSTREAM_URL: secondUpstream.url,
      REDIS_PREFIX: runtime.config.redisPrefix,
    });
    await runtime.cleanupKeys();
    try {
      await runtime.deps.rules.update("orders", { limit: 5, windowSeconds: 3_600, burst: 0 });
      for (let index = 0; index < 2; index += 1) {
        await requestAgent(runtime.app).get("/api/orders").expect(200);
        await requestAgent(second.app).get("/api/orders").expect(200);
      }
      await requestAgent(runtime.app).get("/api/orders").expect(200);
      const limited = await requestAgent(second.app).get("/api/orders").expect(429);
      expect(limited.body.error.details.ruleId).toBe("orders");
      const firstLimited = await requestAgent(runtime.app).get("/api/orders").expect(429);
      expect(firstLimited.body.error.details.ruleId).toBe("orders");
    } finally {
      await second.cleanupKeys();
      await second.redis.close();
      await secondUpstream.close();
    }
  });
});
