export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "BAD_REQUEST", message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message = "HTTP method is not allowed") {
    super(405, "METHOD_NOT_ALLOWED", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body is too large") {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, details?: unknown) {
    super(429, "RATE_LIMITED", message, { details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(503, "SERVICE_UNAVAILABLE", message);
  }
}

export class BadGatewayError extends AppError {
  constructor(message = "Upstream service failed") {
    super(502, "BAD_GATEWAY", message);
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message = "Upstream service timed out") {
    super(504, "GATEWAY_TIMEOUT", message);
  }
}
