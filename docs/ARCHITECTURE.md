# Architecture

## System overview

```text
Browser
  |
  v
Dashboard container (Nginx :8081 host -> :8080 container)
  |-- static SPA
  |-- /api/admin/* -> gateway /admin/*
  v
Gateway :8080
  |-- auth + RBAC (JWT, bcrypt)
  |-- rate limiting (atomic Redis Lua token bucket)
  |-- detection + temporary isolation
  |-- traffic/event aggregation
  |-- Prometheus /metrics
  |
  +--> Redis :6379                 shared enforcement and analytics state
  |
  +--> fixed upstream origin       demo API :4000 (/api/*, /metrics)
                                     ^
Prometheus :9090 --------------------+----------------------+
  |                                                          |
  v                                                          |
Grafana :3000 (provisioned EdgeGuard Overview)               |
                                                   Dashboard polls admin API
```

The gateway is the only component that talks to the upstream. The dashboard talks only to admin
APIs. Prometheus scrapes both services; Grafana reads Prometheus.

## Packages

| Path                | Responsibility                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `apps/gateway`      | Proxy, enforcement, detection, admin API, health, metrics, Redis services      |
| `apps/demo-api`     | Deterministic upstream endpoints, simulated failures, Prometheus metrics       |
| `apps/dashboard`    | Login, overview, traffic, events, configuration, polling, charts               |
| `packages/shared`   | Contract types, Zod schemas, defaults, rule matching, token bucket, formatting |
| `tools/loadgen`     | Bounded traffic patterns for demos and load checks                             |
| `infra`             | Prometheus, Grafana, Nginx, Kubernetes manifests                               |
| `scripts`           | Password hashing, static manifest validation                                   |

## Proxy request pipeline

1. **Request ID** middleware assigns or preserves `X-Request-Id`.
2. **Method allowlist** rejects methods outside `ALLOWED_METHODS` with `405` and an `Allow` header.
3. **Raw body capture** reads any content type with a hard byte limit and no decompression.
4. **Client identity** uses Express `req.ip` under the configured trust-proxy policy. The address
   is normalised and hashed with HMAC-SHA-256 (`CLIENT_HASH_SECRET`) into a 16-character client ID.
   Raw addresses are held only in request memory for upstream forwarding; display uses a masked IP.
5. **Path validation** rejects:
   - non-absolute targets, fragments, and protocol-relative paths
   - control characters, single-encoded separators (`%2f`, `%5c`, `%00`), invalid encoding
   - traversal after up to three decode passes, backslashes, repeated separators
   - targets longer than `MAX_PATH_LENGTH`
   - any final URL whose origin differs from the fixed upstream origin
6. **Rule selection** uses the most specific enabled rule: exact match first, then longest prefix,
   then the `*` fallback. Missing rules return `503` rather than silently allowing traffic.
7. **Isolation check** returns `429` with `Retry-After`, `X-EdgeGuard-Isolated`, and
   `X-EdgeGuard-Block-Expires` while a client block is active. Requests during cooldown feed
   cooldown-abuse detection.
8. **Observation** increments per-client, per-endpoint, and global 5-second counters, evaluates
   detection thresholds, and emits suppressed, explainable events.
9. **Rate limit** runs the Redis token bucket. Allowed requests receive `RateLimit-*` and
   `X-RateLimit-*` headers. Violations return `429` and may create an isolation block.
10. **Proxy** forwards to the configured origin with redirects disabled, bounded timeouts, request
    header filtering, and a response byte limit. Hop-by-hop, forwarding, server, CORS, and
    `X-EdgeGuard-*` headers are not copied blindly.
11. **Record** updates 10-second traffic buckets, client aggregates, latency histograms, events, and
    Prometheus metrics. Errors use a stable JSON envelope containing the request ID.

## Rate limiting

Each `(clientId, ruleId)` pair has one Redis hash holding token state. The Lua script executes
atomically with Redis server time:

```text
capacity = limit + burst
rate     = limit / window
tokens   = min(capacity, tokens + elapsed * rate)
allow    = tokens >= 1
tokens   = tokens - 1
```

The key expires after `max(2s, 3 * window)`. Because time comes from Redis and the script is atomic,
multiple gateway replicas share one consistent view. Redis errors fall back to a bounded in-process
map using the same pure algorithm; fallback decisions are per instance and increment
`edgeguard_gateway_redis_fallback_total`.

## Detection and isolation

Detection uses rolling 5-second buckets with configurable thresholds. Events record observed value,
threshold, unit, masked client, endpoint, action, severity, suppression metadata, and expiry. Writes
are suppressed for `suppressionSeconds` per category/target to avoid event floods.

| Category               | Default trigger                                      | Typical action    |
| ---------------------- | ---------------------------------------------------- | ----------------- |
| `traffic_spike`        | Global RPS >= 3x previous window and >= 20 RPS       | record            |
| `high_client_rate`     | Client >= 6 RPS within the detection window          | record            |
| `endpoint_flood`       | Endpoint >= 15 RPS within the detection window       | record            |
| `rate_limit_violation` | >= 5 violations by one client in 60s                 | isolate           |
| `upstream_error_spike` | Upstream error ratio >= 0.25 with >= 10 samples      | record            |
| `cooldown_abuse`       | >= 10 requests while isolated                        | extend/re-isolate |
| `admin_unblock`        | Administrator lifts a block                          | audit event       |

Severity scales with the observed-to-threshold ratio (`low`, `medium`, `high`, `critical`).
Isolation is a Redis TTL key plus a sorted-set index for active-block listing. Blocks expire
automatically; admins can lift them early. A bounded in-memory copy keeps blocks visible during
Redis outages.

