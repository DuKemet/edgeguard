import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StatusCount, TrafficBucket } from "@edgeguard/shared";
import { formatNumber, formatTime } from "../lib/format";

const COLORS = {
  requests: "#5b9dff",
  allowed: "#34d399",
  blocked: "#f87171",
  violations: "#fbbf24",
  latency: "#a78bfa",
  upstream: "#fb923c",
  grid: "rgba(148, 163, 184, 0.14)",
  axis: "#7c889c",
};

const TOOLTIP_STYLE = {
  background: "#111827",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  borderRadius: 10,
  color: "#e5e7eb",
  fontSize: 12,
};

interface ChartBucket extends TrafficBucket {
  label: string;
}

function toChartBuckets(buckets: TrafficBucket[]): ChartBucket[] {
  return buckets.map((bucket) => ({ ...bucket, label: formatTime(bucket.start) }));
}

export function TrafficVolumeChart({ buckets }: { buckets: TrafficBucket[] }) {
  const data = toChartBuckets(buckets);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.requests} stopOpacity={0.35} />
            <stop offset="95%" stopColor={COLORS.requests} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="fillBlocked" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.blocked} stopOpacity={0.3} />
            <stop offset="95%" stopColor={COLORS.blocked} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => formatNumber(value)} />
        <Legend wrapperStyle={{ fontSize: 12, color: COLORS.axis }} />
        <Area
          type="monotone"
          dataKey="requests"
          name="Requests"
          stroke={COLORS.requests}
          fill="url(#fillRequests)"
          strokeWidth={2}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="allowed"
          name="Allowed"
          stroke={COLORS.allowed}
          fill="transparent"
          strokeWidth={1.6}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="blocked"
          name="Blocked"
          stroke={COLORS.blocked}
          fill="url(#fillBlocked)"
          strokeWidth={1.6}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function LatencyChart({ buckets }: { buckets: TrafficBucket[] }) {
  const data = toChartBuckets(buckets);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={56} unit="ms" />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value: number) => [`${formatNumber(value)} ms`, "Avg latency"]}
        />
        <Line
          type="monotone"
          dataKey="avgLatencyMs"
          name="Average latency"
          stroke={COLORS.latency}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

const STATUS_COLORS = ["#34d399", "#60a5fa", "#fbbf24", "#f97316", "#f87171", "#b91c1c"];

export function StatusChart({ distribution }: { distribution: StatusCount[] }) {
  const data = distribution.map((entry) => ({
    name: String(entry.status),
    count: entry.count,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [formatNumber(value), "Requests"]} />
        <Bar dataKey="count" name="Requests" radius={[6, 6, 0, 0]} isAnimationActive={false}>
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={STATUS_COLORS[Math.min(index, STATUS_COLORS.length - 1)]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
