# Security

EdgeGuard is a demonstration-grade platform built with production-shaped controls. This document
describes the threat model, implemented defenses, secret handling, and the limits that must be
addressed before a real deployment.

## Threat model

| Threat                                        | Primary controls                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Application-layer floods and scraping         | Per-client token buckets, burst caps, detection events, temporary isolation      |
| Credential stuffing on the admin login        | Bcrypt verification, uniform failure response, per-client login throttle         |
| Stolen or replayed dashboard token            | Short JWT TTL, issuer/audience validation, subject must still exist, RBAC         |
| SSRF through proxy targets                    | Fixed upstream origin, hostname allowlist, startup DNS/IP checks, private-IP ban  |
| Path traversal, encoded separators, smuggling | Multi-pass decoding checks, origin revalidation, method and size limits           |
| Header injection / response leakage           | Explicit request/response header filtering, hop-by-hop removal, CORS stripping    |
| Upstream abuse or resource exhaustion         | Timeouts, redirect disabling, request/response byte limits, no request inflation  |
| Sensitive data in telemetry                   | HMAC client IDs, masked IPs, bounded route labels, no raw IP Prometheus labels    |
| Redis outage causing lockout or total failure | Degraded local limiter, readiness signaling, explicit `REDIS_REQUIRED` option     |
| Container breakout or privilege escalation    | Non-root users, read-only root filesystems, dropped capabilities, seccomp profile |
| Brute-force scraping of `/metrics`            | Optional `METRICS_TOKEN` bearer requirement                                       |

Volume-based DDoS, TLS attacks, and network-layer flooding are outside the application boundary and
must be handled by an edge provider, load balancer, or ingress.

## Authentication and authorization

- Passwords are stored only as bcrypt hashes. No plaintext password is persisted or logged.
- Unknown usernames still perform a bcrypt comparison against a dummy hash to reduce timing leakage.
- Login failures are counted per pseudonymous client ID. Ten failures within 15 minutes produce a
  `429` with `Retry-After`. A successful login resets the counter.
- JWTs use HS256 with a configured secret of at least 32 characters, explicit issuer and audience,
  a subject, an expiry, and a role claim. Verification pins the algorithm and rejects tokens for
  users that no longer exist.
- Routes that mutate state (`POST/PUT/DELETE` rules, settings, unblock) require the `admin` role.
  Viewers can read all dashboards and configuration.
- The dashboard keeps the token in `sessionStorage` rather than `localStorage`. It is still readable
  by same-origin JavaScript, so XSS prevention is essential.

## Request validation and SSRF boundary

The upstream origin is fixed at startup. `UPSTREAM_URL` must be `http` or `https`, must not include
credentials, a fragment, or a path, and its hostname must appear in `UPSTREAM_ALLOWED_HOSTS`.
Startup resolves the hostname and rejects private, loopback, link-local, documentation, multicast,
and otherwise non-public addresses unless `ALLOW_PRIVATE_UPSTREAMS=true` is explicitly set.

Every proxy request is validated independently:

- Only configured HTTP methods are accepted.
- The target must be an absolute path without a fragment or protocol-relative form.
- Control characters, encoded separators (`%2f`, `%5c`, `%00`), invalid percent-encoding, repeated
  separators, backslashes, and traversal segments are rejected after up to three decode passes.
- The final constructed URL is compared against the fixed upstream origin.
- Requests and responses are bounded by `MAX_REQUEST_BYTES` and `MAX_RESPONSE_BYTES`.
- Upstream redirects are disabled, and connect/body/headers timeouts are enforced.
- Request bodies are not decompressed (`inflate: false`), avoiding compression bombs.

`ALLOW_PRIVATE_UPSTREAMS=true` is required for the local Compose stack because the demo API resolves
to a private container address. Do not enable it for an internet-facing gateway.

## Rate limiting and isolation