## Redis key layout

With `REDIS_PREFIX=edgeguard`:

| Key                                   | Type       | Purpose                                 |
| ------------------------------------- | ---------- | --------------------------------------- |
| `edgeguard:rl:<clientId>:<ruleId>`    | hash       | Token bucket (`tokens`, `ts`)            |
| `edgeguard:block:<clientId>`          | string TTL | Active isolation JSON                   |
| `edgeguard:blocks`                    | sorted set | Active block expiry index               |
| `edgeguard:events`                    | list       | Security events, trimmed to 7 days      |
| `edgeguard:det:<kind>:<id>:<bucket>`  | string TTL | 5-second detection counters             |
| `edgeguard:stats:<bucket>`            | hash       | 10-second traffic aggregates            |
| `edgeguard:totals`                    | hash       | Window totals                           |
| `edgeguard:client:<clientId>`         | hash TTL   | Client metadata, 24 hours               |
| `edgeguard:rules`                     | string     | Rule set JSON                           |
| `edgeguard:settings`                  | string     | Detection settings JSON                 |
| `edgeguard:login:<clientId>`          | string TTL | Failed-login throttle                   |

`STATS_RETENTION_SECONDS` is 6 hours; events are retained for 7 days. Endpoint and route labels are
normalised to rule IDs or `other`.

## Admin API

All routes are under `/admin`; everything except login requires a bearer token.

| Method   | Path                        | Role   | Purpose                                   |
| -------- | --------------------------- | ------ | ----------------------------------------- |
| `POST`   | `/auth/login`               | public | Issue JWT after bcrypt verification       |
| `GET`    | `/auth/me`                  | any    | Current user                              |
| `GET`    | `/overview`                 | any    | 60-second totals, latency, blocks, events |
| `GET`    | `/traffic`                  | any    | Buckets, endpoints, clients, blocks       |
| `GET`    | `/events`                   | any    | Filtered, paginated security events       |
| `GET`    | `/clients`                  | any    | Client aggregates and active blocks       |
| `GET`    | `/rules`                    | any    | Rate-limit rules                          |
| `POST`   | `/rules`                    | admin  | Create rule                               |
| `PUT`    | `/rules/:id`                | admin  | Update rule                               |
| `DELETE` | `/rules/:id`                | admin  | Delete rule                               |
| `GET`    | `/settings`                 | any    | Detection settings                        |
| `PUT`    | `/settings`                 | admin  | Update detection settings                 |
| `POST`   | `/clients/:id/unblock`      | admin  | Lift an isolation early                   |

JWT tokens are HS256, issuer/audience checked, expire after `TOKEN_TTL_SECONDS`, and are rejected
if the subject is no longer configured. Login failures are throttled per client ID.

## Dashboard

The SPA stores its token in `sessionStorage` and polls admin endpoints every five seconds. It has
explicit loading, empty, and error states. A `401` clears the token and emits an auth-expired event
that returns the UI to login. Configuration is editable only for the admin role; viewers see a
read-only badge. Nginx serves immutable hashed assets, disables caching for `index.html`, and
reverse-proxies `/api/admin/` to the gateway.

## Metrics

Gateway metrics (default service label `edgeguard-gateway`):

- `edgeguard_gateway_requests_total{route,method,status,decision}`
- `edgeguard_gateway_request_duration_seconds{route,method,decision}`
- `edgeguard_gateway_blocked_total{reason}`
- `edgeguard_gateway_rate_limit_violations_total{rule}`
- `edgeguard_gateway_upstream_failures_total{kind}`
- `edgeguard_gateway_redis_errors_total{operation}`
- `edgeguard_gateway_redis_fallback_total`
- `edgeguard_gateway_redis_up`, `edgeguard_gateway_active_blocks`
- `edgeguard_gateway_detection_events_total{category,severity}`
- standard Node.js process/runtime metrics with the `edgeguard_gateway_` prefix

Demo metrics use the `edgeguard_demo_` prefix. Labels never contain raw IP addresses, full URLs,
query strings, or tokens. `/metrics` can require a bearer token through `METRICS_TOKEN`; when set,
Prometheus must be configured with matching credentials.

## Failure behavior

| Failure                       | Behavior                                                                 |
| ----------------------------- | ------------------------------------------------------------------------ |
| Redis unavailable             | Serve with bounded local limiter; readiness `503` unless `REDIS_REQUIRED=false`; metrics increment |
| Redis required at startup     | Process exits instead of starting degraded                               |
| Upstream timeout/network      | `504` or `502`, upstream failure metric, traffic recorded as error       |
| Upstream response too large   | Proxy aborts the response and returns an error                           |
| Rule set empty                | `503` for proxied traffic; admin UI still works                          |
| Invalid config                | Process exits with a clear configuration error before binding the port   |
| Login brute force             | Per-client failure throttle returns `429` with `Retry-After`             |

## Deployment topology

Docker Compose runs Redis, demo API, gateway, dashboard, Prometheus, and Grafana with health checks,
non-root application images, read-only root filesystems, dropped capabilities, and named volumes.
Kubernetes manifests provide two gateway replicas, an HPA, a disruption budget, probes, resource
requests/limits, read-only root filesystems, secret references, a Redis StatefulSet, and
ingress-restricting network policies. TLS termination is expected at an ingress or load balancer;
neither stack terminates TLS itself.

Prometheus scrapes every five seconds and evaluates availability, Redis, upstream-failure,
block-rate, isolation, and latency alerts. The provisioned Grafana overview shows request decisions,
block reasons, detection categories, latency percentiles, upstream failures, top routes, and demo
API health.
