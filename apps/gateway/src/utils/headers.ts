import type { Request } from "express";

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
  "expect",
]);

const OMITTED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "server",
  "x-powered-by",
]);

export function buildUpstreamHeaders(
  req: Request,
  clientAddress: string,
  requestId: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-forwarded-") || lower === "forwarded") continue;
    if (lower.startsWith("x-edgeguard-")) continue;
    headers[lower] = value;
  }
  headers["x-forwarded-for"] = clientAddress;
  headers["x-forwarded-proto"] = req.protocol;
  headers["x-request-id"] = requestId;
  return headers;
}

export function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (OMITTED_RESPONSE_HEADERS.has(lower)) continue;
    if (lower.startsWith("access-control-") || lower.startsWith("x-edgeguard-")) continue;
    result[lower] = value;
  }
  return result;
}
