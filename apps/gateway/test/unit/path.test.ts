import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors";
import { validateProxyPath } from "../../src/utils/path";

const BASE = "http://127.0.0.1:4000";

describe("validateProxyPath", () => {
  it("accepts an absolute path and preserves the query string", () => {
    const result = validateProxyPath("/api/products?limit=10&sort=asc", 2_048, BASE);
    expect(result.pathname).toBe("/api/products");
    expect(result.url.toString()).toBe("http://127.0.0.1:4000/api/products?limit=10&sort=asc");
  });

  it("rejects relative and protocol-relative targets", () => {
    expect(() => validateProxyPath("api/products", 2_048, BASE)).toThrow(BadRequestError);
    expect(() => validateProxyPath("//evil.example.com/steal", 2_048, BASE)).toThrow(BadRequestError);
  });

  it("rejects fragments and control characters", () => {
    expect(() => validateProxyPath("/api/products#fragment", 2_048, BASE)).toThrow(/not allowed/);
    expect(() => validateProxyPath("/api/\u0000products", 2_048, BASE)).toThrow(/control/);
  });

  it("rejects encoded separators and path traversal", () => {
    expect(() => validateProxyPath("/api/%2e%2e/secret", 2_048, BASE)).toThrow(/traversal/);
    expect(() => validateProxyPath("/api/%252e%252e/secret", 2_048, BASE)).toThrow(/traversal/);
    expect(() => validateProxyPath("/api/%2fetc/passwd", 2_048, BASE)).toThrow(/separators/);
    expect(() => validateProxyPath("/api/..%5csecret", 2_048, BASE)).toThrow(
      /separators|traversal/,
    );
  });

  it("rejects repeated separators and overlong paths", () => {
    expect(() => validateProxyPath("/api//products", 2_048, BASE)).toThrow(/separators/);
    expect(() => validateProxyPath(`/api/${"a".repeat(100)}`, 64, BASE)).toThrow(/too long/);
  });

  it("rejects invalid percent-encoding", () => {
    expect(() => validateProxyPath("/api/%zz", 2_048, BASE)).toThrow(/encoding/);
  });

  it("rejects targets that change the upstream origin", () => {
    expect(() => validateProxyPath("/api/products", 2_048, "http://127.0.0.1:4000")).not.toThrow();
    expect(() =>
      validateProxyPath("/\\\\evil.example.com/path", 2_048, BASE),
    ).toThrow(BadRequestError);
  });
});
