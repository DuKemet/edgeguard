import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { Router, type Response } from "express";
import { request as upstreamRequest, type Dispatcher } from "undici";
import { matchRateLimitRule, normalizeEndpoint } from "@edgeguard/shared";
import type { GatewayConfig } from "../config";
import {
  BadGatewayError,
  GatewayTimeoutError,
  MethodNotAllowedError,
  ServiceUnavailableError,
  TooManyRequestsError,
} from "../errors";
import type { Logger } from "../logger";
import type { GatewayMetrics } from "../metrics";
import type { BlockService } from "../services/blocks";
import type { DetectionService } from "../services/detection";
import type { RateLimiter } from "../services/limiter";
import type { RulesService } from "../services/rules";
import type { StatsService } from "../services/stats";
import { identifyClient } from "../utils/client";
import { buildUpstreamHeaders, sanitizeResponseHeaders } from "../utils/headers";
import { validateProxyPath } from "../utils/path";
import { applyRateLimitHeaders } from "../utils/rate-limit-headers";
import { requestIdFrom } from "../utils/request-id";

export interface ProxyRouterDeps {
  config: GatewayConfig;
  logger: Logger;
  metrics: GatewayMetrics;
  rules: RulesService;
  limiter: RateLimiter;
  blocks: BlockService;
  detection: DetectionService;
  stats: StatsService;
}

