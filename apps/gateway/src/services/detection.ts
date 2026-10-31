import {
  DETECTION_BUCKET_SECONDS,
  severityFromRatio,
  type ActiveBlock,
  type EventCategory,
  type RateLimitRule,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { RedisManager } from "../redis";
import type { BlockService } from "./blocks";
import type { EventService, NewEventInput } from "./events";
import type { SettingsService } from "./settings";

export interface ObserveRequestInput {
  clientId: string;
  maskedIp: string;
  endpoint: string;
  path: string;
  method: string;
  requestId: string;
}

export interface ViolationInput {
  clientId: string;
  maskedIp: string;
  endpoint: string;
  method: string;
  requestId: string;
  rule: RateLimitRule;
}

export interface ViolationResult {
  isolated: boolean;
  block: ActiveBlock | null;
}

const BUCKET_SECONDS = DETECTION_BUCKET_SECONDS;

export class DetectionService {
  private readonly redis: RedisManager;
  private readonly settings: SettingsService;
  private readonly blocks: BlockService;
  private readonly events: EventService;
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(
    redis: RedisManager,
    config: GatewayConfig,
    settings: SettingsService,
    blocks: BlockService,
    events: EventService,
    logger: Logger,
  ) {
    this.redis = redis;
    this.settings = settings;
    this.blocks = blocks;
    this.events = events;
    this.logger = logger;
    this.prefix = config.redisPrefix;
  }

  private bucket(now = Date.now()): number {
    return Math.floor(now / (BUCKET_SECONDS * 1_000)) * BUCKET_SECONDS;
  }

  private detectionKey(kind: string, suffix: string, bucket: number): string {
    return `${this.prefix}:det:${kind}${suffix ? `:${suffix}` : ""}:${bucket}`;
  }

  private counterKeys(kind: string, suffix: string, windowSeconds: number, now = Date.now()): string[] {
    const current = this.bucket(now);
    const count = Math.max(1, Math.ceil(windowSeconds / BUCKET_SECONDS));
    return Array.from({ length: count }, (_, index) =>
      this.detectionKey(kind, suffix, current - (count - 1 - index) * BUCKET_SECONDS),
    );
  }

  private previousKeys(kind: string, suffix: string, windowSeconds: number, now = Date.now()): string[] {
    const current = this.bucket(now);
    const count = Math.max(1, Math.ceil(windowSeconds / BUCKET_SECONDS));
    return Array.from({ length: count }, (_, index) =>
      this.detectionKey(
        kind,
        suffix,
        current - count * BUCKET_SECONDS - (count - 1 - index) * BUCKET_SECONDS,
      ),
    );
  }

  private ttlSeconds(windowSeconds: number): number {
    return Math.max(60, windowSeconds * 3 + 60);
  }

  private async increment(keys: string[], ttlSeconds: number): Promise<void> {
    const pipeline = this.redis.client.pipeline();
    for (const key of keys) {
      pipeline.incr(key);
      pipeline.expire(key, ttlSeconds);
    }
    await pipeline.exec();
  }

  async observeRequest(input: ObserveRequestInput): Promise<void> {
    if (!this.redis.isReady()) return;
    const settings = await this.settings.get();
    if (!settings.detection.enabled) return;
    const detection = settings.detection;
    const now = Date.now();
    const bucket = this.bucket(now);
    const ttl = this.ttlSeconds(detection.windowSeconds);

    try {
      await this.increment(
        [
          `${this.prefix}:det:global:${bucket}`,
          `${this.prefix}:det:cli:${input.clientId}:${bucket}`,
          `${this.prefix}:det:ep:${input.endpoint}:${bucket}`,
        ],
        ttl,
      );

      const clientKeys = this.counterKeys("cli", input.clientId, detection.windowSeconds, now);
      const endpointKeys = this.counterKeys("ep", input.endpoint, detection.windowSeconds, now);
      const globalKeys = this.counterKeys("global", "", detection.windowSeconds, now);
      const previousKeys = this.previousKeys("global", "", detection.windowSeconds, now);

      const values = await this.redis.client.mget(
        ...clientKeys,
        ...endpointKeys,
        ...globalKeys,
        ...previousKeys,
      );
      const clientCount = sumSlice(values, 0, clientKeys.length);
      const endpointCount = sumSlice(values, clientKeys.length, endpointKeys.length);
      const globalCount = sumSlice(
        values,
        clientKeys.length + endpointKeys.length,
        globalKeys.length,
      );
      const previousCount = sumSlice(
        values,
        clientKeys.length + endpointKeys.length + globalKeys.length,
        previousKeys.length,
      );

      const clientRps = clientCount / detection.windowSeconds;
      const endpointRps = endpointCount / detection.windowSeconds;
      const globalRps = globalCount / detection.windowSeconds;
      const previousRps = previousCount / detection.windowSeconds;

      if (clientRps >= detection.clientRpsThreshold) {
        await this.emitIfNotSuppressed(
          "high_client_rate",
          input.clientId,
          {
            category: "high_client_rate",
            severity: severityFromRatio(clientRps, detection.clientRpsThreshold),
            clientId: input.clientId,
            maskedIp: input.maskedIp,
            endpoint: input.endpoint,
            method: input.method,
            observedValue: round(clientRps),
            threshold: detection.clientRpsThreshold,
            unit: "req/s",
            action: "none",
            message: `Client ${input.maskedIp} is sending ${round(clientRps)} req/s, above the ${detection.clientRpsThreshold} req/s threshold.`,
            requestId: input.requestId,
            details: { windowSeconds: detection.windowSeconds, path: input.path },
          },
          { suppressionSeconds: detection.suppressionSeconds },
        );
      }

      if (endpointRps >= detection.endpointRpsThreshold) {
        await this.emitIfNotSuppressed(
          "endpoint_flood",
          input.endpoint,
          {
            category: "endpoint_flood",
            severity: severityFromRatio(endpointRps, detection.endpointRpsThreshold),
            clientId: input.clientId,
            maskedIp: input.maskedIp,
            endpoint: input.endpoint,
            method: input.method,
            observedValue: round(endpointRps),
            threshold: detection.endpointRpsThreshold,
            unit: "req/s",
            action: "none",
            message: `Endpoint ${input.endpoint} is receiving ${round(endpointRps)} req/s, above the ${detection.endpointRpsThreshold} req/s threshold.`,
            requestId: input.requestId,
            details: { windowSeconds: detection.windowSeconds },
          },
          { suppressionSeconds: detection.suppressionSeconds },
        );
      }

      const baseline = Math.max(previousRps, 1);
      const spikeRatio = globalRps / baseline;
      if (
        globalRps >= detection.trafficSpikeMinRps &&
        spikeRatio >= detection.trafficSpikeMultiplier
      ) {
        await this.emitIfNotSuppressed(
          "traffic_spike",
          "platform",
          {
            category: "traffic_spike",
            severity: severityFromRatio(spikeRatio, detection.trafficSpikeMultiplier),
            clientId: null,
            maskedIp: null,
            endpoint: input.endpoint,
            method: null,
            observedValue: round(globalRps),
            threshold: round(
              Math.max(detection.trafficSpikeMinRps, previousRps * detection.trafficSpikeMultiplier),
            ),
            unit: "req/s",
            action: "none",
            message: `Platform traffic is ${round(globalRps)} req/s (${round(spikeRatio, 2)}x the previous window).`,
            requestId: input.requestId,
            details: {
              previousRps: round(previousRps),
              multiplier: detection.trafficSpikeMultiplier,
              minRps: detection.trafficSpikeMinRps,
            },
          },
          { suppressionSeconds: detection.suppressionSeconds },
        );
      }
    } catch (error) {
      this.redis.reportError("detection_observe", error);
    }
  }

  async recordViolation(input: ViolationInput): Promise<ViolationResult> {
    if (!this.redis.isReady()) return { isolated: false, block: null };
    const settings = await this.settings.get();
    if (!settings.detection.enabled) return { isolated: false, block: null };
    const detection = settings.detection;

    try {
      const key = `${this.prefix}:det:viol:${input.clientId}`;
      const pipeline = this.redis.client.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, detection.violationWindowSeconds);
      const result = await pipeline.exec();
      const count = Number(result?.[0]?.[1] ?? 0);

      if (count < detection.violationThreshold) {
        return { isolated: false, block: null };
      }

      const allowed = await this.claimEvent("rate_limit_violation", input.clientId, detection.suppressionSeconds);
      if (!allowed) return { isolated: false, block: null };

      let block: ActiveBlock | null = null;
      if (detection.autoIsolate) {
        block = await this.blocks.block({
          clientId: input.clientId,
          maskedIp: input.maskedIp,
          reason: `Repeated rate-limit violations on ${input.rule.id}`,
          category: "rate_limit_violation",
          seconds: detection.isolationSeconds,
        });
      }

      await this.events.create({
        category: "rate_limit_violation",
        severity: severityFromRatio(count, detection.violationThreshold),
        clientId: input.clientId,
        maskedIp: input.maskedIp,
        endpoint: input.endpoint,
        method: input.method,
        observedValue: count,
        threshold: detection.violationThreshold,
        unit: "requests",
        action: block ? "client_isolated" : "rate_limited",
        message: `Client ${input.maskedIp} exceeded the rate limit ${count} times within ${detection.violationWindowSeconds}s.`,
        expiresAt: block?.expiresAt ?? null,
        requestId: input.requestId,
        details: {
          ruleId: input.rule.id,
          ruleLimit: input.rule.limit,
          windowSeconds: input.rule.windowSeconds,
          isolationSeconds: block ? detection.isolationSeconds : 0,
        },
      });

      return { isolated: block !== null, block };
    } catch (error) {
      this.redis.reportError("detection_violation", error);
      return { isolated: false, block: null };
    }
  }

  async recordCooldownRequest(input: {
    clientId: string;
    maskedIp: string;
    endpoint: string;
    method: string;
    requestId: string;
    block: ActiveBlock;
  }): Promise<void> {
    if (!this.redis.isReady()) return;
    const settings = await this.settings.get();
    if (!settings.detection.enabled) return;
    const detection = settings.detection;

    try {
      const key = `${this.prefix}:det:cool:${input.clientId}`;
      const pipeline = this.redis.client.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, Math.max(input.block.remainingSeconds + 5, 10));
      const result = await pipeline.exec();
      const count = Number(result?.[0]?.[1] ?? 0);
      if (count < detection.cooldownAbuseThreshold) return;

      const allowed = await this.claimEvent("cooldown_abuse", input.clientId, detection.suppressionSeconds);
      if (!allowed) return;

      await this.events.create({
        category: "cooldown_abuse",
        severity: severityFromRatio(count, detection.cooldownAbuseThreshold),
        clientId: input.clientId,
        maskedIp: input.maskedIp,
        endpoint: input.endpoint,
        method: input.method,
        observedValue: count,
        threshold: detection.cooldownAbuseThreshold,
        unit: "requests",
        action: "rate_limited",
        message: `Isolated client ${input.maskedIp} sent ${count} requests during its cooldown period.`,
        expiresAt: input.block.expiresAt,
        requestId: input.requestId,
        details: { remainingSeconds: input.block.remainingSeconds },
      });
    } catch (error) {
      this.redis.reportError("detection_cooldown", error);
    }
  }

  async recordUpstreamResult(input: {
    endpoint: string;
    ok: boolean;
    requestId: string;
  }): Promise<void> {
    if (!this.redis.isReady()) return;
    const settings = await this.settings.get();
    if (!settings.detection.enabled) return;
    const detection = settings.detection;
    const now = Date.now();
    const bucket = this.bucket(now);
    const ttl = this.ttlSeconds(detection.windowSeconds);
    const kind = input.ok ? "upok" : "uperr";

    try {
      await this.increment([`${this.prefix}:det:${kind}:${input.endpoint}:${bucket}`], ttl);
      const okKeys = this.counterKeys("upok", input.endpoint, detection.windowSeconds, now);
      const errKeys = this.counterKeys("uperr", input.endpoint, detection.windowSeconds, now);
      const values = await this.redis.client.mget(...okKeys, ...errKeys);
      const ok = sumSlice(values, 0, okKeys.length);
      const errors = sumSlice(values, okKeys.length, errKeys.length);
      const total = ok + errors;
      if (total < detection.upstreamMinSamples) return;
      const ratio = errors / total;
      if (ratio < detection.upstreamErrorRateThreshold) return;

      const allowed = await this.claimEvent("upstream_error_spike", input.endpoint, detection.suppressionSeconds);
      if (!allowed) return;

      await this.events.create({
        category: "upstream_error_spike",
        severity: severityFromRatio(ratio, detection.upstreamErrorRateThreshold),
        clientId: null,
        maskedIp: null,
        endpoint: input.endpoint,
        method: null,
        observedValue: round(ratio * 100) / 100,
        threshold: detection.upstreamErrorRateThreshold,
        unit: "ratio",
        action: "none",
        message: `Upstream error rate for ${input.endpoint} reached ${round(ratio * 100)}% across ${total} samples.`,
        requestId: input.requestId,
        details: {
          samples: total,
          errors,
          windowSeconds: detection.windowSeconds,
          minSamples: detection.upstreamMinSamples,
        },
      });
    } catch (error) {
      this.redis.reportError("detection_upstream", error);
    }
  }

  private async emitIfNotSuppressed(
    category: EventCategory,
    target: string,
    event: NewEventInput,
    options: { suppressionSeconds: number },
  ): Promise<void> {
    const allowed = await this.claimEvent(category, target, options.suppressionSeconds);
    if (!allowed) return;
    await this.events.create(event);
  }

  private async claimEvent(
    category: EventCategory,
    target: string,
    suppressionSeconds: number,
  ): Promise<boolean> {
    const key = `${this.prefix}:det:suppress:${category}:${target}`;
    try {
      const result = await this.redis.client.set(key, "1", "EX", suppressionSeconds, "NX");
      return result === "OK";
    } catch (error) {
      this.redis.reportError("detection_suppression", error);
      return false;
    }
  }
}

function sumSlice(values: (string | null)[], offset: number, length: number): number {
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const value = Number(values[offset + index] ?? 0);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
