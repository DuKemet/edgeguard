# EdgeGuard

EdgeGuard is a production-inspired API protection platform. It puts a reverse proxy in front of
an upstream API to enforce distributed rate limits, detect abusive traffic, temporarily isolate
clients, surface explainable security events, and expose operational metrics. A React dashboard
provides live traffic, event, and configuration views.

The demo upstream is intentionally simple; the value is the gateway pipeline, its Redis-backed
state, the admin surface, the tests, and the deployment tooling.

## Stack

- Node.js 22, TypeScript, npm workspaces
- Express gateway and demo API
- Redis 7 with atomic Lua token buckets
- Zod contracts shared across services
- React 18, Vite, Recharts, React Router
- Prometheus and provisioned Grafana dashboard
- Docker Compose and Kubernetes manifests
- Vitest, Supertest, ESLint, GitHub Actions

## Quick start with Docker Compose

Prerequisites: Docker with Compose v2.

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

| Service    | URL                     | Notes                                      |
| ---------- | ----------------------- | ------------------------------------------ |
| Dashboard  | http://localhost:8081   | Sign in with the credentials below         |
| Gateway    | http://localhost:8080   | Proxy, admin API, `/metrics`, `/health`    |
| Demo API   | http://localhost:4000   | Direct access for comparison and `/metrics` |
| Prometheus | http://localhost:9090   | Scrapes gateway and demo API every 5s      |
| Grafana    | http://localhost:3000   | `admin` / `edgeguard-admin` by default     |

The example environment creates two accounts:

- `admin` / `edgeguard-demo` (read/write, can edit rules and unblock clients)
- `viewer` / `edgeguard-viewer` (read-only)

These credentials and all secrets in `.env.example` are for local demonstration only. Rotate them
before exposing the stack. Generate a new hash with:

```bash
npm run hash-password -- "a-long-password"
```

Put the hash in `ADMIN_PASSWORD_HASH`. Keep bcrypt values single-quoted in `.env` because Compose
interprets `$` characters.

The gateway refuses to start in production if `JWT_SECRET` is shorter than 32 characters or still
contains a placeholder, or if password hashes are not valid bcrypt strings.

## Local development

Prerequisites: Node.js 22 and Redis on `127.0.0.1:6379`.

```bash
npm install
docker run --rm -d --name edgeguard-redis -p 6379:6379 redis:7-alpine
cp apps/gateway/.env.example apps/gateway/.env
npm run dev
```

PowerShell equivalents:

```powershell
Copy-Item apps/gateway/.env.example apps/gateway/.env
npm run dev
```

The dashboard runs at http://localhost:5173 and proxies `/api/admin` to the gateway. The demo API
runs on port 4000 and the gateway on port 8080.

If Redis is stopped, the gateway stays available with a bounded in-process fallback limiter, marks
`/health/ready` as `degraded`, and increments Redis fallback metrics. Set `REDIS_REQUIRED=true` to
fail readiness instead.

## Generate traffic

The load generator is bounded by duration, concurrency, request count, and timeout.

```bash
# Mixed allowed, abusive, and failing traffic
LOADGEN_PATTERN=mixed LOADGEN_DURATION=30 npm run loadgen

# Stay under limits
LOADGEN_PATTERN=allowed LOADGEN_DURATION=20 npm run loadgen

# Trigger rate limits, detections, and temporary isolation
LOADGEN_PATTERN=abuse LOADGEN_DURATION=30 LOADGEN_CONCURRENCY=12 LOADGEN_DELAY_MS=10 npm run loadgen
```

PowerShell:

```powershell
$env:LOADGEN_PATTERN="abuse"
$env:LOADGEN_DURATION="30"
$env:LOADGEN_CONCURRENCY="12"
$env:LOADGEN_DELAY_MS="10"
npm run loadgen
```

