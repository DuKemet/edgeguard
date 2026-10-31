import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { clientIdForAddress, identifyClient, normalizeAddress } from "../../src/utils/client";
import { testConfig } from "../helpers/runtime";

function fakeRequest(ip: string | undefined, remoteAddress?: string): Request {
  return {
    ip,
    socket: { remoteAddress },
  } as unknown as Request;
}

describe("client identity", () => {
  it("normalizes IPv4-mapped IPv6 addresses", () => {
    expect(normalizeAddress(" ::ffff:203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeAddress("203.0.113.7")).toBe("203.0.113.7");
  });

  it("hashes client ids with the configured secret", () => {
    const first = clientIdForAddress("203.0.113.7", "secret-one");
    const second = clientIdForAddress("203.0.113.7", "secret-one");
    const third = clientIdForAddress("203.0.113.7", "secret-two");
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  it("masks addresses for display and keeps the raw address only for forwarding", () => {
    const config = testConfig();
    const identity = identifyClient(fakeRequest("203.0.113.42", "203.0.113.42"), config);
    expect(identity.address).toBe("203.0.113.42");
    expect(identity.maskedIp).toBe("203.0.113.xxx");
    expect(identity.clientId).toBe(clientIdForAddress("203.0.113.42", config.clientHashSecret));
  });

  it("falls back to the socket address when no resolved ip is available", () => {
    const config = testConfig();
    const identity = identifyClient(fakeRequest(undefined, "::1"), config);
    expect(identity.address).toBe("::1");
  });
});
