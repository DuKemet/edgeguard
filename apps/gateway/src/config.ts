import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HTTP_METHODS, SERVICE_VERSION, type HttpMethod } from "@edgeguard/shared";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface GatewayConfig {
  env: "development" | "test" | "production";
  version: string;
  port: number;
  host: string;
  logLevel: string;
  redisUrl: string;
  redisPrefix: string;
  redisRequired: boolean;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;
  upstreamUrl: string;
  upstreamAllowedHosts: string[];
  allowPrivateUpstreams: boolean;
  upstreamTimeoutMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  maxPathLength: number;
  allowedMethods: HttpMethod[];
  trustProxy: boolean | number | string;
  corsOrigins: string[];
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  tokenTtlSeconds: number;
  adminUsername: string;
  adminPasswordHash: string;
  viewerUsername: string | null;
  viewerPasswordHash: string | null;
  clientHashSecret: string;
  metricsToken: string | null;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new ConfigError(`Invalid boolean value: ${value}`);
}

function parseIntValue(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function validateCorsOrigins(values: string[]): string[] {
  return values.map((value) => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("unsupported protocol");
      }
      return url.origin;
    } catch {
      throw new ConfigError(`Invalid CORS origin: ${value}`);
    }
  });
}

function validateAllowedMethods(value: string | undefined): HttpMethod[] {
  const requested = parseList(value).map((method) => method.toUpperCase());
  if (requested.length === 0) return [...HTTP_METHODS];
  for (const method of requested) {
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      throw new ConfigError(`Unsupported ALLOWED_METHODS entry: ${method}`);
    }
  }
  return requested as HttpMethod[];
}

function validateUpstreamUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("UPSTREAM_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ConfigError("UPSTREAM_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new ConfigError("UPSTREAM_URL must not contain credentials");
  }
  if (url.hash) {
    throw new ConfigError("UPSTREAM_URL must not contain a fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError("UPSTREAM_URL must not include a path; configure allowed hosts instead");
  }
  if (!url.hostname) {
    throw new ConfigError("UPSTREAM_URL must include a hostname");
  }
  return url;
}

