import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class DemoMetrics {
  readonly registry = new Registry();

  readonly requests = new Counter({
    name: "edgeguard_demo_requests_total",
    help: "Demo API requests by route, method and status.",
    labelNames: ["route", "method", "status"] as const,
    registers: [this.registry],
  });

  readonly duration = new Histogram({
    name: "edgeguard_demo_request_duration_seconds",
    help: "Demo API request duration in seconds.",
    labelNames: ["route", "method"] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  readonly buildInfo = new Gauge({
    name: "edgeguard_demo_build_info",
    help: "Demo API build information.",
    labelNames: ["version"] as const,
    registers: [this.registry],
  });

  constructor(version: string) {
    this.registry.setDefaultLabels({ service: "edgeguard-demo-api" });
    this.buildInfo.labels(version).set(1);
    collectDefaultMetrics({ register: this.registry, prefix: "edgeguard_demo_" });
  }

  observe(input: {
    route: string;
    method: string;
    status: number;
    durationSeconds: number;
  }): void {
    this.requests.inc({
      route: input.route,
      method: input.method,
      status: String(input.status),
    });
    this.duration.observe(
      { route: input.route, method: input.method },
      Math.max(0, input.durationSeconds),
    );
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
