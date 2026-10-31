# Demo walkthrough

This walkthrough demonstrates allowed traffic, rate limiting, security events, temporary isolation,
administrative unblock, and recovery. It assumes the Compose stack is running and the example
credentials are unchanged.

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
```

Open the dashboard at http://localhost:8081 and sign in as `admin` / `edgeguard-demo`. The viewer
account is `viewer` / `edgeguard-viewer`.

## 1. Confirm baseline health

```bash
curl -s http://localhost:8080/health/ready
curl -s http://localhost:8080/api/products?limit=3
```

`/health/ready` should report `"status":"ok"` with Redis `ok`. The product request is proxied to the
demo API and includes `X-EdgeGuard-Rule: products` and rate-limit headers.

## 2. Generate allowed traffic

```bash
LOADGEN_PATTERN=allowed LOADGEN_DURATION=20 npm run loadgen
```

PowerShell:

```powershell
$env:LOADGEN_PATTERN="allowed"; $env:LOADGEN_DURATION="20"; npm run loadgen
```

The summary shows mostly `200` responses and a small number of `429`s if a worker exhausts a rule.
Get an admin token and inspect the overview:

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"edgeguard-demo"}' | jq -r .token)

curl -s http://localhost:8080/admin/overview \
  -H "authorization: Bearer $TOKEN" | jq
```

PowerShell:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:8080/admin/auth/login `
  -ContentType 'application/json' `
  -Body (@{ username = "admin"; password = "edgeguard-demo" } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri http://localhost:8080/admin/overview -Headers $headers |
  ConvertTo-Json -Depth 6
```

The dashboard Overview, Traffic, and Events pages read the same data every five seconds.

## 3. Trigger abuse and isolation

The abuse pattern sends repeated `/api/profile` requests from several forwarded client addresses.
The profile rule allows 15 requests per 10 seconds plus a burst of 5; the client detection threshold
is 6 RPS and repeated violations auto-isolate.

```bash
LOADGEN_PATTERN=abuse LOADGEN_DURATION=30 LOADGEN_CONCURRENCY=12 LOADGEN_DELAY_MS=10 \
  npm run loadgen
```

PowerShell:

```powershell
$env:LOADGEN_PATTERN="abuse"; $env:LOADGEN_DURATION="30"
$env:LOADGEN_CONCURRENCY="12"; $env:LOADGEN_DELAY_MS="10"
npm run loadgen
```

Expect a mix of `200` and `429`, followed by sustained `429`s after clients are isolated. The
load generator reports status counts; it does not retry or hide failures.

Inspect active blocks:

```bash
curl -s 'http://localhost:8080/admin/clients?windowMinutes=15' \
  -H "authorization: Bearer $TOKEN" | jq '.activeBlocks'
```

Events:

```bash
curl -s 'http://localhost:8080/admin/events?pageSize=10' \
  -H "authorization: Bearer $TOKEN" | jq '.items[] | {category, severity, observedValue, threshold, action, maskedIp}'
```

Typical categories are `high_client_rate`, `endpoint_flood`, `rate_limit_violation`, and
`cooldown_abuse`. If the whole stack is under load, a `traffic_spike` event may also appear.

## 4. Unblock an isolated client

```bash
CLIENT_ID=$(curl -s 'http://localhost:8080/admin/clients?windowMinutes=15' \
  -H "authorization: Bearer $TOKEN" | jq -r '.activeBlocks[0].clientId')

curl -s -X POST "http://localhost:8080/admin/clients/$CLIENT_ID/unblock" \
  -H "authorization: Bearer $TOKEN" | jq
```

This records an `admin_unblock` event. A viewer token cannot perform the action:

```bash
VIEWER_TOKEN=$(curl -s -X POST http://localhost:8080/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"viewer","password":"edgeguard-viewer"}' | jq -r .token)

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "http://localhost:8080/admin/clients/$CLIENT_ID/unblock" \
  -H "authorization: Bearer $VIEWER_TOKEN"
```

Expect `403`.

## 5. Observe automatic recovery

Isolation expires after 60 seconds by default. Alternatively, skip the manual unblock and wait.
Rate-limit tokens refill continuously, but allow about 10-15 seconds after the last burst before
expecting normal responses.

```bash
sleep 65
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/profile
```

Expect `200` once the block and bucket have recovered. The same recovery is visible in
Configuration -> Active isolations and in the Overview blocked count dropping.

## 6. Inspect metrics and dashboards

```bash
curl -s http://localhost:8080/metrics | grep -E 'edgeguard_gateway_(requests_total|blocked_total|active_blocks|detection_events_total)'
```

Open:

- Prometheus http://localhost:9090 -> Status -> Targets (gateway and demo API `UP`)
- Grafana http://localhost:3000 -> EdgeGuard -> EdgeGuard Overview
  (`admin` / `edgeguard-admin` by default)

The overview shows request decisions, block reasons, detection categories, latency percentiles,
upstream failures, top routes, and demo API health. The Compose Prometheus configuration does not
send a metrics token; if you set `METRICS_TOKEN`, configure Prometheus with matching credentials or
scraping will fail with `401`.

## 7. Prove shared enforcement across replicas (optional)

The integration suite starts two gateway instances against one Redis and verifies shared limits:

```bash
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:gateway
```

In Kubernetes, the gateway Deployment starts with two replicas for the same reason.

## Reset

```bash
docker compose down
```

Add `-v` to delete Redis, Prometheus, and Grafana volumes:

```bash
docker compose down -v
```

To restore default rules and detection settings without deleting metrics history, remove only the
configuration keys:

```bash
docker compose exec redis redis-cli DEL edgeguard:rules edgeguard:settings
docker compose restart gateway
```

The gateway re-seeds defaults during startup. Restarting also resets in-memory fallback state.
