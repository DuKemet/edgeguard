import { describe, expect, it } from "vitest";
import { AuthService, extractBearerToken } from "../../src/services/auth";
import {
  TEST_ADMIN_PASSWORD,
  TEST_VIEWER_PASSWORD,
  silentLogger,
  testConfig,
} from "../helpers/runtime";

describe("AuthService", () => {
  const service = new AuthService(testConfig(), silentLogger());

  it("verifies admin credentials with bcrypt", async () => {
    const admin = await service.verifyCredentials("admin", TEST_ADMIN_PASSWORD);
    expect(admin).toEqual({ username: "admin", role: "admin" });
    expect(await service.verifyCredentials("admin", "wrong-password")).toBeNull();
    expect(await service.verifyCredentials("nobody", "whatever-password")).toBeNull();
  });

  it("verifies viewer credentials", async () => {
    const viewer = await service.verifyCredentials("viewer", TEST_VIEWER_PASSWORD);
    expect(viewer).toEqual({ username: "viewer", role: "viewer" });
  });

  it("issues and verifies signed tokens", async () => {
    const user = await service.verifyCredentials("admin", TEST_ADMIN_PASSWORD);
    if (!user) throw new Error("admin login failed in test setup");
    const login = service.issueToken(user);
    expect(login.user).toEqual(user);
    expect(login.expiresAt).toBeTruthy();
    expect(service.verifyToken(login.token)).toEqual(user);
    expect(service.verifyToken("not-a-token")).toBeNull();
  });

  it("rejects tokens signed with another secret", async () => {
    const other = new AuthService(testConfig({ JWT_SECRET: "another-secret-with-at-least-32-characters" }), silentLogger());
    const user = await other.verifyCredentials("admin", TEST_ADMIN_PASSWORD);
    if (!user) throw new Error("admin login failed in test setup");
    const token = other.issueToken(user).token;
    expect(service.verifyToken(token)).toBeNull();
  });
});

describe("extractBearerToken", () => {
  it("accepts case-insensitive bearer schemes", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer abc")).toBe("abc");
  });

  it("rejects missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });
});
