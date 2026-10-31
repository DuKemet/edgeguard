import {
  tokenBucketCheck,
  type RateLimitRule,
  type TokenBucketState,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { GatewayMetrics } from "../metrics";
import type { RedisManager } from "../redis";

export interface LimitDecision {
  allowed: boolean;
  limit: number;
  capacity: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
  degraded: boolean;
  key: string;
  rule: RateLimitRule;
}

const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local values = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(values[1])
local last = tonumber(values[2])
if tokens == nil then tokens = capacity end
if last == nil then last = now end
if last > now then last = now end
tokens = math.min(capacity, tokens + (now - last) * rate)
local allowed = 0
local retry = 0
local reset = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
  if tokens < 1 then reset = math.ceil((1 - tokens) / rate) end
else
  retry = math.ceil((1 - tokens) / rate)
  reset = retry
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, retry, reset, math.floor(tokens)}
`;

interface ScriptedRedis {
  egTokenBucket(
    key: string,
    capacity: number,
    ratePerMs: number,
    ttlMs: number,
  ): Promise<[number, number, number, number]>;
}

interface LocalEntry {
  state: TokenBucketState;
  lastUsedMs: number;
}

export class RateLimiter {
  private readonly redis: RedisManager;
  private readonly metrics: GatewayMetrics;
  private readonly logger: Logger;
  private readonly prefix: string;
  private readonly local = new Map<string, LocalEntry>();
  private scriptRegistered = false;

  constructor(
    redis: RedisManager,
    config: GatewayConfig,
    metrics: GatewayMetrics,
    logger: Logger,
  ) {
    this.redis = redis;
    this.metrics = metrics;
    this.logger = logger;
    this.prefix = `${config.redisPrefix}:rl:`;
  }

  keyFor(clientId: string, ruleId: string): string {
    return `${this.prefix}${clientId}:${ruleId}`;
  }

  async check(clientId: string, rule: RateLimitRule): Promise<LimitDecision> {
    const key = this.keyFor(clientId, rule.id);
    const capacity = rule.limit + rule.burst;
    const windowMs = rule.windowSeconds * 1_000;
    const ratePerMs = rule.limit / windowMs;
    const ttlMs = Math.max(2_000, windowMs * 3);

    if (this.redis.isReady()) {
      try {
        this.registerScript();
        const scripted = this.redis.client as unknown as ScriptedRedis;
        const result = await scripted.egTokenBucket(key, capacity, ratePerMs, ttlMs);
        const allowed = Number(result[0]) === 1;
        const retryAfterMs = Number(result[1]);
        const resetAfterMs = Number(result[2]);
        const remaining = Number(result[3]);
        return {
          allowed,
          limit: rule.limit,
          capacity,
          remaining: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
          retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
          resetAfterSeconds: Math.max(0, Math.ceil(resetAfterMs / 1000)),
          degraded: false,
          key,
          rule,
        };
      } catch (error) {
        this.redis.reportError("rate_limit", error);
      }
    }

    this.metrics.redisFallbacks.inc();
    const localKey = `${clientId}:${rule.id}`;
    const now = Date.now();
    const entry = this.local.get(localKey);
    const result = tokenBucketCheck(entry?.state, now, rule.limit, windowMs, rule.burst);
    this.local.set(localKey, { state: result.state, lastUsedMs: now });
    this.pruneLocal(now);
    return {
      allowed: result.allowed,
      limit: rule.limit,
      capacity: result.capacity,
      remaining: result.remaining,
      retryAfterSeconds: result.allowed ? 0 : Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
      resetAfterSeconds: Math.max(0, Math.ceil(result.resetAfterMs / 1000)),
      degraded: true,
      key: localKey,
      rule,
    };
  }

  private registerScript(): void {
    if (this.scriptRegistered) return;
    this.redis.client.defineCommand("egTokenBucket", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
    this.scriptRegistered = true;
  }

  private pruneLocal(now: number): void {
    if (this.local.size <= 5_000) return;
    for (const [key, value] of this.local) {
      if (now - value.lastUsedMs > 10 * 60 * 1000) this.local.delete(key);
    }
    let excess = this.local.size - 2_500;
    if (excess <= 0) return;
    for (const key of this.local.keys()) {
      if (excess <= 0) break;
      this.local.delete(key);
      excess -= 1;
    }
    this.logger.debug({ size: this.local.size }, "pruned local fallback limiter state");
  }
}
