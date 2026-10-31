import {
  LATENCY_HISTOGRAM_BOUNDS_MS,
  STATS_BUCKET_SECONDS,
  STATS_RETENTION_SECONDS,
  aggregateLatency,
  type ClientSummary,
  type EndpointStats,
  type StatusCount,
  type TrafficBucket,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { Logger } from "../logger";
import type { RedisManager } from "../redis";

export interface RecordOutcomeInput {
  clientId: string;
  maskedIp: string;
  endpoint: string;
  status: number;
  decision: "allowed" | "blocked" | "error";
  latencyMs: number;
  violation: boolean;
  upstreamError: boolean;
  timestamp?: number;
}

interface EndpointAggregate {
  requests: number;
  allowed: number;
  blocked: number;
  durationSum: number;
  durationCount: number;
}

interface ClientAggregate {
  requests: number;
  blocked: number;
  violations: number;
}

interface BucketAggregate {
  start: number;
  requests: number;
  allowed: number;
  blocked: number;
  violations: number;
  upstreamErrors: number;
  durationSum: number;
  durationCount: number;
  histogram: number[];
  statuses: Map<number, number>;
  endpoints: Map<string, EndpointAggregate>;
  clients: Map<string, ClientAggregate>;
}

interface ClientMeta {
  maskedIp: string;
  lastSeen: string | null;
}

const BUCKET_MS = STATS_BUCKET_SECONDS * 1_000;

function emptyBucket(start: number): BucketAggregate {
  return {
    start,
    requests: 0,
    allowed: 0,
    blocked: 0,
    violations: 0,
    upstreamErrors: 0,
    durationSum: 0,
    durationCount: 0,
    histogram: [],
    statuses: new Map(),
    endpoints: new Map(),
    clients: new Map(),
  };
}

function histogramIndex(latencyMs: number): number {
  const index = LATENCY_HISTOGRAM_BOUNDS_MS.findIndex((bound) => latencyMs <= bound);
  return index === -1 ? LATENCY_HISTOGRAM_BOUNDS_MS.length : index;
}

export class StatsService {
  private readonly redis: RedisManager;
  private readonly logger: Logger;
  private readonly statsPrefix: string;
  private readonly totalsKey: string;
  private readonly clientPrefix: string;

  constructor(redis: RedisManager, config: GatewayConfig, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
    this.statsPrefix = `${config.redisPrefix}:stats:`;
    this.totalsKey = `${config.redisPrefix}:totals`;
    this.clientPrefix = `${config.redisPrefix}:client:`;
  }

  private bucketKey(start: number): string {
    return `${this.statsPrefix}${start}`;
  }

  private clientKey(clientId: string): string {
    return `${this.clientPrefix}${clientId}`;
  }

  async record(input: RecordOutcomeInput): Promise<void> {
    if (!this.redis.isReady()) return;
    const timestamp = input.timestamp ?? Date.now();
    const start = Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
    const key = this.bucketKey(start);
    const blocked = input.decision === "blocked" ? 1 : 0;
    const allowed = blocked ? 0 : 1;
    const latencyMs = Math.max(0, input.latencyMs);
    const shouldRecordLatency = input.decision !== "blocked";

    try {
      const pipeline = this.redis.client.pipeline();
      pipeline.hincrby(key, "rq", 1);
      pipeline.hincrby(key, "al", allowed);
      if (blocked) pipeline.hincrby(key, "bl", 1);
      if (input.violation) pipeline.hincrby(key, "vi", 1);
      if (input.upstreamError) pipeline.hincrby(key, "ue", 1);
      pipeline.hincrby(key, `st:${input.status}`, 1);
      pipeline.hincrby(key, `ep:${input.endpoint}`, 1);
      if (allowed) pipeline.hincrby(key, `epa:${input.endpoint}`, 1);
      if (blocked) pipeline.hincrby(key, `epb:${input.endpoint}`, 1);
      if (shouldRecordLatency) {
        pipeline.hincrbyfloat(key, "ds", latencyMs);
        pipeline.hincrby(key, "dc", 1);
        pipeline.hincrby(key, `eps:${input.endpoint}`, Math.round(latencyMs));
        pipeline.hincrby(key, `epc:${input.endpoint}`, 1);
        pipeline.hincrby(key, `hb:${histogramIndex(latencyMs)}`, 1);
      }
      pipeline.hincrby(key, `cl:${input.clientId}`, 1);
      if (blocked) pipeline.hincrby(key, `clb:${input.clientId}`, 1);
      if (input.violation) pipeline.hincrby(key, `clv:${input.clientId}`, 1);
      pipeline.expire(key, STATS_RETENTION_SECONDS);

      pipeline.hincrby(this.totalsKey, "rq", 1);
      pipeline.hincrby(this.totalsKey, "al", allowed);
      if (blocked) pipeline.hincrby(this.totalsKey, "bl", 1);
      if (input.violation) pipeline.hincrby(this.totalsKey, "vi", 1);
      if (input.upstreamError) pipeline.hincrby(this.totalsKey, "ue", 1);

      const meta: ClientMeta = {
        maskedIp: input.maskedIp,
        lastSeen: new Date(timestamp).toISOString(),
      };
      pipeline.set(this.clientKey(input.clientId), JSON.stringify(meta), "EX", 24 * 60 * 60);

      await pipeline.exec();
    } catch (error) {
      this.redis.reportError("stats_write", error);
      this.logger.debug("dropping traffic aggregate after redis failure");
    }
  }

  async overview(windowSeconds = 60): Promise<{
    requests: number;
    allowed: number;
    blocked: number;
    violations: number;
    upstreamErrors: number;
    latency: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number; count: number };
  }> {
    const count = Math.max(1, Math.ceil(windowSeconds / STATS_BUCKET_SECONDS));
    const nowBucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const starts = Array.from({ length: count }, (_, index) => nowBucket - (count - 1 - index) * BUCKET_MS);
    const buckets = await this.loadBuckets(starts);
    const aggregates = [...buckets.values()];
    return {
      requests: sum(aggregates, (bucket) => bucket.requests),
      allowed: sum(aggregates, (bucket) => bucket.allowed),
      blocked: sum(aggregates, (bucket) => bucket.blocked),
      violations: sum(aggregates, (bucket) => bucket.violations),
      upstreamErrors: sum(aggregates, (bucket) => bucket.upstreamErrors),
      latency: aggregateLatency(
        aggregates.map((bucket) => ({
          sumMs: bucket.durationSum,
          count: bucket.durationCount,
          histogram: bucket.histogram,
        })),
      ),
    };
  }

  async traffic(windowMinutes: number): Promise<{
    buckets: TrafficBucket[];
    statusDistribution: StatusCount[];
    endpoints: EndpointStats[];
    clients: ClientSummary[];
  }> {
    const bucketCount = Math.min(2_160, Math.max(1, Math.ceil((windowMinutes * 60) / STATS_BUCKET_SECONDS)));
    const nowBucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const starts = Array.from(
      { length: bucketCount },
      (_, index) => nowBucket - (bucketCount - 1 - index) * BUCKET_MS,
    );
    const loaded = await this.loadBuckets(starts);
    const ordered = starts.map((start) => loaded.get(start) ?? emptyBucket(start));

    const statusTotals = new Map<number, number>();
    const endpoints = new Map<string, EndpointAggregate>();
    const clients = new Map<string, ClientAggregate>();

    for (const bucket of ordered) {
      for (const [status, value] of bucket.statuses) {
        statusTotals.set(status, (statusTotals.get(status) ?? 0) + value);
      }
      mergeEndpoints(endpoints, bucket.endpoints);
      mergeClients(clients, bucket.clients);
    }

    const groupSize = Math.max(1, Math.ceil(ordered.length / 120));
    const buckets: TrafficBucket[] = [];
    for (let index = 0; index < ordered.length; index += groupSize) {
      const group = ordered.slice(index, index + groupSize);
      const start = group[0]?.start ?? nowBucket;
      const durationSum = sum(group, (bucket) => bucket.durationSum);
      const durationCount = sum(group, (bucket) => bucket.durationCount);
      buckets.push({
        start: new Date(start).toISOString(),
        requests: sum(group, (bucket) => bucket.requests),
        allowed: sum(group, (bucket) => bucket.allowed),
        blocked: sum(group, (bucket) => bucket.blocked),
        violations: sum(group, (bucket) => bucket.violations),
        upstreamErrors: sum(group, (bucket) => bucket.upstreamErrors),
        avgLatencyMs: durationCount > 0 ? round(durationSum / durationCount) : 0,
      });
    }

    const topClients = [...clients.entries()]
      .sort((a, b) => b[1].requests - a[1].requests)
      .slice(0, 10)
      .map(([id]) => id);
    const metas = await this.loadClientMeta(topClients);

    return {
      buckets,
      statusDistribution: [...statusTotals.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => a.status - b.status),
      endpoints: [...endpoints.entries()]
        .map(([endpoint, value]) => ({
          endpoint,
          requests: value.requests,
          allowed: value.allowed,
          blocked: value.blocked,
          avgLatencyMs:
            value.durationCount > 0 ? round(value.durationSum / value.durationCount) : 0,
        }))
        .sort((a, b) => b.requests - a.requests),
      clients: topClients.map((id) => {
        const aggregate = clients.get(id) ?? { requests: 0, blocked: 0, violations: 0 };
        return {
          id,
          maskedIp: metas.get(id)?.maskedIp ?? "unknown",
          requests: aggregate.requests,
          blocked: aggregate.blocked,
          violations: aggregate.violations,
          lastSeen: metas.get(id)?.lastSeen ?? null,
          isolated: false,
          blockExpiresAt: null,
        };
      }),
    };
  }

  async clients(
    windowMinutes: number,
    page: number,
    pageSize: number,
  ): Promise<{ items: ClientSummary[]; total: number }> {
    const bucketCount = Math.min(8_640, Math.max(1, Math.ceil((windowMinutes * 60) / STATS_BUCKET_SECONDS)));
    const nowBucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const starts = Array.from(
      { length: bucketCount },
      (_, index) => nowBucket - (bucketCount - 1 - index) * BUCKET_MS,
    );
    const loaded = await this.loadBuckets(starts);
    const clients = new Map<string, ClientAggregate>();
    for (const bucket of loaded.values()) mergeClients(clients, bucket.clients);

    const ordered = [...clients.entries()].sort((a, b) => b[1].requests - a[1].requests);
    const total = ordered.length;
    const start = (page - 1) * pageSize;
    const pageItems = ordered.slice(start, start + pageSize);
    const metas = await this.loadClientMeta(pageItems.map(([id]) => id));

    return {
      items: pageItems.map(([id, aggregate]) => ({
        id,
        maskedIp: metas.get(id)?.maskedIp ?? "unknown",
        requests: aggregate.requests,
        blocked: aggregate.blocked,
        violations: aggregate.violations,
        lastSeen: metas.get(id)?.lastSeen ?? null,
        isolated: false,
        blockExpiresAt: null,
      })),
      total,
    };
  }

  private async loadBuckets(starts: number[]): Promise<Map<number, BucketAggregate>> {
    const buckets = new Map<number, BucketAggregate>();
    if (!this.redis.isReady()) {
      for (const start of starts) buckets.set(start, emptyBucket(start));
      return buckets;
    }
    try {
      const pipeline = this.redis.client.pipeline();
      for (const start of starts) pipeline.hgetall(this.bucketKey(start));
      const results = await pipeline.exec();
      results?.forEach((entry, index) => {
        const start = starts[index];
        if (start === undefined) return;
        const value = entry?.[1];
        const bucket = emptyBucket(start);
        if (value && typeof value === "object") {
          for (const [field, raw] of Object.entries(value as Record<string, string>)) {
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) continue;
            if (field === "rq") bucket.requests += parsed;
            else if (field === "al") bucket.allowed += parsed;
            else if (field === "bl") bucket.blocked += parsed;
            else if (field === "vi") bucket.violations += parsed;
            else if (field === "ue") bucket.upstreamErrors += parsed;
            else if (field === "ds") bucket.durationSum += parsed;
            else if (field === "dc") bucket.durationCount += parsed;
            else if (field.startsWith("hb:")) {
              const histIndex = Number(field.slice(3));
              if (Number.isInteger(histIndex) && histIndex >= 0) {
                bucket.histogram[histIndex] = (bucket.histogram[histIndex] ?? 0) + parsed;
              }
            } else if (field.startsWith("st:")) {
              const status = Number(field.slice(3));
              if (Number.isInteger(status)) {
                bucket.statuses.set(status, (bucket.statuses.get(status) ?? 0) + parsed);
              }
            } else if (field.startsWith("ep:")) {
              const endpoint = field.slice(3);
              const aggregate = bucket.endpoints.get(endpoint) ?? emptyEndpoint();
              aggregate.requests += parsed;
              bucket.endpoints.set(endpoint, aggregate);
            } else if (field.startsWith("epa:")) {
              const endpoint = field.slice(4);
              const aggregate = bucket.endpoints.get(endpoint) ?? emptyEndpoint();
              aggregate.allowed += parsed;
              bucket.endpoints.set(endpoint, aggregate);
            } else if (field.startsWith("epb:")) {
              const endpoint = field.slice(4);
              const aggregate = bucket.endpoints.get(endpoint) ?? emptyEndpoint();
              aggregate.blocked += parsed;
              bucket.endpoints.set(endpoint, aggregate);
            } else if (field.startsWith("eps:")) {
              const endpoint = field.slice(4);
              const aggregate = bucket.endpoints.get(endpoint) ?? emptyEndpoint();
              aggregate.durationSum += parsed;
              bucket.endpoints.set(endpoint, aggregate);
            } else if (field.startsWith("epc:")) {
              const endpoint = field.slice(4);
              const aggregate = bucket.endpoints.get(endpoint) ?? emptyEndpoint();
              aggregate.durationCount += parsed;
              bucket.endpoints.set(endpoint, aggregate);
            } else if (field.startsWith("cl:")) {
              const clientId = field.slice(3);
              const aggregate = bucket.clients.get(clientId) ?? emptyClient();
              aggregate.requests += parsed;
              bucket.clients.set(clientId, aggregate);
            } else if (field.startsWith("clb:")) {
              const clientId = field.slice(4);
              const aggregate = bucket.clients.get(clientId) ?? emptyClient();
              aggregate.blocked += parsed;
              bucket.clients.set(clientId, aggregate);
            } else if (field.startsWith("clv:")) {
              const clientId = field.slice(4);
              const aggregate = bucket.clients.get(clientId) ?? emptyClient();
              aggregate.violations += parsed;
              bucket.clients.set(clientId, aggregate);
            }
          }
        }
        buckets.set(start, bucket);
      });
    } catch (error) {
      this.redis.reportError("stats_read", error);
      for (const start of starts) buckets.set(start, emptyBucket(start));
    }
    return buckets;
  }

  private async loadClientMeta(ids: string[]): Promise<Map<string, ClientMeta>> {
    const result = new Map<string, ClientMeta>();
    if (ids.length === 0 || !this.redis.isReady()) return result;
    try {
      const values = await this.redis.client.mget(...ids.map((id) => this.clientKey(id)));
      values.forEach((value, index) => {
        const id = ids[index];
        if (!id || !value) return;
        try {
          const parsed = JSON.parse(value) as ClientMeta;
          if (typeof parsed.maskedIp === "string") result.set(id, parsed);
        } catch {
          // Ignore malformed metadata; the client still appears with an unknown address.
        }
      });
    } catch (error) {
      this.redis.reportError("client_meta_read", error);
    }
    return result;
  }
}

function emptyEndpoint(): EndpointAggregate {
  return { requests: 0, allowed: 0, blocked: 0, durationSum: 0, durationCount: 0 };
}

function emptyClient(): ClientAggregate {
  return { requests: 0, blocked: 0, violations: 0 };
}

function mergeEndpoints(
  target: Map<string, EndpointAggregate>,
  source: Map<string, EndpointAggregate>,
): void {
  for (const [endpoint, value] of source) {
    const aggregate = target.get(endpoint) ?? emptyEndpoint();
    aggregate.requests += value.requests;
    aggregate.allowed += value.allowed;
    aggregate.blocked += value.blocked;
    aggregate.durationSum += value.durationSum;
    aggregate.durationCount += value.durationCount;
    target.set(endpoint, aggregate);
  }
}

function mergeClients(
  target: Map<string, ClientAggregate>,
  source: Map<string, ClientAggregate>,
): void {
  for (const [id, value] of source) {
    const aggregate = target.get(id) ?? emptyClient();
    aggregate.requests += value.requests;
    aggregate.blocked += value.blocked;
    aggregate.violations += value.violations;
    target.set(id, aggregate);
  }
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
