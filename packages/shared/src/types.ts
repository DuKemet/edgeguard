export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export const RULE_MATCHES = ["exact", "prefix"] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];

export interface RateLimitRule {
  id: string;
  name: string;
  /** "*" for the fallback rule, otherwise an absolute path such as /api/products. */
  endpoint: string;
  match: RuleMatch;
  /** Allowed requests per window per client, before burst capacity. */
  limit: number;
  windowSeconds: number;
  /** Extra tokens allowed above `limit` for short bursts. */
  burst: number;
  enabled: boolean;
  updatedAt: string;
}

export const EVENT_CATEGORIES = [
  "traffic_spike",
  "high_client_rate",
  "endpoint_flood",
  "rate_limit_violation",
  "upstream_error_spike",
  "cooldown_abuse",
  "admin_unblock",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ACTIONS_TAKEN = [
  "none",
  "rate_limited",
  "client_isolated",
  "client_unblocked",
] as const;
export type ActionTaken = (typeof ACTIONS_TAKEN)[number];

export type ObservedUnit = "req/s" | "requests" | "ratio" | "count";

export interface SecurityEvent {
  id: string;
  timestamp: string;
  category: EventCategory;
  severity: Severity;
  clientId: string | null;
  /** Redacted, display-safe client address (for example 203.0.113.xxx). */
  maskedIp: string | null;
  endpoint: string;
  method: string | null;
  observedValue: number;
  threshold: number;
  unit: ObservedUnit;
  action: ActionTaken;
  message: string;
  expiresAt: string | null;
  resolved: boolean;
  requestId: string | null;
  details: Record<string, string | number | boolean> | null;
}

export interface DetectionSettings {
  enabled: boolean;
  windowSeconds: number;
  clientRpsThreshold: number;
  endpointRpsThreshold: number;
  trafficSpikeMultiplier: number;
  trafficSpikeMinRps: number;
  violationThreshold: number;
  violationWindowSeconds: number;
  upstreamErrorRateThreshold: number;
  upstreamMinSamples: number;
  cooldownAbuseThreshold: number;
  autoIsolate: boolean;
  isolationSeconds: number;
  suppressionSeconds: number;
}

export interface Settings {
  detection: DetectionSettings;
  updatedAt: string;
}

export interface AuthUser {
  username: string;
  role: "admin" | "viewer";
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export interface OverviewResponse {
  generatedAt: string;
  windowSeconds: number;
  gatewayVersion: string;
  redisStatus: "ok" | "degraded";
  requests: number;
  requestsPerSecond: number;
  allowed: number;
  blocked: number;
  violations: number;
  upstreamErrors: number;
  upstreamErrorRate: number;
  latency: {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  activeBlocks: number;
  eventsLastHour: number;
}

export interface TrafficBucket {
  start: string;
  requests: number;
  allowed: number;
  blocked: number;
  violations: number;
  upstreamErrors: number;
  avgLatencyMs: number;
}

export interface StatusCount {
  status: number;
  count: number;
}

export interface EndpointStats {
  endpoint: string;
  requests: number;
  allowed: number;
  blocked: number;
  avgLatencyMs: number;
}

export interface ClientSummary {
  id: string;
  maskedIp: string;
  requests: number;
  blocked: number;
  violations: number;
  lastSeen: string | null;
  isolated: boolean;
  blockExpiresAt: string | null;
}

export interface TrafficResponse {
  generatedAt: string;
  windowSeconds: number;
  bucketSeconds: number;
  buckets: TrafficBucket[];
  statusDistribution: StatusCount[];
  endpoints: EndpointStats[];
  clients: ClientSummary[];
}

export interface ActiveBlock {
  clientId: string;
  maskedIp: string;
  reason: string;
  category: EventCategory | "manual";
  blockedAt: string;
  expiresAt: string;
  remainingSeconds: number;
}

export interface ClientsResponse {
  generatedAt: string;
  total: number;
  items: ClientSummary[];
  activeBlocks: ActiveBlock[];
}

export interface EventsResponse {
  items: SecurityEvent[];
  page: number;
  pageSize: number;
  total: number;
}

export interface RulesResponse {
  items: RateLimitRule[];
}

export type SettingsResponse = Settings;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
  checks?: Record<string, string>;
}