export function createProxyRouter(deps: ProxyRouterDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!(deps.config.allowedMethods as readonly string[]).includes(req.method)) {
      res.setHeader("Allow", deps.config.allowedMethods.join(", "));
      next(new MethodNotAllowedError());
      return;
    }
    next();
  });

  // Raw body capture preserves arbitrary content types while bounding memory.
  router.use(
    express.raw({
      type: () => true,
      limit: deps.config.maxRequestBytes,
      inflate: false,
    }),
  );

  router.use(async (req, res, next) => {
    try {
      const requestId = requestIdFrom(res);
      const client = identifyClient(req, deps.config);
      const validated = validateProxyPath(
        req.originalUrl || req.url,
        deps.config.maxPathLength,
        deps.config.upstreamUrl,
      );
      const rules = await deps.rules.list();
      const rule = matchRateLimitRule(rules, validated.pathname);
      if (!rule) {
        throw new ServiceUnavailableError("No rate-limit rule is configured");
      }
      const endpoint = normalizeEndpoint(rules, validated.pathname);
      const started = Date.now();

      const blocked = await deps.blocks.isBlocked(client.clientId);
      if (blocked) {
        applyIsolationHeaders(res, rule.id, rule.limit, rule.windowSeconds, blocked);
        await deps.stats.record({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          status: 429,
          decision: "blocked",
          latencyMs: 0,
          violation: false,
          upstreamError: false,
        });
        deps.metrics.blocked.inc({ reason: "isolated" });
        deps.metrics.observeRequest({
          route: rule.id,
          method: req.method,
          status: 429,
          decision: "blocked",
          durationSeconds: 0,
        });
        await deps.detection.recordCooldownRequest({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          method: req.method,
          requestId,
          block: blocked,
        });
        deps.logger.info(
          { clientId: client.clientId, endpoint, requestId, reason: "isolated" },
          "request blocked during cooldown",
        );
        throw new TooManyRequestsError("Client is temporarily isolated", {
          reason: "isolated",
          ruleId: rule.id,
          retryAfterSeconds: blocked.remainingSeconds,
          blockExpiresAt: blocked.expiresAt,
        });
      }

      await deps.detection.observeRequest({
        clientId: client.clientId,
        maskedIp: client.maskedIp,
        endpoint,
        path: validated.pathname,
        method: req.method,
        requestId,
      });

      const decision = await deps.limiter.check(client.clientId, rule);
      applyRateLimitHeaders(res, decision);
      if (!decision.allowed) {
        const latencyMs = Date.now() - started;
        await deps.stats.record({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          status: 429,
          decision: "blocked",
          latencyMs,
          violation: true,
          upstreamError: false,
        });
        deps.metrics.blocked.inc({ reason: "rate_limit" });
        deps.metrics.violations.inc({ rule: rule.id });
        deps.metrics.observeRequest({
          route: rule.id,
          method: req.method,
          status: 429,
          decision: "blocked",
          durationSeconds: latencyMs / 1000,
        });

        const violation = await deps.detection.recordViolation({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          method: req.method,
          requestId,
          rule,
        });
        let retryAfter = decision.retryAfterSeconds;
        if (violation.block) {
          retryAfter = Math.max(retryAfter, violation.block.remainingSeconds);
          res.setHeader("X-EdgeGuard-Isolated", "true");
          res.setHeader("X-EdgeGuard-Block-Expires", violation.block.expiresAt);
          res.setHeader("Retry-After", String(retryAfter));
        }
        deps.logger.info(
          {
            clientId: client.clientId,
            endpoint,
            ruleId: rule.id,
            requestId,
            isolated: violation.isolated,
          },
          "rate limit exceeded",
        );
        throw new TooManyRequestsError("Rate limit exceeded", {
          reason: "rate_limit",
          ruleId: rule.id,
          limit: rule.limit,
          windowSeconds: rule.windowSeconds,
          retryAfterSeconds: retryAfter,
          isolated: violation.isolated,
          blockExpiresAt: violation.block?.expiresAt ?? null,
        });
      }

      let upstream;
      try {
        upstream = await upstreamRequest(validated.url, {
          method: req.method as Dispatcher.HttpMethod,
          headers: buildUpstreamHeaders(req, client.address, requestId),
          body: Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined,
          headersTimeout: deps.config.upstreamTimeoutMs,
          bodyTimeout: deps.config.upstreamTimeoutMs,
          maxRedirections: 0,
          signal: AbortSignal.timeout(deps.config.upstreamTimeoutMs),
        });
      } catch (error) {
        const latencyMs = Date.now() - started;
        const timedOut = isTimeoutError(error);
        const status = timedOut ? 504 : 502;
        deps.metrics.upstreamFailures.inc({ kind: timedOut ? "timeout" : "network" });
        deps.metrics.observeRequest({
          route: rule.id,
          method: req.method,
          status,
          decision: "error",
          durationSeconds: latencyMs / 1000,
        });
        await deps.stats.record({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          status,
          decision: "error",
          latencyMs,
          violation: false,
          upstreamError: true,
        });
        await deps.detection.recordUpstreamResult({ endpoint, ok: false, requestId });
        deps.logger.warn(
          {
            requestId,
            endpoint,
            error: error instanceof Error ? error.message : String(error),
          },
          "upstream request failed",
        );
        throw timedOut
          ? new GatewayTimeoutError()
          : new BadGatewayError("Upstream service is unavailable");
      }

      const latencyMs = Date.now() - started;
      const contentLength = headerNumber(upstream.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > deps.config.maxResponseBytes) {
        discardBody(upstream.body);
        deps.metrics.upstreamFailures.inc({ kind: "response_limit" });
        deps.metrics.observeRequest({
          route: rule.id,
          method: req.method,
          status: 502,
          decision: "error",
          durationSeconds: latencyMs / 1000,
        });
        await deps.stats.record({
          clientId: client.clientId,
          maskedIp: client.maskedIp,
          endpoint,
          status: 502,
          decision: "error",
          latencyMs,
          violation: false,
          upstreamError: true,
        });
        await deps.detection.recordUpstreamResult({ endpoint, ok: false, requestId });
        throw new BadGatewayError("Upstream response exceeded the configured size limit");
      }

      const status = upstream.statusCode;
      if (status < 200 || status > 599) {
        discardBody(upstream.body);
        deps.metrics.upstreamFailures.inc({ kind: "invalid_response" });
        throw new BadGatewayError("Upstream returned an invalid response status");
      }
      const upstreamError = status >= 500;
      if (upstreamError) deps.metrics.upstreamFailures.inc({ kind: "status_5xx" });

      await deps.stats.record({
        clientId: client.clientId,
        maskedIp: client.maskedIp,
        endpoint,
        status,
        decision: upstreamError ? "error" : "allowed",
        latencyMs,
        violation: false,
        upstreamError,
      });
      deps.metrics.observeRequest({
        route: rule.id,
        method: req.method,
        status,
        decision: upstreamError ? "error" : "allowed",
        durationSeconds: latencyMs / 1000,
      });
      await deps.detection.recordUpstreamResult({
        endpoint,
        ok: !upstreamError,
        requestId,
      });

      res.status(status);
      const responseHeaders = sanitizeResponseHeaders(
        upstream.headers as Record<string, string | string[] | undefined>,
      );
      for (const [name, value] of Object.entries(responseHeaders)) {
        res.setHeader(name, value);
      }
      res.setHeader("X-EdgeGuard-Rule", rule.id);
      res.setHeader("X-Request-Id", requestId);

      if (req.method === "HEAD" || status === 204 || status === 304) {
        discardBody(upstream.body);
        res.end();
        return;
      }

      let bytes = 0;
      let limitExceeded = false;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > deps.config.maxResponseBytes) {
            limitExceeded = true;
            callback(new Error("response size limit exceeded"));
            return;
          }
          callback(null, chunk);
        },
      });

      const onClientAbort = () => upstream.body.destroy();
      req.once("aborted", onClientAbort);
      try {
        await pipeline(upstream.body, limiter, res);
      } catch (error) {
        if (!res.writableEnded) res.destroy();
        if (limitExceeded) {
          deps.metrics.upstreamFailures.inc({ kind: "response_limit" });
          deps.logger.warn({ requestId, endpoint }, "upstream response exceeded size limit");
        } else if (!req.destroyed) {
          deps.metrics.upstreamFailures.inc({ kind: "response_stream" });
          deps.logger.warn(
            { requestId, endpoint, error: error instanceof Error ? error.message : String(error) },
            "upstream response stream failed",
          );
        }
      } finally {
        req.off("aborted", onClientAbort);
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function applyIsolationHeaders(
  res: Response,
  ruleId: string,
  limit: number,
  windowSeconds: number,
  block: { remainingSeconds: number; expiresAt: string },
): void {
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", "0");
  res.setHeader("RateLimit-Reset", String(Math.max(0, block.remainingSeconds)));
  res.setHeader("RateLimit-Policy", `${limit};w=${windowSeconds}`);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", "0");
  res.setHeader("X-RateLimit-Reset", String(Math.max(0, block.remainingSeconds)));
  res.setHeader("X-EdgeGuard-Rule", ruleId);
  res.setHeader("X-EdgeGuard-Isolated", "true");
  res.setHeader("X-EdgeGuard-Block-Expires", block.expiresAt);
  res.setHeader("Retry-After", String(Math.max(1, block.remainingSeconds)));
}

function discardBody(body: { destroy: () => void; on: (event: "error", listener: () => void) => void }): void {
  body.on("error", () => {
    // The body is intentionally discarded; suppress the resulting abort error.
  });
  body.destroy();
}

function headerNumber(value: string | string[] | undefined): number {
  if (Array.isArray(value)) return Number(value[0] ?? 0);
  return Number(value ?? 0);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name ?? "";
  const code = (error as { code?: string }).code ?? "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /TIMEOUT|ABORT/i.test(code)
  );
}


