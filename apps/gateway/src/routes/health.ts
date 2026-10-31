import { Router } from "express";
import type { HealthResponse } from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import type { GatewayMetrics } from "../metrics";
import type { RedisManager } from "../redis";
import { asyncHandler } from "../utils/async-handler";

export function createHealthRouter(input: {
  config: GatewayConfig;
  redis: RedisManager;
  metrics: GatewayMetrics;
  startedAt: number;
}): Router {
  const router = Router();
  const uptime = () => Math.round((Date.now() - input.startedAt) / 1000);

  router.get("/live", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      service: "edgeguard-gateway",
      version: input.config.version,
      uptimeSeconds: uptime(),
    };
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(body);
  });

  router.get(
    "/ready",
    asyncHandler(async (_req, res) => {
      const redisOk = await input.redis.ping();
      input.metrics.setRedisUp(redisOk);
      const ready = redisOk || !input.config.redisRequired;
      const body: HealthResponse = {
        status: redisOk ? "ok" : "degraded",
        service: "edgeguard-gateway",
        version: input.config.version,
        uptimeSeconds: uptime(),
        checks: {
          redis: redisOk ? "ok" : "down",
          upstream: "configured",
        },
      };
      res.setHeader("Cache-Control", "no-store");
      res.status(ready ? 200 : 503).json(body);
    }),
  );

  return router;
}
