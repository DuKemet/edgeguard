import { Router } from "express";
import {
  clientsQuerySchema,
  eventsQuerySchema,
  loginSchema,
  rateLimitRuleCreateSchema,
  rateLimitRulePatchSchema,
  ruleIdSchema,
  settingsUpdateSchema,
  trafficQuerySchema,
  type ActiveBlock,
  type ClientSummary,
  type OverviewResponse,
} from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import { AppError, BadRequestError, NotFoundError, UnauthorizedError } from "../errors";
import { createRequireAuth, requireRole } from "../middleware/auth";
import type { GatewayMetrics } from "../metrics";
import type { RedisManager } from "../redis";
import type { AuthService } from "../services/auth";
import type { BlockService } from "../services/blocks";
import type { EventService } from "../services/events";
import type { LoginThrottle } from "../services/login-throttle";
import type { RulesService } from "../services/rules";
import type { SettingsService } from "../services/settings";
import type { StatsService } from "../services/stats";
import { asyncHandler } from "../utils/async-handler";
import { identifyClient } from "../utils/client";
import { requestIdFrom } from "../utils/request-id";

export interface AdminRouterDeps {
  config: GatewayConfig;
  auth: AuthService;
  rules: RulesService;
  settings: SettingsService;
  blocks: BlockService;
  stats: StatsService;
  events: EventService;
  redis: RedisManager;
  metrics: GatewayMetrics;
  loginThrottle: LoginThrottle;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const requireAuth = createRequireAuth(deps.auth);

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const client = identifyClient(req, deps.config);
      const throttle = await deps.loginThrottle.check(client.clientId);
      if (throttle.limited) {
        res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
        throw new AppError(
          429,
          "LOGIN_THROTTLED",
          "Too many failed login attempts. Try again later.",
          { details: { retryAfterSeconds: throttle.retryAfterSeconds } },
        );
      }

