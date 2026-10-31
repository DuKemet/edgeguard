import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_EXPIRED_EVENT,
  ApiError,
  api,
  clearToken,
  getToken,
  setToken,
} from "../src/api/client";

function mockJson(status: number, body: unknown) {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe("api client", () => {
  it("posts login credentials without an authorization header", async () => {
    setToken("stale-token");
    const fetchMock = mockJson(200, {
      token: "new-token",
      expiresAt: new Date().toISOString(),
      user: { username: "admin", role: "admin" },
    });
    const response = await api.login("admin", "password123");
    const { url, init, headers } = lastCall(fetchMock);
    expect(url).toBe("/api/admin/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ username: "admin", password: "password123" });
    expect(headers.Authorization).toBeUndefined();
    expect(response.token).toBe("new-token");
  });

  it("attaches the bearer token to authenticated calls", async () => {
    setToken("session-token");
    const fetchMock = mockJson(200, {
      generatedAt: new Date().toISOString(),
      windowSeconds: 60,
      gatewayVersion: "1.0.0",
      redisStatus: "ok",
      requests: 0,
      requestsPerSecond: 0,
      allowed: 0,
      blocked: 0,
      violations: 0,
      upstreamErrors: 0,
      upstreamErrorRate: 0,
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
      activeBlocks: 0,
      eventsLastHour: 0,
    });
    await api.overview();
    const { url, headers } = lastCall(fetchMock);
    expect(getToken()).toBe("session-token");
    expect(url).toBe("/api/admin/overview");
    expect(headers.Authorization).toBe("Bearer session-token");
  });

  it("builds query strings and skips empty params", async () => {
    const fetchMock = mockJson(200, {
      generatedAt: new Date().toISOString(),
      total: 0,
      items: [],
      activeBlocks: [],
    });
    await api.clients({ page: 2, pageSize: 10, windowMinutes: 60 });
    expect(lastCall(fetchMock).url).toBe("/api/admin/clients?page=2&pageSize=10&windowMinutes=60");

    await api.events({ page: 1, pageSize: 25, severity: "", category: "traffic_spike" });
    expect(lastCall(fetchMock).url).toBe("/api/admin/events?page=1&pageSize=25&category=traffic_spike");
  });

  it("encodes client ids when unblocking", async () => {
    const fetchMock = mockJson(200, { unblocked: true, clientId: "abc", eventId: "evt" });
    await api.unblock("abc/../def");
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("/api/admin/clients/abc%2F..%2Fdef/unblock");
    expect(init.method).toBe("POST");
  });

  it("surfaces structured API errors", async () => {
    mockJson(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        requestId: "req-1",
        details: { field: "limit" },
      },
    });
    await expect(api.updateRule("products", { limit: -1 })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      requestId: "req-1",
      details: { field: "limit" },
    });
  });

  it("clears the token and emits an event on 401", async () => {
    setToken("expired-token");
    mockJson(401, { error: { code: "UNAUTHORIZED", message: "Invalid or expired session" } });
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
  });

  it("reports network failures with a stable error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(api.rules()).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach the EdgeGuard gateway",
    });
  });
});
