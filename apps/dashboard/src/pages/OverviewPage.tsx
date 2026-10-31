import { useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { TrafficVolumeChart } from "../components/charts";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  LastUpdated,
  LoadingBlock,
  PageHeader,
  Panel,
  StatCard,
} from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
} from "../lib/format";

export function OverviewPage() {
  const { user } = useAuth();
  const overview = usePolling(() => api.overview(), 5_000);
  const traffic = usePolling(() => api.traffic(15), 5_000);
  const clients = usePolling(() => api.clients({ page: 1, pageSize: 5, windowMinutes: 60 }), 5_000);

  const refreshAll = useCallback(() => {
    overview.refresh();
    traffic.refresh();
    clients.refresh();
  }, [overview, traffic, clients]);

  const handleUnblock = async (clientId: string) => {
    if (!window.confirm("Lift temporary isolation for this client?")) return;
    try {
      await api.unblock(clientId);
      refreshAll();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to unblock client");
    }
  };

  if (overview.loading && !overview.data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Live protection status across the gateway." />
        <LoadingBlock label="Loading gateway overview" />
      </>
    );
  }

  if (overview.error && !overview.data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Live protection status across the gateway." />
        <ErrorBanner error={overview.error} onRetry={refreshAll} />
      </>
    );
  }

  const data = overview.data;
  if (!data) return null;
  const blockedRatio = data.requests > 0 ? data.blocked / data.requests : 0;
  const activeBlocks = clients.data?.activeBlocks ?? [];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${formatDateTime(data.generatedAt)} · last ${data.windowSeconds}s window`}
        actions={
          <div className="header-meta">
            <Badge tone={data.redisStatus === "ok" ? "success" : "warning"}>
              Redis {data.redisStatus}
            </Badge>
            <Badge tone="accent">v{data.gatewayVersion}</Badge>
            <LastUpdated value={overview.lastUpdated} />
          </div>
        }
      />

      {overview.error ? <ErrorBanner error={overview.error} onRetry={refreshAll} /> : null}

      <div className="stat-grid">
        <StatCard
          label="Requests / second"
          value={data.requestsPerSecond.toFixed(2)}
          hint={`${formatNumber(data.requests)} requests in ${data.windowSeconds}s`}
          tone="accent"
        />
        <StatCard label="Allowed" value={formatNumber(data.allowed)} hint="Passed through to upstream" tone="success" />
        <StatCard
          label="Blocked"
          value={formatNumber(data.blocked)}
          hint={`${formatPercent(blockedRatio)} of traffic`}
          tone="warning"
        />
        <StatCard label="Violations" value={formatNumber(data.violations)} hint="Rate-limit breaches" tone="danger" />
        <StatCard
          label="p95 latency"
          value={formatDuration(data.latency.p95Ms)}
          hint={`avg ${formatDuration(data.latency.avgMs)} · p99 ${formatDuration(data.latency.p99Ms)}`}
          tone="accent"
        />
        <StatCard
          label="Active blocks"
          value={formatNumber(data.activeBlocks)}
          hint="Temporary client isolations"
          tone={data.activeBlocks > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Events last hour"
          value={formatNumber(data.eventsLastHour)}
          hint="Detection events retained"
          tone="info"
        />
        <StatCard
          label="Upstream errors"
          value={formatPercent(data.upstreamErrorRate)}
          hint={`${formatNumber(data.upstreamErrors)} failed upstream responses`}
          tone={data.upstreamErrorRate > 0.05 ? "danger" : "success"}
        />
      </div>

      <div className="content-grid two-thirds">
        <Panel
          title="Request volume"
          subtitle="Last 15 minutes · polling every 5 seconds"
          action={<Link className="text-link" to="/traffic">Open traffic →</Link>}
        >
          {traffic.loading && !traffic.data ? (
            <LoadingBlock label="Loading traffic trend" />
          ) : traffic.error && !traffic.data ? (
            <ErrorBanner error={traffic.error} onRetry={traffic.refresh} />
          ) : traffic.data && traffic.data.buckets.length > 0 ? (
            <TrafficVolumeChart buckets={traffic.data.buckets} />
          ) : (
            <EmptyState
              title="No traffic yet"
              message="Send requests through the gateway to populate this chart."
            />
          )}
        </Panel>

        <Panel title="Active isolations" subtitle="Clients currently in cooldown">
          {clients.loading && !clients.data ? (
            <LoadingBlock label="Loading isolates" />
          ) : activeBlocks.length === 0 ? (
            <EmptyState
              title="No isolated clients"
              message="Detection has not isolated any clients in the last hour."
            />
          ) : (
            <ul className="block-list">
              {activeBlocks.map((block) => (
                <li key={block.clientId}>
                  <div>
                    <strong>{block.maskedIp}</strong>
                    <p className="muted small">{block.reason}</p>
                    <span className="muted tiny">
                      expires {formatRelativeTime(block.expiresAt)} · {block.remainingSeconds}s left
                    </span>
                  </div>
                  {user?.role === "admin" ? (
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => handleUnblock(block.clientId)}
                    >
                      Unblock
                    </button>
                  ) : (
                    <Badge tone="warning">read only</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Link className="text-link block-link" to="/configuration">
            Manage isolations in configuration →
          </Link>
        </Panel>
      </div>

      <Panel title="Runtime" subtitle="Gateway process and data source health">
        <dl className="detail-grid">
          <div>
            <dt>Redis</dt>
            <dd>
              <Badge tone={data.redisStatus === "ok" ? "success" : "warning"}>{data.redisStatus}</Badge>
            </dd>
          </div>
          <div>
            <dt>Gateway version</dt>
            <dd>{data.gatewayVersion}</dd>
          </div>
          <div>
            <dt>Window</dt>
            <dd>{data.windowSeconds} seconds</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{formatDateTime(data.generatedAt)}</dd>
          </div>
          <div>
            <dt>Latency samples</dt>
            <dd>{formatNumber(data.requests)}</dd>
          </div>
          <div>
            <dt>Viewer role</dt>
            <dd>{user?.role ?? "unknown"}</dd>
          </div>
        </dl>
      </Panel>
    </>
  );
}
