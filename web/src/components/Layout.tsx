import { clsx } from "clsx";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BatteryCharging,
  Boxes,
  CircleDollarSign,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  RefreshCw,
  Search,
  ShieldAlert,
  Sun,
  Timer,
  TrendingUp,
} from "lucide-react";
import { fetchJson, RANGES } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { CheckList, Popover, Segmented } from "./ui";
import { formatCompact, formatRelative } from "../lib/format";
import type { MetaResponse } from "../types";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/usage", label: "Usage", icon: Activity },
  { to: "/cost", label: "Cost & spend", icon: CircleDollarSign },
  { to: "/performance", label: "Performance", icon: Timer },
  { to: "/reliability", label: "Reliability", icon: ShieldAlert },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/quota", label: "Quota", icon: BatteryCharging },
  { to: "/conversations", label: "Conversations", icon: MessagesSquare },
];

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Overview", subtitle: "Everything opencodex has seen, in one screen" },
  "/usage": { title: "Usage", subtitle: "Token volume, composition and context pressure" },
  "/cost": { title: "Cost & spend", subtitle: "Estimated spend from opencodex's own pricing engine" },
  "/performance": { title: "Performance", subtitle: "Latency, time-to-first-token and throughput" },
  "/reliability": { title: "Reliability", subtitle: "Outcomes, failures and metering coverage" },
  "/models": { title: "Models", subtitle: "Compare every model on volume, price and speed" },
  "/quota": { title: "Quota", subtitle: "Weekly and monthly plan burn with projections" },
  "/conversations": { title: "Conversations", subtitle: "Where the tokens actually go, session by session" },
};

export function Layout() {
  const { filters, set, toggleIn, reset } = useFilters();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const queryClient = useQueryClient();

  const meta = useQuery<MetaResponse>({
    queryKey: ["/api/meta"],
    queryFn: () => fetchJson<MetaResponse>("/api/meta"),
    staleTime: 60_000,
  });

  const activeFilters = filters.providers.length + filters.models.length + filters.efforts.length + filters.statuses.length;
  const heading = TITLES[location.pathname] ?? { title: "yald", subtitle: "" };

  const refresh = async () => {
    await fetchJson("/api/dataset/refresh");
    await queryClient.invalidateQueries();
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[224px] shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <div className="mb-5 flex items-center gap-2 px-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white">
            <TrendingUp size={15} strokeWidth={2.4} />
          </span>
          <span className="leading-tight">
            <span className="block text-[13px] font-semibold tracking-[-0.01em] text-ink">yald</span>
            <span className="block text-[10.5px] text-muted">opencodex analytics</span>
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={{ pathname: item.to, search: location.search }}
              end={item.end}
              className={({ isActive }) => clsx(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium transition",
                isActive ? "bg-surface-3 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink-soft",
              )}
            >
              <item.icon size={14.5} strokeWidth={2} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="px-2">
            <p className="text-[10.5px] uppercase tracking-[0.05em] text-muted">Ledger</p>
            <p className="num mt-1 text-[11.5px] text-ink-soft">
              {meta.data ? `${meta.data.totals.requests.toLocaleString()} requests` : "loading…"}
            </p>
            <p className="num text-[11.5px] text-ink-soft">
              {meta.data ? `${formatCompact(meta.data.totals.tokens)} tokens` : ""}
            </p>
            <p className="text-[10.5px] text-muted">
              {meta.data ? `updated ${formatRelative(meta.data.lastRequestAt)}` : ""}
            </p>
          </div>
          {meta.data ? (
            <p className={clsx("mx-2 rounded-lg px-2 py-1.5 text-[10.5px] leading-4", meta.data.pricing.available ? "bg-accent-soft text-accent" : "bg-warn-soft text-warn")}>
              {meta.data.pricing.available ? "pricing: opencodex engine" : `pricing unavailable`}
            </p>
          ) : null}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{heading.title}</h1>
              <p className="truncate text-[11.5px] text-muted">{heading.subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Segmented
                value={filters.range}
                options={RANGES.map(range => ({ id: range.id, label: range.label }))}
                onChange={range => set({ range })}
              />
              <Popover
                label={filters.providers.length ? `Provider · ${filters.providers.length}` : "Provider"}
                active={filters.providers.length > 0}
              >
                <CheckList
                  items={meta.data?.providers ?? []}
                  selected={filters.providers}
                  onToggle={value => toggleIn("providers", value)}
                />
              </Popover>
              <Popover label={filters.models.length ? `Model · ${filters.models.length}` : "Model"} active={filters.models.length > 0} width={320}>
                <CheckList items={meta.data?.models ?? []} selected={filters.models} onToggle={value => toggleIn("models", value)} />
              </Popover>
              <Popover label={filters.efforts.length ? `Effort · ${filters.efforts.length}` : "Effort"} active={filters.efforts.length > 0} width={200}>
                <CheckList items={meta.data?.efforts ?? []} selected={filters.efforts} onToggle={value => toggleIn("efforts", value)} />
              </Popover>
              <Popover label={filters.statuses.length ? `Outcome · ${filters.statuses.length}` : "Outcome"} active={filters.statuses.length > 0} width={180}>
                <CheckList items={["ok", "error", "cancelled"]} selected={filters.statuses} onToggle={value => toggleIn("statuses", value)} />
              </Popover>
              {activeFilters > 0 ? (
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-muted transition hover:text-bad"
                >
                  Clear
                </button>
              ) : null}
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={filters.search}
                  onChange={event => set({ search: event.target.value })}
                  placeholder="Search model, error, id…"
                  className="w-[190px] rounded-lg border border-line bg-surface py-1.5 pl-7 pr-2 text-[11.5px] text-ink outline-none transition placeholder:text-muted focus:border-accent/50"
                />
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-line bg-surface p-1.5 text-muted transition hover:text-ink"
                title="Re-read the opencodex ledgers"
              >
                <RefreshCw size={13} className={meta.isFetching ? "animate-spin" : undefined} />
              </button>
              <button
                type="button"
                onClick={toggle}
                className="rounded-lg border border-line bg-surface p-1.5 text-muted transition hover:text-ink"
                title="Toggle theme"
              >
                {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
              </button>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-x-clip px-4 pb-10 pt-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