The Redis Lua token bucket is atomic and uses Redis server time, so replicas cannot race or disagree
because of clock skew. Capacity is `limit + burst`; the refill rate is `limit / window`. Keys expire
after three windows. Client IDs are HMAC-SHA-256 truncations of the resolved address, never raw IPs.

Detection evaluates rolling five-second counters for global, client, and endpoint rates, repeated
violations, upstream error ratios, and cooldown abuse. Events include observed values, thresholds,
masked addresses, severities, actions, and expiry so operators can explain every decision. Event
writes are suppressed briefly to prevent event floods.

Isolation is a TTL block. It expires automatically; administrators can lift it early, and that action
is recorded as an `admin_unblock` event. During a Redis outage, the block list also lives in a
bounded per-process map and the limiter falls back to a bounded local map. This preserves local
availability but is **not globally consistent** across replicas while degraded.

## Data handling

- Raw client addresses are used only in request memory for upstream forwarding.
- Stored events and blocks use masked addresses; analytics and metrics use pseudonymous client IDs
  or bounded route labels.
- Prometheus labels exclude raw IPs, query strings, tokens, and full URLs.
- Request logs include request ID, method, path, status, and duration. Authentication headers and
  passwords are not logged. Failed logins log only the attempted username and never the password.
- Redis contains enforcement state and analytics, not upstream response payloads or admin passwords.
- JWT secrets, password hashes, and client-hash secrets must never be committed. `.env` and
  `infra/kubernetes/secret.yaml` are ignored; only examples are tracked.

## Secrets and deployment configuration

Generate secrets independently:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run hash-password -- "a-long-unique-password"
```

Store them in a secret manager for Kubernetes (`edgeguard-secrets`), not in the ConfigMap. Rotate
`JWT_SECRET` to invalidate all active sessions. Rotating `CLIENT_HASH_SECRET` resets pseudonymous
client continuity, so active blocks and limits effectively start over.

The gateway rejects short or placeholder JWT secrets and malformed bcrypt hashes. Compose requires
`JWT_SECRET` and `ADMIN_PASSWORD_HASH`; bcrypt hashes must be single-quoted so Compose does not
expand `$`.

## Container and transport hardening

- Gateway, demo API, and Redis run as non-root with read-only root filesystems, dropped
  capabilities, and `no-new-privileges` where supported.
- Kubernetes pods set `runAsNonRoot`, `RuntimeDefault` seccomp, read-only root filesystems, and
  resource requests/limits. Network policies deny ingress by default and allow only gateway,
  dashboard, demo, Redis, and monitoring paths.
- Nginx serves the SPA with CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Cross-Origin-Opener-Policy`, and a restrictive `Permissions-Policy`.
- TLS is intentionally not terminated in this repository. Put the gateway and dashboard behind an
  ingress or load balancer that terminates TLS, redirects HTTP, and sets HSTS.

## Known limitations

- Detection is deterministic thresholding, not adaptive or reputation-based.
- The local Redis fallback is per replica; limits are weaker during an outage.
- Dashboard authentication uses bearer tokens in `sessionStorage`, not httpOnly cookies with CSRF
  protection. A strict CSP reduces but does not eliminate XSS impact.
- There is no multi-factor authentication, account lockout by username, or audit log export.
- Admin login is throttled per client ID; distributed credential stuffing from many addresses can
  still consume bcrypt CPU.
- In-memory block and limiter maps are bounded by simple pruning, not a dedicated cache.
- Compose publishes the demo API on port `4000` so the difference between direct and proxied
  access is visible. Do not publish the upstream in a real deployment; only the gateway should be
  reachable from untrusted networks.
- `.env.example` contains demonstration credentials and secrets. They must be replaced before any
  shared or internet-facing deployment.
- Kubernetes manifests are static references, not a complete platform. Use a managed Redis or a
  replicated deployment for availability, and validate policies against your ingress controller.

## Reporting

This is a demonstration project. If you adapt it, add a security contact, dependency scanning,
signed images, and a vulnerability disclosure process before production use.
