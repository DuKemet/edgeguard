import {
  DEFAULT_RULES,
  type RateLimitRule,
  type RulePatchInput,
  type RuleCreateInput,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import { ConflictError, NotFoundError, BadRequestError } from "../errors";
import type { Logger } from "../logger";
import type { RedisManager } from "../redis";

function parseRule(raw: string): RateLimitRule | null {
  try {
    const value = JSON.parse(raw) as Partial<RateLimitRule>;
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.endpoint !== "string" ||
      (value.match !== "exact" && value.match !== "prefix") ||
      typeof value.limit !== "number" ||
      typeof value.windowSeconds !== "number" ||
      typeof value.burst !== "number" ||
      typeof value.enabled !== "boolean" ||
      typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return value as RateLimitRule;
  } catch {
    return null;
  }
}

export class RulesService {
  private readonly redis: RedisManager;
  private readonly key: string;
  private readonly logger: Logger;
  private readonly memory = new Map<string, RateLimitRule>();

  constructor(redis: RedisManager, config: GatewayConfig, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
    this.key = `${config.redisPrefix}:rules`;
    const now = new Date().toISOString();
    for (const rule of DEFAULT_RULES) {
      this.memory.set(rule.id, { ...rule, updatedAt: now });
    }
  }

  async init(): Promise<void> {
    if (!this.redis.isReady()) return;
    try {
      await this.seedIfNeeded();
    } catch (error) {
      this.redis.reportError("rules_seed", error);
    }
  }

  private async seedIfNeeded(): Promise<void> {
    const size = await this.redis.client.hlen(this.key);
    if (size > 0) return;
    const now = new Date().toISOString();
    const pipeline = this.redis.client.pipeline();
    for (const rule of DEFAULT_RULES) {
      pipeline.hsetnx(this.key, rule.id, JSON.stringify({ ...rule, updatedAt: now }));
      this.memory.set(rule.id, { ...rule, updatedAt: now });
    }
    await pipeline.exec();
    this.logger.info({ rules: DEFAULT_RULES.length }, "seeded default rate-limit rules");
  }

  async list(): Promise<RateLimitRule[]> {
    if (!this.redis.isReady()) {
      return [...this.memory.values()].sort(sortRules);
    }
    try {
      await this.seedIfNeeded();
      const raw = await this.redis.client.hgetall(this.key);
      const rules: RateLimitRule[] = [];
      for (const value of Object.values(raw)) {
        const parsed = parseRule(value);
        if (parsed) rules.push(parsed);
        else this.logger.warn("discarding malformed rate-limit rule from redis");
      }
      this.memory.clear();
      for (const rule of rules) this.memory.set(rule.id, rule);
      return rules.sort(sortRules);
    } catch (error) {
      this.redis.reportError("rules_list", error);
      return [...this.memory.values()].sort(sortRules);
    }
  }

  async get(id: string): Promise<RateLimitRule | null> {
    const rules = await this.list();
    return rules.find((rule) => rule.id === id) ?? null;
  }

  async create(input: RuleCreateInput): Promise<RateLimitRule> {
    const rules = await this.list();
    if (rules.some((rule) => rule.id === input.id)) {
      throw new ConflictError(`Rule '${input.id}' already exists`);
    }
    if (rules.some((rule) => rule.endpoint === input.endpoint && rule.match === input.match)) {
      throw new ConflictError(`A rule already matches endpoint '${input.endpoint}'`);
    }
    const rule: RateLimitRule = { ...input, updatedAt: new Date().toISOString() };
    await this.persist(rule);
    return rule;
  }

  async update(id: string, patch: RulePatchInput): Promise<RateLimitRule> {
    const existing = await this.get(id);
    if (!existing) throw new NotFoundError(`Rule '${id}' not found`);
    if (id === "default") {
      if (patch.endpoint !== undefined || patch.match !== undefined) {
        throw new BadRequestError("The fallback rule endpoint and match type cannot be changed");
      }
      if (patch.enabled === false) {
        throw new BadRequestError("The fallback rule cannot be disabled");
      }
    }
    const updated: RateLimitRule = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    const rules = await this.list();
    if (
      rules.some(
        (rule) =>
          rule.id !== id &&
          rule.endpoint === updated.endpoint &&
          rule.match === updated.match,
      )
    ) {
      throw new ConflictError(`A rule already matches endpoint '${updated.endpoint}'`);
    }
    await this.persist(updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    if (id === "default") {
      throw new BadRequestError("The fallback rule cannot be deleted");
    }
    const existing = await this.get(id);
    if (!existing) throw new NotFoundError(`Rule '${id}' not found`);
    this.memory.delete(id);
    if (this.redis.isReady()) {
      try {
        await this.redis.client.hdel(this.key, id);
      } catch (error) {
        this.redis.reportError("rules_delete", error);
      }
    }
  }

  private async persist(rule: RateLimitRule): Promise<void> {
    this.memory.set(rule.id, rule);
    if (this.redis.isReady()) {
      try {
        await this.redis.client.hset(this.key, rule.id, JSON.stringify(rule));
      } catch (error) {
        this.redis.reportError("rules_write", error);
      }
    }
  }
}

function sortRules(a: RateLimitRule, b: RateLimitRule): number {
  if (a.endpoint === "*") return -1;
  if (b.endpoint === "*") return 1;
  return a.name.localeCompare(b.name);
}
