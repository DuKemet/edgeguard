import { createHmac } from "node:crypto";
import type { Request } from "express";
import { maskIp } from "@edgeguard/shared";
import type { GatewayConfig } from "../config";

export interface ClientIdentity {
  clientId: string;
  maskedIp: string;
  /** Raw address is kept in memory only for forwarding; it is never logged or stored. */
  address: string;
}

export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("::ffff:")) return trimmed.slice(7);
  return trimmed;
}

export function clientIdForAddress(address: string, secret: string): string {
  return createHmac("sha256", secret).update(address).digest("hex").slice(0, 16);
}

/**
 * Express resolves req.ip using the configured trust-proxy policy. When trust
 * proxy is disabled, client-supplied X-Forwarded-For headers are ignored.
 */
export function identifyClient(req: Request, config: GatewayConfig): ClientIdentity {
  const raw = req.ip || req.socket.remoteAddress || "unknown";
  const address = normalizeAddress(raw);
  return {
    clientId: clientIdForAddress(address, config.clientHashSecret),
    maskedIp: maskIp(address),
    address,
  };
}
