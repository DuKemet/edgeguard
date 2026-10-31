import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors";
import type { Logger } from "../logger";

export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};

export function requestLogMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const payload = {
        requestId: res.locals.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      };
      if (res.statusCode >= 500) logger.warn(payload, "request failed");
      else logger.debug(payload, "request completed");
    });
    next();
  };
}

export function notFoundHandler(message = "Route not found"): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError(404, "NOT_FOUND", message));
  };
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (res.headersSent) {
      logger.error({ err: error }, "error after response headers were sent");
      return;
    }
    const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";

    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          requestId,
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      (error as { type?: string }).type === "entity.too.large"
    ) {
      res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large",
          requestId,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({
        error: {
          code: "INVALID_BODY",
          message: "Request body could not be parsed",
          requestId,
        },
      });
      return;
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) logger.error({ err: error, requestId }, "request error");
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : "Request failed",
          requestId,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }

    logger.error({ err: error, requestId }, "unhandled request error");
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId,
      },
    });
  };
}
