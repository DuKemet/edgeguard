import { timingSafeEqual } from "node:crypto";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { GatewayConfig } from "./config";
import { ForbiddenError } from "./errors";
import type { Logger } from "./logger";
import { GatewayMetrics } from "./metrics";
import { RedisManager } from "./redis";
import {
  createErrorHandler,
  notFoundHandler,
  requestIdMiddleware,
  requestLogMiddleware,
} from "./middleware/request";
import { createAdminRouter } from "./routes/admin";
import { createHealthRouter } from "./routes/health";
import { createProxyRouter } from "./routes/proxy";
import { AuthService, extractBearerToken } from "./services/auth";
import { BlockService } from "./services/blocks";
import { DetectionService } from "./services/detection";
import { EventService } from "./services/events";
import { RateLimiter } from "./services/limiter";
import { LoginThrottle } from "./services/login-throttle";
import { RulesService } from "./services/rules";
import { SettingsService } from "./services/settings";
import { StatsService } from "./services/stats";

export interface GatewayServices {
  auth: AuthService;
  blocks: BlockService;
  detection: DetectionService;
  events: EventService;
  limiter: RateLimiter;
  loginThrottle: LoginThrottle;
  rules: RulesService;
  settings: SettingsService;
  stats: StatsService;
}

export interface AppDependencies extends GatewayServices {
  config: GatewayConfig;
  logger: Logger;
  metrics: GatewayMetrics;
  redis: RedisManager;
  startedAt: number;
}

export function createServices(input: {
  config: GatewayConfig;
  logger: Logger;
  metrics: GatewayMetrics;
  redis: RedisManager;
}): GatewayServices {
  const { config, logger, metrics, redis } = input;
  const events = new EventService(redis, config, metrics, logger);
  const settings = new SettingsService(redis, config, logger);
  const blocks = new BlockService(redis, config, metrics, logger);
  return {
    auth: new AuthService(config, logger),
    blocks,
    detection: new DetectionService(redis, config, settings, blocks, events, logger),
    events,
    limiter: new RateLimiter(redis, config, metrics, logger),
    loginThrottle: new LoginThrottle(redis, config),
    rules: new RulesService(redis, config, logger),
    settings,
    stats: new StatsService(redis, config, logger),
  };
}

function buildCorsOptions(config: GatewayConfig): CorsOptions {
  const allowed = new Set(config.corsOrigins);
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new ForbiddenError("Request origin is not allowed"));
    },
    methods: [...config.allowedMethods],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposedHeaders: [
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "RateLimit-Policy",
      "Retry-After",
      "X-Request-Id",
      "X-EdgeGuard-Rule",
      "X-EdgeGuard-Isolated",
      "X-EdgeGuard-Block-Expires",
      "X-EdgeGuard-Redis",
    ],
    credentials: false,
    maxAge: 600,
  };
}

function safeTokenEquals(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function createApp(deps: AppDependencies): Express {
  const { config, logger, metrics, redis } = deps;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  app.use(cors(buildCorsOptions(config)));
  app.use(requestIdMiddleware);
  app.use(requestLogMiddleware(logger));

  app.use(
    "/health",
    createHealthRouter({
      config,
      redis,
      metrics,
      startedAt: deps.startedAt,
    }),
  );

  app.get("/metrics", async (_req, res) => {
    if (config.metricsToken) {
      const supplied = extractBearerToken(_req.header("authorization")) ?? "";
      if (!supplied || !safeTokenEquals(config.metricsToken, supplied)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="edgeguard-metrics"');
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Metrics credentials are required" },
        });
        return;
      }
    }
    const rendered = await metrics.render();
    res.setHeader("Content-Type", rendered.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(rendered.body);
  });

  app.use(
    "/admin",
    express.json({ limit: "64kb", strict: true }),
    createAdminRouter({
      config,
      auth: deps.auth,
      rules: deps.rules,
      settings: deps.settings,
      blocks: deps.blocks,
      stats: deps.stats,
      events: deps.events,
      redis,
      metrics,
      loginThrottle: deps.loginThrottle,
    }),
  );

  app.use(
    createProxyRouter({
      config,
      logger,
      metrics,
      rules: deps.rules,
      limiter: deps.limiter,
      blocks: deps.blocks,
      detection: deps.detection,
      stats: deps.stats,
    }),
  );

  app.use(notFoundHandler());
  app.use(createErrorHandler(logger));

  return app;
}

export function createAppDependencies(input: {
  config: GatewayConfig;
  logger: Logger;
  redis: RedisManager;
  startedAt?: number;
}): AppDependencies {
  const metrics = new GatewayMetrics(input.config.version);
  return {
    config: input.config,
    logger: input.logger,
    metrics,
    redis: input.redis,
    startedAt: input.startedAt ?? Date.now(),
    ...createServices({
      config: input.config,
      logger: input.logger,
      metrics,
      redis: input.redis,
    }),
  };
}
