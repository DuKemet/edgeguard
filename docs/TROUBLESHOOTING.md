# Troubleshooting

## The gateway exits with a configuration error

The gateway validates configuration before binding the port. Common messages:

| Message                                             | Fix                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `JWT_SECRET must be at least 32 characters`         | Generate a longer secret                                                 |
| `JWT_SECRET still contains a placeholder value`     | Replace `change-me`/`replace-me`/`example` values in production          |
| `ADMIN_PASSWORD_HASH must be a bcrypt hash`         | Use `npm run hash-password -- "password"` and quote the result            |
| `UPSTREAM_ALLOWED_HOSTS must include ...`           | Add the upstream hostname to the comma-separated allowlist                |
| `UPSTREAM_URL resolves to a private address`        | Set `ALLOW_PRIVATE_UPSTREAMS=true` only for trusted local stacks          |
| `VIEWER_USERNAME and VIEWER_PASSWORD_HASH ...`      | Configure both viewer values or neither                                   |
| `REDIS_PREFIX is empty after sanitization`          | Use letters, numbers, `:`, `_`, or `-`                                    |

For local development, the gateway reads `apps/gateway/.env` because npm runs workspace scripts from
the workspace directory. For Compose, it reads the root `.env` through injected environment
variables. Do not assume one file is used by both.

## Compose warns that bcrypt values are unset or the login fails

Compose expands `$` in unquoted and double-quoted `.env` values. A bcrypt hash such as
`$2a$10$...` will be mangled. Keep hashes single-quoted:

```dotenv
ADMIN_PASSWORD_HASH='$2a$10$...'
```

Then recreate the gateway:

```bash
docker compose up -d --force-recreate gateway
```

If you changed `JWT_SECRET`, existing dashboard sessions become invalid by design.

## Redis is unreachable / readiness returns 503

The gateway logs `redis is required but unavailable` and exits only when `REDIS_REQUIRED=true`.
Otherwise it stays up in degraded mode using a local fallback limiter, and `/health/ready` returns
`503` with `checks.redis: "down"`. This is expected fail-open behavior.

Checks:

```bash
docker compose ps redis
docker compose exec redis redis-cli ping
curl -s http://localhost:8080/health/ready
```

For local development, Redis must be on `127.0.0.1:6379` and `apps/gateway/.env` must use
`redis://127.0.0.1:6379`. Inside Compose, use `redis://redis:6379`.

Compose runs a one-shot `redis-init` service to give the named volume to the non-root Redis user.
It should exit with status `0`; `docker compose ps -a` showing `Exited (0)` for `redis-init` is
expected. If it fails, remove the volume with `docker compose down -v` and recreate the stack.

## Ports are already in use

Defaults: gateway `8080`, dashboard `8081`, demo API `4000`, Prometheus `9090`, Grafana `3000`, and
local dashboard development `5173`. Stop the conflicting process or change the host port mapping in
`docker-compose.yml`. Changing only the container port also requires updating environment variables.

Windows:

```powershell
Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue
```

## Integration tests are skipped

Gateway integration tests skip when Redis is unreachable. Start Redis and rerun:

```bash
docker run --rm -d --name edgeguard-redis -p 6379:6379 redis:7-alpine
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:gateway
```

PowerShell:

```powershell
$env:TEST_REDIS_URL="redis://127.0.0.1:6379"
npm run test:gateway
```

If a previous test container exists with the same name, start it instead:

```bash
docker start edgeguard-redis
```

## The dashboard immediately returns to login

- A `401` from any admin call clears the token and returns to login.
- Restarting the gateway with a new `JWT_SECRET` invalidates old tokens.
- A stale token can survive in `sessionStorage`. Clear it in DevTools or run
  `sessionStorage.removeItem("edgeguard.token")`, then sign in again.
- Make sure the system clock is correct; JWT expiry is time-based.

## Dashboard shows a 502 or cannot reach `/api/admin`

