import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatSeconds,
  formatTime,
  severityTone,
  statusTone,
  truncate,
} from "../src/lib/format";

describe("number formatters", () => {
  it("formats integers and decimals", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatPercent(0.256)).toBe("25.6%");
    expect(formatPercent(0.5, 0)).toBe("50%");
    expect(formatCompact(1500)).toBe("1.5K");
  });
});

describe("duration formatters", () => {
  it("formats milliseconds across scales", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(9.7)).toBe("10 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(65_000)).toBe("1.1 min");
    expect(formatDuration(3_600_000)).toBe("1.0 h");
  });

  it("formats whole seconds", () => {
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(90)).toBe("1m 30s");
    expect(formatSeconds(3_900)).toBe("1h 5m");
  });
});

describe("date formatters", () => {
  it("formats timestamps and rejects invalid input", () => {
    const iso = "2026-03-01T12:34:56.000Z";
    expect(formatDateTime(iso)).not.toBe("—");
    expect(formatTime(iso)).not.toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  it("formats relative time in both directions", () => {
    const now = new Date("2026-03-01T12:00:00.000Z").getTime();
    expect(formatRelativeTime("2026-03-01T12:00:00.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-03-01T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-03-01T13:00:00.000Z", now)).toBe("in 1h");
    expect(formatRelativeTime("2026-02-28T12:00:00.000Z", now)).toBe("1d ago");
    expect(formatRelativeTime(undefined, now)).toBe("—");
  });
});

describe("display helpers", () => {
  it("maps HTTP status to tones", () => {
    expect(statusTone(204)).toBe("success");
    expect(statusTone(302)).toBe("neutral");
    expect(statusTone(429)).toBe("warning");
    expect(statusTone(503)).toBe("danger");
  });

  it("normalizes severity tones", () => {
    expect(severityTone("critical")).toBe("critical");
    expect(severityTone("unknown")).toBe("info");
  });

  it("truncates long values", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});
