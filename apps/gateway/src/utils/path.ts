import { BadRequestError } from "../errors";

export interface ValidatedPath {
  url: URL;
  pathname: string;
  pathWithQuery: string;
}

/**
 * Rejects malformed or ambiguous request targets. The upstream origin is fixed
 * at startup, and the final URL is checked against that origin again.
 */
export function validateProxyPath(raw: string, maxLength: number, upstreamBase: string): ValidatedPath {
  if (!raw || !raw.startsWith("/")) {
    throw new BadRequestError("Request target must be an absolute path");
  }
  if (raw.length > maxLength) {
    throw new BadRequestError("Request path is too long");
  }
  if (raw.startsWith("//") || raw.includes("#")) {
    throw new BadRequestError("Request target is not allowed");
  }
  // eslint-disable-next-line no-control-regex -- control characters must be rejected
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new BadRequestError("Request target contains control characters");
  }
  if (/%(2f|5c|00)/i.test(raw)) {
    throw new BadRequestError("Encoded path separators are not allowed");
  }

  let decoded = raw;
  for (let index = 0; index < 3; index += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new BadRequestError("Request target contains invalid percent-encoding");
    }
  }
  if (
    decoded.includes("\\") ||
    // eslint-disable-next-line no-control-regex -- decoded control characters must be rejected
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split("/").some((segment) => segment === "..")
  ) {
    throw new BadRequestError("Request target contains path traversal characters");
  }

  const queryIndex = raw.indexOf("?");
  const pathname = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  if (pathname.includes("//")) {
    throw new BadRequestError("Repeated path separators are not allowed");
  }

  let url: URL;
  try {
    url = new URL(raw, upstreamBase);
  } catch {
    throw new BadRequestError("Invalid request target");
  }
  const base = new URL(upstreamBase);
  if (url.origin !== base.origin) {
    throw new BadRequestError("Request target cannot change the upstream origin");
  }

  return { url, pathname, pathWithQuery: raw };
}
