import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { buildUpstreamHeaders, sanitizeResponseHeaders } from "../../src/utils/headers";

function fakeRequest(headers: Record<string, string>, protocol = "http"): Request {
  return {
    headers,
    protocol,
  } as unknown as Request;
}

describe("buildUpstreamHeaders", () => {
  it("drops hop-by-hop, forwarding and gateway-private headers", () => {
    const headers = buildUpstreamHeaders(
      fakeRequest({
        host: "gateway.local",
        connection: "keep-alive",
        "content-length": "12",
        "transfer-encoding": "chunked",
        "x-forwarded-for": "1.2.3.4",
        forwarded: "for=1.2.3.4",
        "x-edgeguard-rule": "products",
        "x-custom": "kept",
        authorization: "Bearer user-token",
      }),
      "203.0.113.9",
      "req-123",
    );
    expect(headers["x-custom"]).toBe("kept");
    expect(headers.authorization).toBe("Bearer user-token");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-request-id"]).toBe("req-123");
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    expect(headers.forwarded).toBeUndefined();
    expect(headers["x-edgeguard-rule"]).toBeUndefined();
  });
});

describe("sanitizeResponseHeaders", () => {
  it("removes server, CORS and gateway-private headers", () => {
    const headers = sanitizeResponseHeaders({
      "content-type": "application/json",
      server: "nginx",
      "x-powered-by": "Express",
      "access-control-allow-origin": "*",
      "x-edgeguard-rule": "products",
      "content-length": "10",
      "set-cookie": ["a=1", "b=2"],
      "x-upstream": "demo",
    });
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(headers["x-upstream"]).toBe("demo");
    expect(headers.server).toBeUndefined();
    expect(headers["x-powered-by"]).toBeUndefined();
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["x-edgeguard-rule"]).toBeUndefined();
  });
});