function validateHash(name: string, hash: string | undefined): string {
  if (!hash) throw new ConfigError(`${name} is required`);
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
    throw new ConfigError(`${name} must be a bcrypt hash`);
  }
  return hash;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new ConfigError("NODE_ENV must be development, test, or production");
  }

  const upstreamRaw = env.UPSTREAM_URL?.trim() || "http://127.0.0.1:4000";
  const upstream = validateUpstreamUrl(upstreamRaw);
  const allowedHosts = parseList(env.UPSTREAM_ALLOWED_HOSTS || upstream.hostname).map((host) =>
    host.toLowerCase(),
  );
  if (!allowedHosts.includes(upstream.hostname.toLowerCase())) {
    throw new ConfigError("UPSTREAM_ALLOWED_HOSTS must include the UPSTREAM_URL hostname");
  }

  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    throw new ConfigError("JWT_SECRET must be at least 32 characters");
  }
  if (nodeEnv === "production" && /change-me|replace-me|example/i.test(jwtSecret)) {
    throw new ConfigError("JWT_SECRET still contains a placeholder value");
  }

  const adminPasswordHash = validateHash("ADMIN_PASSWORD_HASH", env.ADMIN_PASSWORD_HASH);
  const viewerUsername = env.VIEWER_USERNAME?.trim() || null;
  const viewerPasswordHash = env.VIEWER_PASSWORD_HASH?.trim() || null;
  if (Boolean(viewerUsername) !== Boolean(viewerPasswordHash)) {
    throw new ConfigError("VIEWER_USERNAME and VIEWER_PASSWORD_HASH must be configured together");
  }

  const config: GatewayConfig = {
    env: nodeEnv as GatewayConfig["env"],
    version: SERVICE_VERSION,
    port: parseIntValue("PORT", env.PORT, 8080, 1, 65_535),
    host: env.HOST?.trim() || "0.0.0.0",
    logLevel: env.LOG_LEVEL?.trim() || "info",
    redisUrl: env.REDIS_URL?.trim() || "redis://127.0.0.1:6379",
    redisPrefix: (env.REDIS_PREFIX?.trim() || "edgeguard").replace(/[^a-zA-Z0-9:_-]/g, ""),
    redisRequired: parseBoolean(env.REDIS_REQUIRED, false),
    redisConnectTimeoutMs: parseIntValue(
      "REDIS_CONNECT_TIMEOUT_MS",
      env.REDIS_CONNECT_TIMEOUT_MS,
      1_500,
      100,
      60_000,
    ),
    redisCommandTimeoutMs: parseIntValue(
      "REDIS_COMMAND_TIMEOUT_MS",
      env.REDIS_COMMAND_TIMEOUT_MS,
      750,
      100,
      60_000,
    ),
    upstreamUrl: upstream.origin,
    upstreamAllowedHosts: allowedHosts,
    allowPrivateUpstreams: parseBoolean(env.ALLOW_PRIVATE_UPSTREAMS, false),
    upstreamTimeoutMs: parseIntValue(
      "UPSTREAM_TIMEOUT_MS",
      env.UPSTREAM_TIMEOUT_MS,
      10_000,
      100,
      120_000,
    ),
    maxResponseBytes: parseIntValue(
      "MAX_RESPONSE_BYTES",
      env.MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      1_024,
      100 * 1024 * 1024,
    ),
    maxRequestBytes: parseIntValue(
      "MAX_REQUEST_BYTES",
      env.MAX_REQUEST_BYTES,
      1 * 1024 * 1024,
      1_024,
      50 * 1024 * 1024,
    ),
    maxPathLength: parseIntValue("MAX_PATH_LENGTH", env.MAX_PATH_LENGTH, 2_048, 64, 16_384),
    allowedMethods: validateAllowedMethods(env.ALLOWED_METHODS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    corsOrigins: validateCorsOrigins(
      parseList(env.CORS_ORIGINS || "http://localhost:5173,http://localhost:8081"),
    ),
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER?.trim() || "edgeguard",
    jwtAudience: env.JWT_AUDIENCE?.trim() || "edgeguard-dashboard",
    tokenTtlSeconds: parseIntValue("TOKEN_TTL_SECONDS", env.TOKEN_TTL_SECONDS, 3_600, 60, 86_400),
    adminUsername: env.ADMIN_USERNAME?.trim() || "admin",
    adminPasswordHash,
    viewerUsername,
    viewerPasswordHash,
    clientHashSecret: env.CLIENT_HASH_SECRET?.trim() || jwtSecret,
    metricsToken: env.METRICS_TOKEN?.trim() || null,
  };

  if (!config.redisPrefix) {
    throw new ConfigError("REDIS_PREFIX is empty after sanitization");
  }
  return config;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && (b === 0 || b === 2)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8")) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true;
}

/**
 * Resolves the configured upstream once at startup and rejects destinations
 * outside the explicit host allowlist or in private address space unless the
 * operator opted in. This is the SSRF boundary; request paths can never change
 * the upstream origin.
 */
export async function assertUpstreamDestination(config: GatewayConfig): Promise<void> {
  const url = new URL(config.upstreamUrl);
  if (!config.upstreamAllowedHosts.includes(url.hostname.toLowerCase())) {
    throw new ConfigError("Upstream hostname is not in UPSTREAM_ALLOWED_HOSTS");
  }

  const directIpVersion = isIP(url.hostname);
  if (directIpVersion > 0) {
    if (!config.allowPrivateUpstreams && isPrivateAddress(url.hostname)) {
      throw new ConfigError(
        "UPSTREAM_URL resolves to a private address; set ALLOW_PRIVATE_UPSTREAMS=true only for trusted local deployments",
      );
    }
    return;
  }

  let list: { address: string; family: number }[];
  try {
    list = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ConfigError(`Unable to resolve upstream hostname: ${url.hostname}`);
  }
  if (list.length === 0) {
    throw new ConfigError(`Upstream hostname did not resolve: ${url.hostname}`);
  }
  if (!config.allowPrivateUpstreams && list.some((entry) => isPrivateAddress(entry.address))) {
    throw new ConfigError(
      "UPSTREAM_URL resolves to a private address; set ALLOW_PRIVATE_UPSTREAMS=true only for trusted local deployments",
    );
  }
}
