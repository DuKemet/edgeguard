const numberFormatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return numberFormatter.format(value);
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return compactFormatter.format(value);
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0 ms";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? dateTimeFormatter.format(date) : "—";
}

export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? timeFormatter.format(date) : "—";
}

export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  const date = parseDate(value);
  if (!date) return "—";
  const deltaSeconds = Math.round((date.getTime() - now) / 1_000);
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 5) return "just now";
  if (absolute < 60) return deltaSeconds > 0 ? `in ${absolute}s` : `${absolute}s ago`;
  if (absolute < 3_600) {
    const minutes = Math.round(absolute / 60);
    return deltaSeconds > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  if (absolute < 86_400) {
    const hours = Math.round(absolute / 3_600);
    return deltaSeconds > 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(absolute / 86_400);
  return deltaSeconds > 0 ? `in ${days}d` : `${days}d ago`;
}

export function statusTone(status: number): "success" | "warning" | "danger" | "neutral" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "neutral";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500) return "danger";
  return "neutral";
}

export function severityTone(severity: string): "info" | "low" | "medium" | "high" | "critical" {
  if (severity === "critical" || severity === "high" || severity === "medium" || severity === "low") {
    return severity;
  }
  return "info";
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
