import { describe, expect, it } from "vitest";
import { ConfigError, assertUpstreamDestination, isPrivateAddress } from "../../src/config";
import { TEST_ADMIN_HASH, TEST_JWT_SECRET, testConfig } from "../helpers/runtime";

describe("parseConfig", () => {
  it("parses a valid configuration with defaults", () => {
    const config = testConfig({ PORT: undefined, MAX_REQUEST_BYTES: undefined });
    expect(config.port).toBe(8080);
    expect(config.maxRequestBytes).toBe(1024 * 1024);
    expect(config.env).toBe("test");
    expect(config.allowedMethods).toContain("GET");
    expect(config.upstreamUrl).toBe("http://127.0.0.1:4000");
  });

  it("rejects short JWT secrets", () => {
    expect(() => testConfig({ JWT_SECRET: "short" })).toThrow(ConfigError);
  });

  it("rejects placeholder secrets in production", () => {
    expect(() => testConfig({ NODE_ENV: "production", JWT_SECRET: "change-me-please-123456789012345678" })).toThrow(
      /placeholder/i,
    );
  });

  it("rejects a password that is not a bcrypt hash", () => {
    expect(() => testConfig({ ADMIN_PASSWORD_HASH: "plaintext" })).toThrow(/bcrypt/);
  });

  it("rejects viewer credentials configured without a username", () => {
    expect(() => testConfig({ VIEWER_USERNAME: undefined })).toThrow(/configured together/);
  });

  it("rejects upstream URLs with paths or credentials", () => {
    expect(() => testConfig({ UPSTREAM_URL: "https://example.com/api" })).toThrow(/path/);
    expect(() => testConfig({ UPSTREAM_URL: "https://user:pass@example.com" })).toThrow(
      /credentials/,
    );
  });

  it("requires the upstream host to be allowlisted", () => {
    expect(() =>
      testConfig({
        UPSTREAM_URL: "https://api.example.com",
        UPSTREAM_ALLOWED_HOSTS: "other.example.com",
      }),
    ).toThrow(/must include/);
  });

  it("validates the allowed methods list", () => {
    expect(() => testConfig({ ALLOWED_METHODS: "GET,FLY" })).toThrow(/Unsupported/);
    expect(testConfig({ ALLOWED_METHODS: "GET,POST" }).allowedMethods).toEqual(["GET", "POST"]);
  });

  it("validates integer ranges", () => {
    expect(() => testConfig({ UPSTREAM_TIMEOUT_MS: "10" })).toThrow(/between/);
    expect(() => testConfig({ REDIS_PREFIX: "!!!" })).toThrow(/empty/);
  });

  it("requires a real hash for the admin account", () => {
    expect(testConfig().adminPasswordHash).toBe(TEST_ADMIN_HASH);
    expect(testConfig().jwtSecret).toBe(TEST_JWT_SECRET);
  });
});

describe("isPrivateAddress", () => {
  it("classifies private and public addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertUpstreamDestination", () => {
  it("allows private targets only when explicitly enabled", async () => {
    await expect(
      assertUpstreamDestination(testConfig({ ALLOW_PRIVATE_UPSTREAMS: "false" })),
    ).rejects.toThrow(/private address/);
    await expect(
      assertUpstreamDestination(testConfig({ ALLOW_PRIVATE_UPSTREAMS: "true" })),
    ).resolves.toBeUndefined();
  });

  it("requires the configured hostname to stay in the allowlist", async () => {
    const config = testConfig({ ALLOW_PRIVATE_UPSTREAMS: "true" });
    const tampered = { ...config, upstreamAllowedHosts: ["example.com"] };
    await expect(assertUpstreamDestination(tampered)).rejects.toThrow(/allowlist|UPSTREAM/);
  });
});
