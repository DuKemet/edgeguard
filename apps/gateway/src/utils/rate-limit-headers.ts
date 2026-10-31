import type { Response } from "express";
import type { LimitDecision } from "../services/limiter";

export function applyRateLimitHeaders(response: Response, decision: LimitDecision): void {
  response.setHeader("RateLimit-Limit", String(decision.limit));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, decision.remaining)));
  response.setHeader("RateLimit-Reset", String(Math.max(0, decision.resetAfterSeconds)));
  response.setHeader("RateLimit-Policy", `${decision.limit};w=${decision.rule.windowSeconds}`);
  response.setHeader("X-RateLimit-Limit", String(decision.limit));
  response.setHeader("X-RateLimit-Remaining", String(Math.max(0, decision.remaining)));
  response.setHeader("X-RateLimit-Reset", String(Math.max(0, decision.resetAfterSeconds)));
  response.setHeader("X-EdgeGuard-Rule", decision.rule.id);
  if (decision.degraded) response.setHeader("X-EdgeGuard-Redis", "degraded");
  if (!decision.allowed) {
    response.setHeader("Retry-After", String(Math.max(1, decision.retryAfterSeconds)));
  }
}
