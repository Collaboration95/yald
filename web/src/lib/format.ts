import { displayNow } from "./demo";

const LOCALE = "en-US";

export function formatCompact(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(digits)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(digits)}k`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString(LOCALE);
}

/** Money: $X.XX, $X.XXk past $1k, two significant figures under one cent. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs === 0) return "$0.00";
  if (abs < 0.000001) return `${sign}<$0.000001`;
  if (abs < 0.01) return `${sign}$${Number(abs.toFixed(1 - Math.floor(Math.log10(abs)))).toString()}`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}k`;
  return `${sign}$${abs.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact money for chart axes: $600, $1.5k, $0.50. */
export function formatUsdAxis(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return `${value < 0 ? "-" : ""}$${Number((abs / 1000).toFixed(2))}k`;
  if (abs >= 10) return `${value < 0 ? "-" : ""}$${Math.round(abs)}`;
  return formatUsd(value);
}

/** Signed money for differences: +$1.20 / -$3.40. */
export function formatUsdDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatUsd(value)}`;
}

/** A ratio with at most two decimals: 3.2×, 14×. */
export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Number(value.toFixed(2))}×`;
}

/** Plain decimal with at most `digits` places and no trailing zeros. */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number(value.toFixed(digits)).toLocaleString(LOCALE, { maximumFractionDigits: digits });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDelta(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRate(value: number | null | undefined, unit = "/s"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}${unit}`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString(LOCALE, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleDateString(LOCALE, { month: "short", day: "2-digit", year: "numeric" });
}

export function formatTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelative(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  const diff = displayNow() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function formatCountdown(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  const diff = ts - displayNow();
  if (diff <= 0) return "reset reached";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export function shortId(value: string | null | undefined, length = 8): string {
  if (!value) return "—";
  return value.length <= length ? value : value.slice(0, length);
}

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export function formatCoverage(sample: { eligibleRequests: number; totalRequests: number } | undefined): string {
  if (!sample) return "";
  return `${formatInteger(sample.eligibleRequests)} of ${formatInteger(sample.totalRequests)} requests observed`;
}

/** "Oct 13" for a YYYY-MM-DD day key or a timestamp. Full values belong in tooltips. */
export function formatShortDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

/** The last two path segments: /Users/me/work/app -> work/app. */
export function shortPath(path: string | null | undefined): string {
  if (!path) return "—";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/** A readable name for a session: the project it ran in, else a short id. */
export function sessionLabel(session: { id: string; project: string | null }): string {
  return session.project ? shortPath(session.project) : `Session ${shortId(session.id, 6)}`;
}

/** "Weekly plan" for a stored quota window name such as "weekly" or "7d". */
export function quotaLabel(window: string): string {
  if (/week|7d/i.test(window)) return "Weekly plan";
  if (/month|30d/i.test(window)) return "Monthly plan";
  return `${titleCase(window)} limit`;
}