| Variable                | Default                 | Description                              |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `LOADGEN_URL`           | `http://127.0.0.1:8080` | Gateway base URL                         |
| `LOADGEN_PATTERN`       | `mixed`                 | `mixed`, `allowed`, `abuse`, `errors`    |
| `LOADGEN_DURATION`      | `30`                    | Seconds, 5-600                           |
| `LOADGEN_CONCURRENCY`   | `8`                     | Workers, 1-64                            |
| `LOADGEN_MAX_REQUESTS`  | `20000`                 | Global request cap                       |
| `LOADGEN_TIMEOUT_MS`    | `5000`                  | Per-request timeout                      |
| `LOADGEN_DELAY_MS`      | `25`                    | Delay per worker after each request      |

See [docs/DEMO.md](docs/DEMO.md) for a full walkthrough of allowed, blocked, isolation, and
recovery states, including admin API calls.

## Verify locally

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run validate:manifests
```

`npm run verify` runs all of the above. Redis-backed gateway integration tests use
`TEST_REDIS_URL` (default `redis://127.0.0.1:6379`) and skip with a warning when Redis is
unreachable. Start Redis first for complete coverage.

CI additionally audits production dependencies with `npm audit --omit=dev --audit-level=high`,
validates the Compose configuration, and builds all three container images.

Docker Compose validation and image builds:

```bash
cp .env.example .env
docker compose config --quiet
docker compose build
```

## Configuration

The gateway reads environment variables (and `apps/gateway/.env` in local development). The most
important ones:

| Variable                  | Default                  | Purpose                                              |
| ------------------------- | ------------------------ | ---------------------------------------------------- |
| `PORT`                    | `8080`                   | Gateway listen port                                  |
| `REDIS_URL`               | `redis://127.0.0.1:6379` | Shared state                                         |
| `REDIS_REQUIRED`          | `false`                  | Fail readiness and startup when Redis is unavailable |
| `UPSTREAM_URL`            | `http://127.0.0.1:4000`  | Fixed upstream origin                                |
| `UPSTREAM_ALLOWED_HOSTS`  | upstream hostname        | Allowlist; must include the upstream host            |
| `ALLOW_PRIVATE_UPSTREAMS` | `false`                  | Allow private upstream addresses (local only)        |
| `JWT_SECRET`              | required                 | At least 32 characters                               |
| `ADMIN_USERNAME`          | `admin`                  | Admin account                                        |
| `ADMIN_PASSWORD_HASH`     | required                 | Bcrypt hash                                          |
| `VIEWER_USERNAME`         | unset                    | Optional read-only account                           |
| `VIEWER_PASSWORD_HASH`    | unset                    | Required with viewer username                        |
| `CLIENT_HASH_SECRET`      | `JWT_SECRET`             | HMAC key for pseudonymous client IDs                 |
| `CORS_ORIGINS`            | local dashboard origins  | Comma-separated browser origins                      |
| `TRUST_PROXY`             | `false`                  | Express trust-proxy policy; Compose uses `1`         |
| `METRICS_TOKEN`           | unset                    | Optional bearer token for `/metrics`                 |

See `.env.example` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete surface.

## Repository layout

```text
apps/
  gateway/       Express proxy, limiter, detection, admin API, tests
  demo-api/      Upstream demo service and metrics
  dashboard/     React SPA, polling, charts, configuration editor
packages/
  shared/        Types, Zod schemas, rule matching, token bucket, formatting
tools/
  loadgen/       Bounded traffic generator
infra/
  prometheus/    Scrape and alert configuration
  grafana/       Provisioned datasource and dashboard
  nginx/         Dashboard reverse proxy configuration
  kubernetes/    Namespace, workloads, services, HPA, PDB, network policies
scripts/         Password hashing, manifest validation
docs/            Architecture, security, demo, troubleshooting
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): request pipeline, Redis model, detection, admin API, metrics
- [Security](docs/SECURITY.md): threat model, controls, secret handling, known limitations
- [Demo](docs/DEMO.md): scripted walkthrough of enforcement and recovery
- [Troubleshooting](docs/TROUBLESHOOTING.md): common startup, Redis, Compose, and UI issues

## License

MIT
