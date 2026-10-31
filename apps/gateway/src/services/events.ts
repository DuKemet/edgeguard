import { randomUUID } from "node:crypto";
import {
  EVENT_RETENTION_SECONDS,
  type ActionTaken,
  type EventCategory,
  type EventsQueryInput,
  type ObservedUnit,
  type SecurityEvent,
  type Severity,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { GatewayMetrics } from "../metrics";
import type { RedisManager } from "../redis";

const SCAN_LIMIT = 5_000;
const MEMORY_LIMIT = 1_000;

export interface NewEventInput {
  category: EventCategory;
  severity: Severity;
  clientId: string | null;
  maskedIp: string | null;
  endpoint: string;
  method: string | null;
  observedValue: number;
  threshold: number;
  unit: ObservedUnit;
  action: ActionTaken;
  message: string;
  expiresAt?: string | null;
  requestId?: string | null;
  details?: Record<string, string | number | boolean> | null;
}

export class EventService {
  private readonly redis: RedisManager;
  private readonly metrics: GatewayMetrics;
  private readonly logger: Logger;
  private readonly key: string;
  private readonly memory: SecurityEvent[] = [];

  constructor(
    redis: RedisManager,
    config: GatewayConfig,
    metrics: GatewayMetrics,
    logger: Logger,
  ) {
    this.redis = redis;
    this.metrics = metrics;
    this.logger = logger;
    this.key = `${config.redisPrefix}:events`;
  }

  async create(input: NewEventInput): Promise<SecurityEvent> {
    const timestamp = new Date().toISOString();
    const event: SecurityEvent = {
      id: randomUUID(),
      timestamp,
      category: input.category,
      severity: input.severity,
      clientId: input.clientId,
      maskedIp: input.maskedIp,
      endpoint: input.endpoint,
      method: input.method,
      observedValue: round(input.observedValue),
      threshold: round(input.threshold),
      unit: input.unit,
      action: input.action,
      message: input.message,
      expiresAt: input.expiresAt ?? null,
      resolved: input.action === "client_unblocked",
      requestId: input.requestId ?? null,
      details: input.details ?? null,
    };

    this.memory.unshift(event);
    if (this.memory.length > MEMORY_LIMIT) this.memory.length = MEMORY_LIMIT;
    this.metrics.detectionEvents.inc({ category: event.category, severity: event.severity });

    if (this.redis.isReady()) {
      try {
        const score = new Date(timestamp).getTime();
        const pipeline = this.redis.client.pipeline();
        pipeline.zadd(this.key, score, JSON.stringify(event));
        pipeline.zremrangebyscore(
          this.key,
          "-inf",
          Date.now() - EVENT_RETENTION_SECONDS * 1_000,
        );
        pipeline.zremrangebyrank(this.key, 0, -10_001);
        pipeline.expire(this.key, EVENT_RETENTION_SECONDS);
        await pipeline.exec();
      } catch (error) {
        this.redis.reportError("event_write", error);
      }
    }

    this.logger.info(
      {
        eventId: event.id,
        category: event.category,
        severity: event.severity,
        clientId: event.clientId,
        endpoint: event.endpoint,
        observed: event.observedValue,
        threshold: event.threshold,
        action: event.action,
      },
      "security event recorded",
    );
    return event;
  }

  async list(query: EventsQueryInput): Promise<{
    items: SecurityEvent[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const now = Date.now();
    let candidates: SecurityEvent[] = [];

    if (this.redis.isReady()) {
      try {
        const max = query.until ? new Date(query.until).getTime() : now;
        const min = query.since ? new Date(query.since).getTime() : 0;
        const raw = await this.redis.client.zrevrangebyscore(
          this.key,
          max,
          min,
          "LIMIT",
          0,
          SCAN_LIMIT,
        );
        candidates = raw
          .map((value) => {
            try {
              return JSON.parse(value) as SecurityEvent;
            } catch {
              return null;
            }
          })
          .filter((value): value is SecurityEvent => value !== null);
      } catch (error) {
        this.redis.reportError("event_list", error);
      }
    }

    if (candidates.length === 0 && !this.redis.isReady()) {
      candidates = [...this.memory];
    }

    const search = query.q?.toLowerCase();
    const filtered = candidates
      .map((event) => deriveResolution(event, now))
      .filter((event) => {
        if (query.severity && event.severity !== query.severity) return false;
        if (query.category && event.category !== query.category) return false;
        if (query.clientId && event.clientId !== query.clientId) return false;
        if (query.endpoint && event.endpoint !== query.endpoint) return false;
        if (search) {
          const haystack = `${event.message} ${event.endpoint} ${event.clientId ?? ""} ${
            event.maskedIp ?? ""
          } ${event.category}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });

    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
    };
  }

  async countLastHour(): Promise<number> {
    if (this.redis.isReady()) {
      try {
        return await this.redis.client.zcount(this.key, Date.now() - 3_600_000, "+inf");
      } catch (error) {
        this.redis.reportError("event_count", error);
      }
    }
    const cutoff = Date.now() - 3_600_000;
    return this.memory.filter((event) => new Date(event.timestamp).getTime() >= cutoff).length;
  }
}

function deriveResolution(event: SecurityEvent, now: number): SecurityEvent {
  if (event.resolved) return event;
  if (
    event.action === "client_isolated" &&
    event.expiresAt &&
    new Date(event.expiresAt).getTime() <= now
  ) {
    return { ...event, resolved: true };
  }
  return event;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
