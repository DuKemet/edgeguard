# EdgeGuard Implementation Plan

## Repository assessment

The repository was empty at project start (no Git metadata, source files, manifests, Docker
configuration, or tests). EdgeGuard is therefore initialized as a clean npm-workspaces monorepo.
No pre-existing code needed to be preserved.

Verified environment at start:

- Node.js `v22.19.0`, npm `11.6.2`
- Docker engine `29.8.1` (started Docker Desktop during setup) and Docker Compose `v5.5.1`
- Redis is not installed on the host; verification uses `redis:7-alpine` in Docker on port
  `6379`. Production and integration tests use the same Redis protocol, scripts, and TTL behavior.

## Architecture

```
Browser (React dashboard)
        |
        v
Nginx dashboard container :8081  ---> static SPA + /api/admin reverse proxy
        |
        v
EdgeGuard gateway :8080
  |-- admin/auth API (JWT, RBAC, Zod validation)
  |-- token-bucket rate limiter (atomic Redis Lua, local fallback)
  |-- detection engine (rolling Redis counters, explainable rules)
  |-- temporary client isolation (Redis TTL keys)
  |-- traffic/event aggregation (Redis time buckets)
  |-- Prometheus /metrics
        |
        +--> Redis :6379
        +--> configured upstream (demo API :4000)
                    |
                    +--> /metrics

Prometheus :9090 ---> gateway + demo API
Grafana :3000    ---> provisioned dashboard
```

Key decisions:

- **Token bucket via Lua** for rate limiting. It needs O(1) state per client/rule, atomically
  refills and consumes tokens, supports burst capacity (`limit + burst`), and avoids race
  conditions across gateway replicas. The pure algorithm is unit-tested with a fake clock.
- **Redis is the shared source of truth.** Rate-limit state, isolation blocks, detection
  counters, events, rules, settings, and dashboard aggregates all live in Redis. Multiple gateway
  instance tests prove consistent enforcement.
- **Fail-open with visibility for Redis outages.** If Redis is unreachable, the gateway keeps
  serving using a bounded in-process limiter while `/health/ready` returns `503`, Redis error
  metrics increment, and the degraded state is logged. This favors availability while making the
  failure explicit. `REDIS_REQUIRED=true` can make readiness fail closed for scheduling purposes.
- **Dashboard reads only real gateway/admin data.** Polling keeps the UI live; there is no
  hardcoded metric data. Empty/loading/error states are implemented.
- **No Prometheus labels with raw IPs, URLs, or tokens.** Route labels are normalized to
  configured rule IDs or `other`; client IDs are truncated SHA-256 values shown only outside
  Prometheus.

## Milestones and acceptance criteria

### Milestone 1 - Structure and contracts

- npm workspaces for `apps/*`, `packages/*`, `tools/*`.
- Shared TypeScript contracts, Zod schemas, default rules and detection thresholds.
- Acceptance: root typecheck/lint configuration resolves all workspaces; plan committed.

### Milestone 2 - Gateway, demo API, distributed limiting

- Reverse proxy with explicit upstream allowlist, SSRF checks, path/method/size validation,
  timeouts, and header hygiene.
- Atomic Redis Lua token bucket with burst, window, remaining/reset/Retry-After headers.
- Demo API endpoints and Prometheus metrics.
- Unit and Redis-backed integration tests.
- Acceptance: below-limit succeeds; over-limit returns 429; two gateway instances share counters;
  malformed/unsafe requests rejected; Redis failure is controlled.

### Milestone 3 - Detection, isolation, administration

- Six explainable event categories, suppression windows, severity, observed vs threshold,
  actions and expiry.
- Temporary isolation with TTL, cooldown-abuse detection, automatic recovery, admin unblock.
- JWT authentication, bcrypt password verification, role checks, login throttling, RBAC.
- Admin overview/traffic/events/clients/rules/settings APIs with pagination and validation.
- Acceptance: bursts create events and blocks; isolation expires/recoverable; admin endpoints
  reject missing/invalid/viewer credentials; dashboard aggregates match actual request counts.

### Milestone 4 - Dashboard

- Dark responsive SPA with Overview, Traffic, Events, Configuration, login.
- Recharts visualizations fed by admin APIs, polling, filters, pagination, rule editing, threshold
  tuning, active blocks and unblock action.
- Acceptance: production build succeeds; values match backend response schema; no hardcoded data.

### Milestone 5 - Observability and local stack

- Prometheus metrics and scrape config, Grafana provisioning and dashboard, Docker Compose stack,
  health checks, non-root containers, bounded load generator.
- Acceptance: compose config validates; images build; metrics scraped; demo generates allowed,
  blocked, event, isolation and recovery states.

### Milestone 6 - Deployment, CI, docs, hardening

- Kubernetes manifests (deployments, services, configmaps, secret references, probes, resources,
  security contexts, HPA, network policies), GitHub Actions CI, security documentation and full
  setup/demo/troubleshooting documentation.
- Acceptance: YAML parses and resource references are consistent; CI mirrors local verification;
  `README`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEMO.md` are complete and accurate.

## Testing strategy

- **Shared unit tests:** rule matching, token-bucket math with fake clock, histogram percentiles.
- **Gateway unit tests:** config/SSRF validation, header hygiene, masking, auth helpers.
- **Gateway integration tests:** real Redis container/CI service, in-process upstream, Supertest:
  allowed, limited, multi-instance, expiry (controlled key mutation), isolation, unblock,
  unauthorized viewers/admins, malformed paths, unsafe upstreams, upstream failures, Redis outage,
  admin aggregates, `/metrics`.
- **Demo API tests:** endpoint responses and metrics.
- **Dashboard tests:** formatters and API client behavior.
- **CI:** Redis service container, install, lint, typecheck, test, build, Docker build validation.

## Known limitations (planned)

- Detection is deterministic thresholding, not adaptive ML; thresholds are tunable at runtime.
- Dashboard polling is 5 seconds; it is near-real-time rather than websocket streaming.
- Redis outage fallback is per-instance, so limits are not globally consistent while degraded.
- Local HTTP only; TLS termination is expected at a load balancer / ingress in production.
- Kubernetes manifests are validated statically; no cluster is assumed available locally.
- AWS deployment is documented only; no cloud resources are created or required.
