import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  maskIp,
  matchRateLimitRule,
  percentileFromHistogram,
  severityFromRatio,
  tokenBucketCheck,
} from "../src/index";
import type { RateLimitRule } from "../src/index";

const rules: RateLimitRule[] = DEFAULT_RULES.map((rule) => ({
  ...rule,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

describe("matchRateLimitRule", () => {
  it("prefers exact rules over prefix rules", () => {
    const withExact = [
      ...rules,
      {
        id: "products-exact",
        name: "Products exact",
        endpoint: "/api/products/special",
        match: "exact" as const,
        limit: 1,
        windowSeconds: 10,
        burst: 0,
        enabled: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(matchRateLimitRule(withExact, "/api/products/special")?.id).toBe("products-exact");
    expect(matchRateLimitRule(withExact, "/api/products/42")?.id).toBe("products");
  });

  it("falls back to the global rule for unknown paths", () => {
    expect(matchRateLimitRule(rules, "/unknown/path")?.id).toBe("default");
  });

  it("requires a path boundary for prefix matches", () => {
    expect(matchRateLimitRule(rules, "/api/products-extra")?.id).toBe("default");
  });

  it("ignores disabled rules", () => {
    const disabled = rules.map((rule) =>
      rule.id === "products" ? { ...rule, enabled: false } : rule,
    );
    expect(matchRateLimitRule(disabled, "/api/products")?.id).toBe("default");
  });
});

describe("tokenBucketCheck", () => {
  const limit = 10;
  const windowMs = 10_000;
  const burst = 5;

  it("allows capacity requests at t0 then rejects", () => {
    let state = undefined;
    const now = 1_000_000;
    for (let index = 0; index < limit + burst; index += 1) {
      const result = tokenBucketCheck(state, now, limit, windowMs, burst);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    const rejected = tokenBucketCheck(state, now, limit, windowMs, burst);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills deterministically with a fake clock", () => {
    let result = tokenBucketCheck(undefined, 0, 10, 10_000, 0);
    for (let index = 0; index < 9; index += 1) {
      result = tokenBucketCheck(result.state, 0, 10, 10_000, 0);
    }
    expect(result.allowed).toBe(true);
    const exhausted = tokenBucketCheck(result.state, 0, 10, 10_000, 0);
    expect(exhausted.allowed).toBe(false);

    const afterOneSecond = tokenBucketCheck(exhausted.state, 1_000, 10, 10_000, 0);
    expect(afterOneSecond.allowed).toBe(true);
    expect(afterOneSecond.remaining).toBe(0);
  });

  it("never exceeds burst capacity after a long idle period", () => {
    const initial = tokenBucketCheck(undefined, 0, 10, 10_000, 2);
    const later = tokenBucketCheck(
      { tokens: initial.state.tokens, lastRefillMs: 0 },
      60_000,
      10,
      10_000,
      2,
    );
    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(11);
  });
});

describe("percentileFromHistogram", () => {
  it("returns approximate bucket bounds", () => {
    const counts = [1, 4, 5, 0]; // total 10
    const bounds = [10, 25, 50, 100];
    expect(percentileFromHistogram(counts, bounds, 0.5)).toBe(25);
    expect(percentileFromHistogram(counts, bounds, 0.95)).toBe(50);
    expect(percentileFromHistogram(counts, bounds, 0.99)).toBe(50);
    expect(percentileFromHistogram([], bounds, 0.95)).toBe(0);
  });
});

describe("severityFromRatio", () => {
  it("maps ratios to explainable severities", () => {
    expect(severityFromRatio(10, 10)).toBe("low");
    expect(severityFromRatio(15, 10)).toBe("medium");
    expect(severityFromRatio(25, 10)).toBe("high");
    expect(severityFromRatio(50, 10)).toBe("critical");
  });
});

describe("maskIp", () => {
  it("masks IPv4 and IPv6 addresses", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.xxx");
    expect(maskIp("2001:db8:1234::1")).toBe("2001:db8::xxxx");
    expect(maskIp("::1")).toBe("ipv6:xxxx");
  });
});
