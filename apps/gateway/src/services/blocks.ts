import type { ActiveBlock, EventCategory } from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { GatewayMetrics } from "../metrics";
import type { RedisManager } from "../redis";

interface StoredBlock {
  clientId: string;
  maskedIp: string;
  reason: string;
  category: EventCategory | "manual";
  blockedAt: string;
  expiresAt: string;
  expiresAtMs: number;
}

export class BlockService {
  private readonly redis: RedisManager;
  private readonly metrics: GatewayMetrics;
  private readonly logger: Logger;
  private readonly blockPrefix: string;
  private readonly blocksKey: string;
  private readonly memory = new Map<string, StoredBlock>();

  constructor(
    redis: RedisManager,
    config: GatewayConfig,
    metrics: GatewayMetrics,
    logger: Logger,
  ) {
    this.redis = redis;
    this.metrics = metrics;
    this.logger = logger;
    this.blockPrefix = `${config.redisPrefix}:block:`;
    this.blocksKey = `${config.redisPrefix}:blocks`;
  }

  private key(clientId: string): string {
    return `${this.blockPrefix}${clientId}`;
  }

  async block(input: {
    clientId: string;
    maskedIp: string;
    reason: string;
    category: EventCategory | "manual";
    seconds: number;
  }): Promise<ActiveBlock> {
    const now = Date.now();
    const seconds = Math.max(1, Math.floor(input.seconds));
    const stored: StoredBlock = {
      clientId: input.clientId,
      maskedIp: input.maskedIp,
      reason: input.reason,
      category: input.category,
      blockedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + seconds * 1000).toISOString(),
      expiresAtMs: now + seconds * 1000,
    };
    this.memory.set(input.clientId, stored);

    if (this.redis.isReady()) {
      try {
        const pipeline = this.redis.client.pipeline();
        pipeline.set(this.key(input.clientId), JSON.stringify(stored), "EX", seconds);
        pipeline.zadd(this.blocksKey, stored.expiresAtMs, input.clientId);
        pipeline.pexpire(this.blocksKey, 7 * 24 * 60 * 60 * 1000);
        await pipeline.exec();
      } catch (error) {
        this.redis.reportError("block_write", error);
      }
    }

    this.logger.warn(
      {
        clientId: input.clientId,
        maskedIp: input.maskedIp,
        category: input.category,
        seconds,
      },
      "client temporarily isolated",
    );
    void this.refreshGauge();
    return toActive(stored, now);
  }

  async isBlocked(clientId: string): Promise<ActiveBlock | null> {
    const now = Date.now();
    const memoryBlock = this.memory.get(clientId);
    if (memoryBlock && memoryBlock.expiresAtMs > now) {
      return toActive(memoryBlock, now);
    }
    if (memoryBlock) this.memory.delete(clientId);

    if (!this.redis.isReady()) return null;
    try {
      const raw = await this.redis.client.get(this.key(clientId));
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredBlock;
      const active = toActive(stored, now);
      if (active.remainingSeconds <= 0) return null;
      this.memory.set(clientId, stored);
      return active;
    } catch (error) {
      this.redis.reportError("block_read", error);
      return null;
    }
  }

  async listActive(): Promise<ActiveBlock[]> {
    const now = Date.now();
    const fromMemory = [...this.memory.values()]
      .filter((block) => block.expiresAtMs > now)
      .map((block) => toActive(block, now));

    if (!this.redis.isReady()) {
      this.metrics.setActiveBlocks(fromMemory.length);
      return fromMemory.sort(sortBlocks);
    }

    try {
      const ids = await this.redis.client.zrangebyscore(
        this.blocksKey,
        now,
        "+inf",
        "LIMIT",
        0,
        1_000,
      );
      if (ids.length === 0) {
        await this.redis.client.zremrangebyscore(this.blocksKey, "-inf", now);
        this.metrics.setActiveBlocks(0);
        return [];
      }
      const pipeline = this.redis.client.pipeline();
      for (const id of ids) pipeline.get(this.key(id));
      const results = await pipeline.exec();
      const blocks: ActiveBlock[] = [];
      const stale: string[] = [];
      results?.forEach((entry, index) => {
        const id = ids[index];
        if (!id) return;
        const value = entry?.[1];
        if (typeof value !== "string") {
          stale.push(id);
          return;
        }
        try {
          const stored = JSON.parse(value) as StoredBlock;
          const active = toActive(stored, now);
          if (active.remainingSeconds > 0) {
            blocks.push(active);
            this.memory.set(id, stored);
          } else {
            stale.push(id);
          }
        } catch {
          stale.push(id);
        }
      });
      const cleanup = this.redis.client.pipeline();
      cleanup.zremrangebyscore(this.blocksKey, "-inf", now);
      for (const id of stale) cleanup.zrem(this.blocksKey, id);
      await cleanup.exec();

      this.metrics.setActiveBlocks(blocks.length);
      return blocks.sort(sortBlocks);
    } catch (error) {
      this.redis.reportError("block_list", error);
      this.metrics.setActiveBlocks(fromMemory.length);
      return fromMemory.sort(sortBlocks);
    }
  }

  async unblock(clientId: string): Promise<boolean> {
    const existed = this.memory.delete(clientId);
    if (this.redis.isReady()) {
      try {
        const removed = await this.redis.client.del(this.key(clientId));
        await this.redis.client.zrem(this.blocksKey, clientId);
        void this.refreshGauge();
        return existed || removed > 0;
      } catch (error) {
        this.redis.reportError("block_delete", error);
        void this.refreshGauge();
        return existed;
      }
    }
    void this.refreshGauge();
    return existed;
  }

  async refreshGauge(): Promise<void> {
    await this.listActive();
  }
}

function toActive(block: StoredBlock, now: number): ActiveBlock {
  return {
    clientId: block.clientId,
    maskedIp: block.maskedIp,
    reason: block.reason,
    category: block.category,
    blockedAt: block.blockedAt,
    expiresAt: block.expiresAt,
    remainingSeconds: Math.max(0, Math.ceil((block.expiresAtMs - now) / 1000)),
  };
}

function sortBlocks(a: ActiveBlock, b: ActiveBlock): number {
  return b.remainingSeconds - a.remainingSeconds;
}
