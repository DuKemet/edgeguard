import type {
  DetectionSettings,
  EventCategory,
  RateLimitRule,
  Severity,
} from "./types";

export const SERVICE_VERSION = "1.0.0";

export const REDIS_KEY_PREFIX_DEFAULT = "edgeguard";

/** Upper bounds in milliseconds; the final histogram slot is > the last bound. */
export const LATENCY_HISTOGRAM_BOUNDS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const;

export const DETECTION_BUCKET_SECONDS = 5;
export const STATS_BUCKET_SECONDS = 10;
export const STATS_RETENTION_SECONDS = 6 * 60 * 60;
export const EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const CLIENT_META_RETENTION_SECONDS = 24 * 60 * 60;

export const EVENT_CATEGORY_META: Record<
  EventCategory,
  { label: string; description: string }
> = {
  traffic_spike: {
    label: "Traffic spike",
    description: "Platform-wide request rate rose sharply versus the previous window.",
  },
  high_client_rate: {
    label: "High client rate",
    description: "A single client exceeded the configured requests-per-second threshold.",
  },
  endpoint_flood: {
    label: "Endpoint flood",
    description: "An endpoint received more than its configured request rate.",
  },
  rate_limit_violation: {
    label: "Repeated violations",
    description: "A client repeatedly exceeded its rate limit within the violation window.",
  },
  upstream_error_spike: {
    label: "Upstream error spike",
    description: "The upstream error ratio crossed the configured threshold.",
  },
  cooldown_abuse: {
    label: "Cooldown abuse",
    description: "An isolated client kept sending requests during its cooldown period.",
  },
  admin_unblock: {
    label: "Administrative unblock",
    description: "An administrator lifted a temporary client isolation.",
  },
};

export const SEVERITY_META: Record<Severity, { label: string; rank: number }> = {
  info: { label: "Info", rank: 0 },
  low: { label: "Low", rank: 1 },
  medium: { label: "Medium", rank: 2 },
  high: { label: "High", rank: 3 },
  critical: { label: "Critical", rank: 4 },
};

export const DEFAULT_RULES: Omit<RateLimitRule, "updatedAt">[] = [
  {
    id: "default",
    name: "Global fallback",
    endpoint: "*",
    match: "prefix",
    limit: 60,
    windowSeconds: 10,
    burst: 20,
    enabled: true,
  },
  {
    id: "products",
    name: "Product catalogue",
    endpoint: "/api/products",
    match: "prefix",
    limit: 30,
    windowSeconds: 10,
    burst: 10,
    enabled: true,
  },
  {
    id: "orders",
    name: "Order history",
    endpoint: "/api/orders",
    match: "prefix",
    limit: 20,
    windowSeconds: 10,
    burst: 5,
    enabled: true,
  },
  {
    id: "profile",
    name: "Customer profile",
    endpoint: "/api/profile",
    match: "exact",
    limit: 15,
    windowSeconds: 10,
    burst: 5,
    enabled: true,
  },
];

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  enabled: true,
  windowSeconds: 10,
  clientRpsThreshold: 6,
  endpointRpsThreshold: 15,
  trafficSpikeMultiplier: 3,
  trafficSpikeMinRps: 20,
  violationThreshold: 5,
  violationWindowSeconds: 60,
  upstreamErrorRateThreshold: 0.25,
  upstreamMinSamples: 10,
  cooldownAbuseThreshold: 10,
  autoIsolate: true,
  isolationSeconds: 60,
  suppressionSeconds: 30,
};
