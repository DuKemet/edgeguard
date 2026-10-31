import "dotenv/config";
import { createServer } from "node:http";
import { createApp, createAppDependencies } from "./app";
import { ConfigError, assertUpstreamDestination, parseConfig } from "./config";
import { createLogger } from "./logger";
import { GatewayMetrics } from "./metrics";
import { RedisManager } from "./redis";

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`EdgeGuard configuration error: ${message}\n`);
    process.exit(1);
    return;
  }

  const logger = createLogger(config.logLevel);
  const metrics = new GatewayMetrics(config.version);

  const redis = new RedisManager({
    url: config.redisUrl,
    connectTimeoutMs: config.redisConnectTimeoutMs,
    commandTimeoutMs: config.redisCommandTimeoutMs,
    logger,
    onError: (operation) => metrics.redisErrors.inc({ operation }),
  });

  const connected = await redis.connect();
  metrics.setRedisUp(connected);
  if (!connected && config.redisRequired) {
    logger.error("redis is required but unavailable at startup; refusing to serve");
    await redis.close();
    process.exit(1);
    return;
  }

  try {
    await assertUpstreamDestination(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { err: error instanceof ConfigError ? error.message : message },
      "upstream destination validation failed",
    );
    await redis.close();
    process.exit(1);
    return;
  }

  const deps = createAppDependencies({ config, logger, redis });
  await deps.rules.init();
  await deps.settings.init();

  const app = createApp(deps);
  const server = createServer(app);

  const healthTimer = setInterval(() => {
    void redis.ping().then((ok) => metrics.setRedisUp(ok));
  }, 10_000);
  healthTimer.unref();

  const blocksTimer = setInterval(() => {
    void deps.blocks.refreshGauge();
  }, 15_000);
  blocksTimer.unref();

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        upstream: config.upstreamUrl,
        redis: connected ? "connected" : "degraded",
        env: config.env,
        version: config.version,
      },
      "edgeguard gateway listening",
    );
  });

  server.on("error", (error) => {
    logger.error({ err: error.message }, "http server error");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(() => {
      void redis.close().finally(() => {
        clearInterval(healthTimer);
        clearInterval(blocksTimer);
        clearTimeout(force);
        logger.info("shutdown complete");
        process.exit(0);
      });
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void main().catch((error) => {
  process.stderr.write(
    `EdgeGuard gateway failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
