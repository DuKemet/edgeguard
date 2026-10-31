import { useState } from "react";
import { api } from "../api/client";
import { LatencyChart, StatusChart, TrafficVolumeChart } from "../components/charts";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  LastUpdated,
  LoadingBlock,
  PageHeader,
  Panel,
} from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
  statusTone,
} from "../lib/format";

const WINDOWS = [5, 15, 60, 180] as const;

export function TrafficPage() {
  const [windowMinutes, setWindowMinutes] = useState<number>(15);
  const traffic = usePolling(() => api.traffic(windowMinutes), 5_000, String(windowMinutes));

  return (
    <>
      <PageHeader
        title="Traffic"
        subtitle="Aggregated gateway traffic from Redis time buckets."
        actions={
          <div className="header-meta">
            <div className="segmented" role="group" aria-label="Time window">
              {WINDOWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={value === windowMinutes ? "active" : ""}
                  onClick={() => setWindowMinutes(value)}
                >
                  {value < 60 ? `${value}m` : `${value / 60}h`}
                </button>
              ))}
            </div>
            <LastUpdated value={traffic.lastUpdated} />
          </div>
        }
      />

      {traffic.error ? <ErrorBanner error={traffic.error} onRetry={traffic.refresh} /> : null}

      {traffic.loading && !traffic.data ? (
        <LoadingBlock label="Loading traffic aggregates" />
      ) : !traffic.data ? null : (
        <>
          <Panel
            title="Request volume"
            subtitle={`Last ${windowMinutes} minutes · ${traffic.data.bucketSeconds}s buckets`}
          >
            {traffic.data.buckets.some((bucket) => bucket.requests > 0) ? (
              <TrafficVolumeChart buckets={traffic.data.buckets} />
            ) : (
              <EmptyState
                title="No traffic in this window"
                message="Generate requests through the gateway or widen the time range."
              />
            )}
          </Panel>

          <div className="content-grid">
            <Panel title="Latency" subtitle="Average upstream + gateway latency per bucket">
              {traffic.data.buckets.some((bucket) => bucket.avgLatencyMs > 0) ? (
                <LatencyChart buckets={traffic.data.buckets} />
              ) : (
                <EmptyState title="No latency samples" message="Allowed requests record latency." />
              )}
            </Panel>
            <Panel title="Status distribution" subtitle="Responses grouped by HTTP status">
              {traffic.data.statusDistribution.length > 0 ? (
                <StatusChart distribution={traffic.data.statusDistribution} />
              ) : (
                <EmptyState title="No responses" message="Status codes appear after proxied traffic." />
              )}
            </Panel>
          </div>

          <div className="content-grid">
            <Panel title="Endpoints" subtitle="Top endpoints by request count">
              {traffic.data.endpoints.length === 0 ? (
                <EmptyState title="No endpoint data" message="No requests were recorded in this window." />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Endpoint</th>
                        <th className="numeric">Requests</th>
                        <th className="numeric">Allowed</th>
                        <th className="numeric">Blocked</th>
                        <th className="numeric">Avg latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {traffic.data.endpoints.slice(0, 12).map((endpoint) => (
                        <tr key={endpoint.endpoint}>
                          <td className="mono">{endpoint.endpoint}</td>
                          <td className="numeric">{formatNumber(endpoint.requests)}</td>
                          <td className="numeric">{formatNumber(endpoint.allowed)}</td>
                          <td className="numeric">{formatNumber(endpoint.blocked)}</td>
                          <td className="numeric">{formatDuration(endpoint.avgLatencyMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Top clients" subtitle="Masked client identities, highest volume first">
              {traffic.data.clients.length === 0 ? (
                <EmptyState title="No clients" message="Client identities appear after traffic is recorded." />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th className="numeric">Requests</th>
                        <th className="numeric">Blocked</th>
                        <th className="numeric">Violations</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {traffic.data.clients.map((client) => (
                        <tr key={client.id}>
                          <td>
                            <span className="mono">{client.maskedIp}</span>
                            {client.isolated ? <Badge tone="warning">isolated</Badge> : null}
                          </td>
                          <td className="numeric">{formatNumber(client.requests)}</td>
                          <td className="numeric">{formatNumber(client.blocked)}</td>
                          <td className="numeric">{formatNumber(client.violations)}</td>
                          <td className="muted small">{formatRelativeTime(client.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Status codes" subtitle="Per-code totals for the selected window">
            {traffic.data.statusDistribution.length === 0 ? (
              <p className="muted">No responses recorded.</p>
            ) : (
              <div className="chip-row">
                {traffic.data.statusDistribution.map((entry) => (
                  <Badge key={entry.status} tone={statusTone(entry.status)}>
                    {entry.status} · {formatNumber(entry.count)}
                  </Badge>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
