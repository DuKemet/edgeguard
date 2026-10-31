import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export class GatewayMetrics {
  readonly registry = new Registry();

  readonly requests = new Counter({
    name: "edgeguard_gateway_requests_total",
    help: "Proxied requests by bounded route, method, status and decision.",
    labelNames: ["route", "method", "status", "decision"] as const,
    registers: [this.registry],
  });

  readonly duration = new Histogram({
    name: "edgeguard_gateway_request_duration_seconds",
    help: "Gateway request duration in seconds.",
    labelNames: ["route", "method", "decision"] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  readonly blocked = new Counter({
    name: "edgeguard_gateway_blocked_total",
    help: "Blocked requests by reason.",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly violations = new Counter({
    name: "edgeguard_gateway_rate_limit_violations_total",
    help: "Rate-limit violations by rule.",
    labelNames: ["rule"] as const,
    registers: [this.registry],
  });

  readonly upstreamFailures = new Counter({
    name: "edgeguard_gateway_upstream_failures_total",
    help: "Upstream transport failures and timeouts.",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });

  readonly redisErrors = new Counter({
    name: "edgeguard_gateway_redis_errors_total",
    help: "Redis operation errors.",
    labelNames: ["operation"] as const,
    registers: [this.registry],
  });

  readonly redisFallbacks = new Counter({
    name: "edgeguard_gateway_redis_fallback_total",
    help: "Requests that used the local fallback limiter because Redis was unavailable.",
    registers: [this.registry],
  });

  readonly redisUp = new Gauge({
    name: "edgeguard_gateway_redis_up",
    help: "1 when Redis is reachable, 0 otherwise.",
    registers: [this.registry],
  });

  readonly activeBlocks = new Gauge({
    name: "edgeguard_gateway_active_blocks",
    help: "Number of active temporary client isolations.",
    registers: [this.registry],
  });

  readonly detectionEvents = new Counter({
    name: "edgeguard_gateway_detection_events_total",
    help: "Security detection events recorded by category and severity.",
    labelNames: ["category", "severity"] as const,
    registers: [this.registry],
  });

  readonly buildInfo = new Gauge({
    name: "edgeguard_gateway_build_info",
    help: "Build information.",
    labelNames: ["version"] as const,
    registers: [this.registry],
  });

  constructor(version: string) {
    this.registry.setDefaultLabels({ service: "edgeguard-gateway" });
    this.buildInfo.labels(version).set(1);
    collectDefaultMetrics({ register: this.registry, prefix: "edgeguard_gateway_" });
  }

  observeRequest(input: {
    route: string;
    method: string;
    status: number;
    decision: "allowed" | "blocked" | "error";
    durationSeconds: number;
  }): void {
    const labels = {
      route: input.route,
      method: input.method,
      decision: input.decision,
    };
    this.requests.inc({ ...labels, status: String(input.status) });
    this.duration.observe(labels, Math.max(0, input.durationSeconds));
  }

  setActiveBlocks(value: number): void {
    this.activeBlocks.set(value);
  }

  setRedisUp(value: boolean): void {
    this.redisUp.set(value ? 1 : 0);
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