      const body = loginSchema.parse(req.body);
      const user = await deps.auth.verifyCredentials(body.username, body.password);
      if (!user) {
        await deps.loginThrottle.recordFailure(client.clientId);
        throw new UnauthorizedError("Invalid username or password");
      }
      await deps.loginThrottle.reset(client.clientId);
      res.status(200).json(deps.auth.issueToken(user));
    }),
  );

  router.use(requireAuth);

  router.get("/auth/me", (req, res) => {
    res.json({ user: req.user });
  });

  router.get(
    "/overview",
    asyncHandler(async (_req, res) => {
      const [overview, blocks, eventsLastHour, redisOk] = await Promise.all([
        deps.stats.overview(60),
        deps.blocks.listActive(),
        deps.events.countLastHour(),
        deps.redis.ping(),
      ]);
      deps.metrics.setRedisUp(redisOk);
      const body: OverviewResponse = {
        generatedAt: new Date().toISOString(),
        windowSeconds: 60,
        gatewayVersion: deps.config.version,
        redisStatus: redisOk ? "ok" : "degraded",
        requests: overview.requests,
        requestsPerSecond: round(overview.requests / 60, 2),
        allowed: overview.allowed,
        blocked: overview.blocked,
        violations: overview.violations,
        upstreamErrors: overview.upstreamErrors,
        upstreamErrorRate:
          overview.requests > 0 ? round(overview.upstreamErrors / overview.requests, 4) : 0,
        latency: {
          avgMs: overview.latency.avgMs,
          p50Ms: overview.latency.p50Ms,
          p95Ms: overview.latency.p95Ms,
          p99Ms: overview.latency.p99Ms,
        },
        activeBlocks: blocks.length,
        eventsLastHour,
      };
      res.json(body);
    }),
  );

  router.get(
    "/traffic",
    asyncHandler(async (req, res) => {
      const query = trafficQuerySchema.parse(req.query);
      const [traffic, activeBlocks] = await Promise.all([
        deps.stats.traffic(query.windowMinutes),
        deps.blocks.listActive(),
      ]);
      const blockMap = new Map(activeBlocks.map((block) => [block.clientId, block]));
      const joinedClients = traffic.clients.map((client) => joinBlock(client, blockMap));
      const bucketSeconds =
        traffic.buckets.length > 1
          ? Math.round(
              (new Date(traffic.buckets[1]!.start).getTime() -
                new Date(traffic.buckets[0]!.start).getTime()) /
                1000,
            )
          : query.windowMinutes * 60;
      res.json({
        generatedAt: new Date().toISOString(),
        windowSeconds: query.windowMinutes * 60,
        bucketSeconds,
        ...traffic,
        clients: joinedClients,
      });
    }),
  );

  router.get(
    "/events",
    asyncHandler(async (req, res) => {
      const query = eventsQuerySchema.parse(req.query);
      const result = await deps.events.list(query);
      res.json(result);
    }),
  );

  router.get(
    "/clients",
    asyncHandler(async (req, res) => {
      const query = clientsQuerySchema.parse(req.query);
      const [clients, activeBlocks] = await Promise.all([
        deps.stats.clients(query.windowMinutes, query.page, query.pageSize),
        deps.blocks.listActive(),
      ]);
      const blockMap = new Map(activeBlocks.map((block) => [block.clientId, block]));
      res.json({
        generatedAt: new Date().toISOString(),
        total: clients.total,
        items: clients.items.map((client) => joinBlock(client, blockMap)),
        activeBlocks,
      });
    }),
  );

  router.get(
    "/rules",
    asyncHandler(async (_req, res) => {
      res.json({ items: await deps.rules.list() });
    }),
  );

  router.post(
    "/rules",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const body = rateLimitRuleCreateSchema.parse(req.body);
      const rule = await deps.rules.create(body);
      res.status(201).json({ item: rule });
    }),
  );

  router.put(
    "/rules/:id",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const id = parseRuleId(req.params.id);
      const patch = rateLimitRulePatchSchema.parse(req.body);
      const rule = await deps.rules.update(id, patch);
      res.json({ item: rule });
    }),
  );

  router.delete(
    "/rules/:id",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const id = parseRuleId(req.params.id);
      await deps.rules.remove(id);
      res.status(204).send();
    }),
  );

  router.get(
    "/settings",
    asyncHandler(async (_req, res) => {
      res.json(await deps.settings.get());
    }),
  );

  router.put(
    "/settings",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const body = settingsUpdateSchema.parse(req.body);
      const updated = await deps.settings.update(body.detection);
      res.json(updated);
    }),
  );

  router.post(
    "/clients/:id/unblock",
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const clientId = req.params.id ?? "";
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
        throw new BadRequestError("Invalid client identifier");
      }
      const existing = await deps.blocks.isBlocked(clientId);
      if (!existing) throw new NotFoundError("Client is not currently isolated");
      await deps.blocks.unblock(clientId);
      const event = await deps.events.create({
        category: "admin_unblock",
        severity: "info",
        clientId,
        maskedIp: existing.maskedIp,
        endpoint: "admin",
        method: req.method,
        observedValue: 1,
        threshold: 0,
        unit: "count",
        action: "client_unblocked",
        message: `Administrator ${req.user?.username ?? "unknown"} lifted isolation for ${existing.maskedIp}.`,
        expiresAt: null,
        requestId: requestIdFrom(res),
        details: {
          admin: req.user?.username ?? "unknown",
          originalReason: existing.reason,
          originalExpiresAt: existing.expiresAt,
        },
      });
      res.json({ unblocked: true, clientId, eventId: event.id });
    }),
  );

  router.use((_req, _res, next) => {
    next(new NotFoundError("Administrative route not found"));
  });

  return router;
}

function parseRuleId(value: string | undefined): string {
  const result = ruleIdSchema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError("Invalid rule identifier");
  }
  return result.data;
}

function joinBlock(client: ClientSummary, blocks: Map<string, ActiveBlock>): ClientSummary {
  const block = blocks.get(client.id);
  return {
    ...client,
    isolated: Boolean(block),
    blockExpiresAt: block?.expiresAt ?? null,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
