import type { GatewayConfig } from "../config";
import type { RedisManager } from "../redis";

interface LocalAttempt {
  count: number;
  resetAt: number;
}

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

export class LoginThrottle {
  private readonly redis: RedisManager;
  private readonly keyPrefix: string;
  private readonly local = new Map<string, LocalAttempt>();

  constructor(redis: RedisManager, config: GatewayConfig) {
    this.redis = redis;
    this.keyPrefix = `${config.redisPrefix}:login:`;
  }

  private key(clientId: string): string {
    return `${this.keyPrefix}${clientId}`;
  }

  async check(clientId: string): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    if (this.redis.isReady()) {
      try {
        const [raw, ttl] = await Promise.all([
          this.redis.client.get(this.key(clientId)),
          this.redis.client.ttl(this.key(clientId)),
        ]);
        const count = Number(raw ?? 0);
        if (count >= MAX_ATTEMPTS) {
          return { limited: true, retryAfterSeconds: Math.max(1, ttl > 0 ? ttl : WINDOW_SECONDS) };
        }
        return { limited: false, retryAfterSeconds: 0 };
      } catch {
        // Fall through to the local counter; a Redis outage must not lock out admins.
      }
    }
    const now = Date.now();
    const entry = this.local.get(clientId);
    if (!entry || entry.resetAt <= now) {
      this.local.delete(clientId);
      return { limited: false, retryAfterSeconds: 0 };
    }
    return {
      limited: entry.count >= MAX_ATTEMPTS,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  async recordFailure(clientId: string): Promise<void> {
    if (this.redis.isReady()) {
      try {
        const pipeline = this.redis.client.pipeline();
        pipeline.incr(this.key(clientId));
        pipeline.expire(this.key(clientId), WINDOW_SECONDS);
        await pipeline.exec();
        return;
      } catch {
        // Fall through to the local counter.
      }
    }
    const now = Date.now();
    const existing = this.local.get(clientId);
    if (!existing || existing.resetAt <= now) {
      this.local.set(clientId, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    } else {
      existing.count += 1;
    }
    if (this.local.size > 1_000) {
      for (const [key, value] of this.local) {
        if (value.resetAt <= now) this.local.delete(key);
      }
    }
  }

  async reset(clientId: string): Promise<void> {
    this.local.delete(clientId);
    if (this.redis.isReady()) {
      try {
        await this.redis.client.del(this.key(clientId));
      } catch {
        // Ignore; the counter expires automatically.
      }
    }
  }
}
