import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_PASSWORD,
  TEST_VIEWER_PASSWORD,
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

async function tokenFor(
  app: GatewayRuntime["app"],
  username: string,
  password: string,
  ip = "127.0.0.1",
) {
  const response = await requestAgent(app)
    .post("/admin/auth/login")
    .set("x-forwarded-for", ip)
    .send({ username, password })
    .expect(200);
  return response.body.token as string;
}

describeRedis("admin API integration", () => {
  let runtime: GatewayRuntime;
  let upstream: TestUpstream;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    upstream = await startUpstream();
    runtime = await startRuntime({ UPSTREAM_URL: upstream.url, TRUST_PROXY: "true" });
    adminToken = await tokenFor(runtime.app, "admin", TEST_ADMIN_PASSWORD);
    viewerToken = await tokenFor(runtime.app, "viewer", TEST_VIEWER_PASSWORD);
  });

  afterAll(async () => {
    await runtime?.close();
    await upstream?.close();
  });

  it("rejects unauthenticated admin requests", async () => {
    const response = await requestAgent(runtime.app).get("/admin/overview").expect(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects invalid credentials", async () => {
    const response = await requestAgent(runtime.app)
      .post("/admin/auth/login")
      .send({ username: "admin", password: "not-the-password" })
      .expect(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the authenticated user", async () => {
    const response = await requestAgent(runtime.app)
      .get("/admin/auth/me")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(response.body.user).toEqual({ username: "admin", role: "admin" });
  });

  it("allows viewers to read but not mutate", async () => {
    await requestAgent(runtime.app)
      .get("/admin/overview")
      .set("authorization", `Bearer ${viewerToken}`)
      .expect(200);
    const forbidden = await requestAgent(runtime.app)
      .put("/admin/rules/products")
      .set("authorization", `Bearer ${viewerToken}`)
      .send({ limit: 50 })
      .expect(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
  });

  it("lets admins update rules", async () => {
    const updated = await requestAgent(runtime.app)
      .put("/admin/rules/products")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ limit: 45, burst: 15 })
      .expect(200);
    expect(updated.body.item).toMatchObject({ id: "products", limit: 45, burst: 15 });

    const rules = await requestAgent(runtime.app)
      .get("/admin/rules")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(rules.body.items.find((rule: { id: string }) => rule.id === "products").limit).toBe(45);
  });

  it("validates rule mutations", async () => {
    await requestAgent(runtime.app)
      .put("/admin/rules/products")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ limit: -1 })
      .expect(400);
    await requestAgent(runtime.app)
      .put("/admin/rules/default")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ endpoint: "/other" })
      .expect(400);
    await requestAgent(runtime.app)
      .delete("/admin/rules/default")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(400);
    await requestAgent(runtime.app)
      .delete("/admin/rules/missing")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(404);
  });

  it("exposes consistent overview, traffic, client and event data", async () => {
    for (let index = 0; index < 5; index += 1) {
      await requestAgent(runtime.app)
        .get("/api/products")
        .set("x-forwarded-for", "203.0.113.50")
        .expect(200);
    }

    const overview = await requestAgent(runtime.app)
      .get("/admin/overview")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(overview.body).toMatchObject({ redisStatus: "ok", gatewayVersion: runtime.config.version });
    expect(overview.body.requests).toBeGreaterThanOrEqual(5);
    expect(overview.body.allowed).toBeGreaterThanOrEqual(5);
    expect(overview.body.latency.p95Ms).toBeGreaterThanOrEqual(0);

    const traffic = await requestAgent(runtime.app)
      .get("/admin/traffic?windowMinutes=15")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(traffic.body.buckets)).toBe(true);
    expect(traffic.body.endpoints.some((item: { endpoint: string }) => item.endpoint === "/api/products")).toBe(true);
    expect(traffic.body.clients.length).toBeGreaterThanOrEqual(1);

    const clients = await requestAgent(runtime.app)
      .get("/admin/clients?windowMinutes=60")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(clients.body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(clients.body.activeBlocks)).toBe(true);

    const events = await requestAgent(runtime.app)
      .get("/admin/events?page=1&pageSize=10")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(events.body.items)).toBe(true);
    expect(events.body.page).toBe(1);
  });

  it("validates admin query parameters", async () => {
    await requestAgent(runtime.app)
      .get("/admin/events?pageSize=500")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(400);
    await requestAgent(runtime.app)
      .get("/admin/traffic?windowMinutes=9999")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(400);
  });

  it("updates detection settings with validation", async () => {
    const current = await requestAgent(runtime.app)
      .get("/admin/settings")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    const detection = current.body.detection;
    const updated = await requestAgent(runtime.app)
      .put("/admin/settings")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ detection: { ...detection, violationThreshold: 2, isolationSeconds: 5, suppressionSeconds: 1 } })
      .expect(200);
    expect(updated.body.detection.violationThreshold).toBe(2);
    expect(updated.body.detection.isolationSeconds).toBe(5);

    await requestAgent(runtime.app)
      .put("/admin/settings")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ detection: { ...detection, isolationSeconds: 1 } })
      .expect(400);
  });

  it("isolates abusive clients and allows administrators to unblock them", async () => {
    await runtime.deps.rules.update("profile", { limit: 5, windowSeconds: 3_600, burst: 0 });
    let first;
    for (let index = 0; index < 10; index += 1) {
      const response = await requestAgent(runtime.app)
        .get("/api/profile")
        .set("x-forwarded-for", "203.0.113.77");
      if (response.status === 429) {
        first = response;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(first?.body.error.details.reason).toBe("rate_limit");

    let isolated;
    for (let index = 0; index < 10; index += 1) {
      const response = await requestAgent(runtime.app)
        .get("/api/profile")
        .set("x-forwarded-for", "203.0.113.77")
        .expect(429);
      if (response.body.error.details.reason === "isolated") {
        isolated = response;
        break;
      }
    }
    expect(isolated).toBeTruthy();
    expect(isolated?.headers["x-edgeguard-isolated"]).toBe("true");

    const clients = await requestAgent(runtime.app)
      .get("/admin/clients?windowMinutes=60")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    const blocked = clients.body.activeBlocks[0];
    expect(blocked).toBeTruthy();
    expect(blocked.maskedIp).toBe("203.0.113.xxx");

    const unblocked = await requestAgent(runtime.app)
      .post(`/admin/clients/${blocked.clientId}/unblock`)
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(unblocked.body.unblocked).toBe(true);

    const events = await requestAgent(runtime.app)
      .get("/admin/events?category=admin_unblock")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(events.body.total).toBeGreaterThanOrEqual(1);
  });

  it("rejects unblocking clients that are not isolated", async () => {
    await requestAgent(runtime.app)
      .post("/admin/clients/abcdef1234567890/unblock")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(404);
    await requestAgent(runtime.app)
      .post("/admin/clients/%20/unblock")
      .set("authorization", `Bearer ${adminToken}`)
      .expect(400);
  });

  it("enforces the configured CORS allowlist", async () => {
    const allowed = await requestAgent(runtime.app)
      .get("/admin/overview")
      .set("authorization", `Bearer ${adminToken}`)
      .set("origin", "http://localhost:5173")
      .expect(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const denied = await requestAgent(runtime.app)
      .get("/admin/overview")
      .set("authorization", `Bearer ${adminToken}`)
      .set("origin", "https://evil.example.com")
      .expect(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("throttles repeated failed logins per client", async () => {
    for (let index = 0; index < 10; index += 1) {
      await requestAgent(runtime.app)
        .post("/admin/auth/login")
        .set("x-forwarded-for", "198.51.100.10")
        .send({ username: "admin", password: "wrong-password" })
        .expect(401);
    }
    const throttled = await requestAgent(runtime.app)
      .post("/admin/auth/login")
      .set("x-forwarded-for", "198.51.100.10")
      .send({ username: "admin", password: TEST_ADMIN_PASSWORD })
      .expect(429);
    expect(throttled.body.error.code).toBe("LOGIN_THROTTLED");
    expect(throttled.headers["retry-after"]).toBeTruthy();
  });
});

describeRedis("metrics authentication", () => {
  let runtime: GatewayRuntime;
  let upstream: TestUpstream;

  beforeAll(async () => {
    upstream = await startUpstream();
    runtime = await startRuntime({ UPSTREAM_URL: upstream.url, METRICS_TOKEN: "metrics-secret" });
  });

  afterAll(async () => {
    await runtime?.close();
    await upstream?.close();
  });

  it("requires a bearer token when METRICS_TOKEN is configured", async () => {
    const unauthorized = await requestAgent(runtime.app).get("/metrics").expect(401);
    expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");
    await requestAgent(runtime.app)
      .get("/metrics")
      .set("authorization", "Bearer wrong")
      .expect(401);
    const authorized = await requestAgent(runtime.app)
      .get("/metrics")
      .set("authorization", "Bearer metrics-secret")
      .expect(200);
    expect(authorized.text).toContain("edgeguard_gateway_requests_total");
  });
});
