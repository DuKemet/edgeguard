import { useState } from "react";
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_META,
  SEVERITIES,
  SEVERITY_META,
  type SecurityEvent,
} from "@edgeguard/shared";
import { api } from "../api/client";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  LastUpdated,
  LoadingBlock,
  PageHeader,
  Pagination,
  Panel,
} from "../components/ui";
import { useDebounced } from "../hooks/useDebounced";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime, formatNumber, formatRelativeTime, severityTone } from "../lib/format";

const PAGE_SIZE = 25;

function actionLabel(event: SecurityEvent): string {
  switch (event.action) {
    case "client_isolated":
      return "client isolated";
    case "client_unblocked":
      return "client unblocked";
    case "rate_limited":
      return "rate limited";
    default:
      return "observed";
  }
}

export function EventsPage() {
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 300);
  const queryKey = [page, severity, category, debouncedSearch].join("|");

  const events = usePolling(
    () =>
      api.events({
        page,
        pageSize: PAGE_SIZE,
        severity: severity || undefined,
        category: category || undefined,
        q: debouncedSearch || undefined,
      }),
    5_000,
    queryKey,
  );

  const resetPage = () => setPage(1);

  return (
    <>
      <PageHeader
        title="Events"
        subtitle="Explainable detection findings with observed values and thresholds."
        actions={<LastUpdated value={events.lastUpdated} />}
      />

      <Panel className="filter-panel">
        <div className="filter-row">
          <label className="field inline">
            <span className="field-label">Search</span>
            <input
              type="search"
              value={search}
              placeholder="message, endpoint, client"
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
            />
          </label>
          <label className="field inline">
            <span className="field-label">Severity</span>
            <select
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value);
                resetPage();
              }}
            >
              <option value="">All severities</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {SEVERITY_META[value].label}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span className="field-label">Category</span>
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                resetPage();
              }}
            >
              <option value="">All categories</option>
              {EVENT_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {EVENT_CATEGORY_META[value].label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button ghost small"
            onClick={() => {
              setSearch("");
              setSeverity("");
              setCategory("");
              setPage(1);
            }}
          >
            Clear filters
          </button>
        </div>
      </Panel>

      {events.error ? <ErrorBanner error={events.error} onRetry={events.refresh} /> : null}

      {events.loading && !events.data ? (
        <LoadingBlock label="Loading detection events" />
      ) : !events.data ? null : events.data.items.length === 0 ? (
        <Panel>
          <EmptyState
            title="No events match"
            message="Adjust the filters, or generate traffic that crosses a detection threshold."
          />
        </Panel>
      ) : (
        <Panel title="Findings" subtitle={`${formatNumber(events.data.total)} events match`}>
          <div className="event-list">
            {events.data.items.map((event) => {
              const isOpen = expanded === event.id;
              return (
                <article key={event.id} className={`event-card${isOpen ? " open" : ""}`}>
                  <button
                    type="button"
                    className="event-summary"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : event.id)}
                  >
                    <div className="event-primary">
                      <Badge tone={severityTone(event.severity)}>{event.severity}</Badge>
                      <div>
                        <strong>{EVENT_CATEGORY_META[event.category].label}</strong>
                        <p className="muted small">{event.message}</p>
                      </div>
                    </div>
                    <div className="event-meta">
                      <span className="mono small">{event.endpoint}</span>
                      <span className="muted small">{formatRelativeTime(event.timestamp)}</span>
                      <Badge tone={event.resolved ? "success" : event.action === "client_isolated" ? "warning" : "neutral"}>
                        {event.resolved ? "resolved" : actionLabel(event)}
                      </Badge>
                    </div>
                  </button>
                  {isOpen ? (
                    <div className="event-details">
                      <dl className="detail-grid">
                        <div>
                          <dt>Observed</dt>
                          <dd>
                            {formatNumber(event.observedValue)} {event.unit}
                          </dd>
                        </div>
                        <div>
                          <dt>Threshold</dt>
                          <dd>
                            {formatNumber(event.threshold)} {event.unit}
                          </dd>
                        </div>
                        <div>
                          <dt>Client</dt>
                          <dd className="mono">{event.maskedIp ?? "platform"}</dd>
                        </div>
                        <div>
                          <dt>Method</dt>
                          <dd>{event.method ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Timestamp</dt>
                          <dd>{formatDateTime(event.timestamp)}</dd>
                        </div>
                        <div>
                          <dt>Expires</dt>
                          <dd>{event.expiresAt ? formatDateTime(event.expiresAt) : "—"}</dd>
                        </div>
                        <div>
                          <dt>Request ID</dt>
                          <dd className="mono tiny">{event.requestId ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Event ID</dt>
                          <dd className="mono tiny">{event.id}</dd>
                        </div>
                      </dl>
                      {event.details ? (
                        <div className="event-details-extra">
                          <dt>Details</dt>
                          <dd>
                            {Object.entries(event.details).map(([key, value]) => (
                              <span key={key} className="kv">
                                <span>{key}</span>
                                <strong>{String(value)}</strong>
                              </span>
                            ))}
                          </dd>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          <Pagination
            page={events.data.page}
            pageSize={events.data.pageSize}
            total={events.data.total}
            onChange={setPage}
          />
        </Panel>
      )}
    </>
  );
}
