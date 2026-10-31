import { LATENCY_HISTOGRAM_BOUNDS_MS } from "./constants";
import type { RateLimitRule, Severity } from "./types";

/**
 * Chooses the most specific enabled rule for a path. Exact rules win over
 * prefix rules; longer prefixes win over shorter ones; "*" is the fallback.
 */
export function matchRateLimitRule(
  rules: readonly RateLimitRule[],
  pathname: string,
): RateLimitRule | undefined {
  const enabled = rules.filter((rule) => rule.enabled);
  const exact = enabled.find(
    (rule) => rule.match === "exact" && rule.endpoint !== "*" && rule.endpoint === pathname,
  );
  if (exact) return exact;

  const prefixes = enabled
    .filter(
      (rule) =>
        rule.match === "prefix" &&
        rule.endpoint !== "*" &&
        (pathname === rule.endpoint || pathname.startsWith(`${rule.endpoint}/`)),
    )
    .sort((a, b) => b.endpoint.length - a.endpoint.length);
  if (prefixes[0]) return prefixes[0];

  return enabled.find((rule) => rule.endpoint === "*");
}

/** Bounded endpoint label used by analytics and Prometheus. */
export function normalizeEndpoint(
  rules: readonly RateLimitRule[],
  pathname: string,
): string {
  const rule = matchRateLimitRule(rules, pathname);
  return rule && rule.endpoint !== "*" ? rule.endpoint : "other";
}

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  state: TokenBucketState;
  remaining: number;
  retryAfterMs: number;
  /** Milliseconds until at least one token is available. */
  resetAfterMs: number;
  capacity: number;
}

/**
 * Pure token-bucket implementation used by the degraded in-process limiter and
 * by deterministic unit tests. The Redis Lua script implements the same math
 * atomically and uses Redis server time.
 */
export function tokenBucketCheck(
  state: TokenBucketState | undefined,
  nowMs: number,
  limit: number,
  windowMs: number,
  burst: number,
): TokenBucketResult {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindow = Math.max(1, Math.floor(windowMs));
  const safeBurst = Math.max(0, Math.floor(burst));
  const capacity = safeLimit + safeBurst;
  const ratePerMs = safeLimit / safeWindow;

  const previous = state
    ? {
        tokens: Math.min(capacity, Math.max(0, state.tokens)),
        lastRefillMs: Math.min(nowMs, state.lastRefillMs),
      }
    : { tokens: capacity, lastRefillMs: nowMs };

  const elapsed = Math.max(0, nowMs - previous.lastRefillMs);
  const refilled = Math.min(capacity, previous.tokens + elapsed * ratePerMs);

  if (refilled >= 1) {
    const tokens = refilled - 1;
    return {
      allowed: true,
      state: { tokens, lastRefillMs: nowMs },
      remaining: Math.floor(tokens),
      retryAfterMs: 0,
      resetAfterMs: tokens < 1 ? Math.ceil((1 - tokens) / ratePerMs) : 0,
      capacity,
    };
  }

  return {
    allowed: false,
    state: { tokens: refilled, lastRefillMs: nowMs },
    remaining: 0,
    retryAfterMs: Math.max(1, Math.ceil((1 - refilled) / ratePerMs)),
    resetAfterMs: Math.max(1, Math.ceil((1 - refilled) / ratePerMs)),
    capacity,
  };
}

/**
 * Returns an approximate percentile from cumulative bucket bounds. Bucket
 * values are bucket upper bounds, which is precise enough for SLO monitoring
 * and avoids storing every request timestamp in Redis.
 */
export function percentileFromHistogram(
  counts: readonly number[],
  bounds: readonly number[],
  percentile: number,
  total?: number,
): number {
  const sum = total ?? counts.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= 0) return 0;
  const target = sum * Math.min(1, Math.max(0, percentile));
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    cumulative += Math.max(0, counts[index] ?? 0);
    if (cumulative >= target) {
      return bounds[index] ?? bounds[bounds.length - 1] ?? 0;
    }
  }
  return bounds[bounds.length - 1] ?? 0;
}

export function severityFromRatio(value: number, threshold: number): Severity {
  if (threshold <= 0) return "medium";
  const ratio = value / threshold;
  if (ratio >= 4) return "critical";
  if (ratio >= 2) return "high";
  if (ratio >= 1.25) return "medium";
  return "low";
}

/** Masks IPv4 and IPv6 addresses for display. Never used as a metric label. */
export function maskIp(ip: string): string {
  const normalized = ip.trim();
  if (normalized.includes(".") && !normalized.includes(":")) {
    const parts = normalized.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1") return "ipv6:xxxx";
    const groups = normalized.split(":").filter(Boolean);
    if (groups.length === 0) return "ipv6:xxxx";
    return `${groups.slice(0, 2).join(":")}::xxxx`;
  }
  return normalized.length > 10 ? `${normalized.slice(0, 10)}…` : "unknown";
}

export interface LatencyAggregate {
  sumMs: number;
  count: number;
  histogram: number[];
}

export function aggregateLatency(aggregates: readonly LatencyAggregate[]): {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  count: number;
} {
  let sum = 0;
  let count = 0;
  const histogram: number[] = [];
  for (const aggregate of aggregates) {
    sum += aggregate.sumMs;
    count += aggregate.count;
    aggregate.histogram.forEach((value, index) => {
      histogram[index] = (histogram[index] ?? 0) + value;
    });
  }
  return {
    avgMs: count > 0 ? round(sum / count) : 0,
    p50Ms: round(percentileFromHistogram(histogram, LATENCY_HISTOGRAM_BOUNDS_MS, 0.5, count)),
    p95Ms: round(percentileFromHistogram(histogram, LATENCY_HISTOGRAM_BOUNDS_MS, 0.95, count)),
    p99Ms: round(percentileFromHistogram(histogram, LATENCY_HISTOGRAM_BOUNDS_MS, 0.99, count)),
    count,
  };
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