The dashboard container's Nginx proxies `/api/admin/` to `gateway:8080`. Confirm the gateway is
healthy:

```bash
docker compose ps gateway
docker compose logs --tail=100 gateway
curl -s http://localhost:8080/health/live
```

If the gateway container was recreated, restart the dashboard so Nginx resolves the new address:

```bash
docker compose restart dashboard
```

In local Vite development, verify `GATEWAY_URL` (default `http://127.0.0.1:8080`) and that the
gateway is running.

## Browser CORS errors

When the browser calls the admin API directly, the exact origin must be in `CORS_ORIGINS`, for example
`http://localhost:5173`. Use scheme, host, and port exactly. The Compose dashboard uses same-origin
`/api/admin`, so CORS is not involved there. Local Vite development also proxies through the dev
server.

## Load generator does not trigger isolation

- Use `LOADGEN_PATTERN=abuse` with a delay low enough to exceed limits, for example
  `LOADGEN_DELAY_MS=10`.
- The gateway must trust the load generator's `X-Forwarded-For` header for distinct client IDs.
  Compose sets `TRUST_PROXY=1`. Without it, all traffic is one client and may still be limited, but
  won't look like multiple clients.
- Default profile limits are 15 requests per 10 seconds plus 5 burst. If rules were edited, restore
  defaults in the dashboard or delete the rule key and restart the gateway.
- Confirm that the gateway and demo API are healthy. A failed upstream still consumes rate-limit
  tokens but may not produce the traffic pattern you expect.

## Prometheus target is down

Open http://localhost:9090/targets. Check:

- `gateway:8080` and `demo-api:4000` resolve inside the Compose network.
- The containers are healthy: `docker compose ps`.
- `/metrics` is reachable from inside the network.
- If `METRICS_TOKEN` is set, Prometheus needs matching authorization. The provided Compose scrape
  configuration does not send one, so leave `METRICS_TOKEN` empty for the demo or update
  `infra/prometheus/prometheus.yml`.

## Grafana has no data

- Verify the Prometheus datasource is provisioned and healthy (Connections -> Data sources).
- Check the time range; the dashboard defaults to the last 15 minutes.
- Generate traffic with the load generator.
- Ensure the dashboard's Prometheus target is up. Grafana cannot show gateway metrics if scraping
  fails.

## Docker build fails or is very slow

- Ensure Docker Desktop is running and has enough memory.
- The builds run `npm ci` and compile inside the image; first builds download dependencies.
- Run `docker compose build --no-cache gateway` to isolate a stale layer.
- Container images expect the repository root as the build context. Build directly with
  `docker build -f apps/gateway/Dockerfile .` from the root.
- If a build fails at the dashboard's Nginx stage, confirm `docker pull nginxinc/nginx-unprivileged:1.27-alpine`
  works in your environment.

## Kubernetes: gateway starts but fails configuration

`secret.example.yaml` is intentionally invalid. Create the real secret as shown in that file and
apply it before the Deployment. Also replace `dashboard.example.com` in
`infra/kubernetes/configmap.yaml` with your real dashboard origin.

If images are not in a registry, build and load them into your cluster (for example
`kind load docker-image edgeguard/gateway:1.0.0`) or update the image references.

## Manifest validation fails

Run:

```bash
npm run validate:manifests
```

The validator parses YAML, checks ConfigMap/Secret references, Service selectors and target ports,
HPA targets, probes, resources, security contexts, and network policy selectors. Fix the reported
resource name and rerun.

## Reset all local state

```bash
docker compose down -v
```

For local npm development, flush only the EdgeGuard Redis keys:

```bash
docker exec edgeguard-redis redis-cli --scan --pattern 'edgeguard:*' | xargs -r docker exec -i edgeguard-redis redis-cli DEL
```

On PowerShell, `xargs` is unavailable; use `docker exec edgeguard-redis redis-cli FLUSHDB` for a
development-only reset.
