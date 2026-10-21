import { clsx } from "clsx";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BatteryCharging,
  Boxes,
  CircleDollarSign,
  Layers,
  LayoutDashboard,
  FlaskConical,
  MessagesSquare,
  Moon,
  RefreshCw,
  Search,
  ShieldAlert,
  Sun,
  Timer,
} from "lucide-react";
import { activeFilterCount, fetchJson, hasCustomWindow, hasScope, RANGES, selectionFilters, useEndpoint, useMeta } from "../api";
import { usePlaceholderShown, useSavedShown } from "../lib/staleness";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { CheckList, Popover, Segmented } from "./ui";
import { Wordmark } from "./Wordmark";
import { Delight } from "./Delight";
import { NoScopeMatches, ProjectFilter, ScopeStatus, SourceFilter } from "./ScopeControls";
import { formatCompact, formatDateTime, formatRelative } from "../lib/format";
import type { ScopeResponse } from "../types";
import { usePreferences } from "../lib/preferences";
import { DEMO, displayNow } from "../lib/demo";
import { YaldiDemoArtwork } from "./YaldiArtwork";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/usage", label: "Usage", icon: Activity },
  { to: "/cost", label: "Cost & spend", icon: CircleDollarSign },
  { to: "/performance", label: "Performance", icon: Timer },
  { to: "/context", label: "Context", icon: Layers },
  { to: "/reliability", label: "Reliability", icon: ShieldAlert },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/quota", label: "Quota", icon: BatteryCharging },
  { to: "/conversations", label: "Conversations", icon: MessagesSquare },
];

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Overview", subtitle: "Usage recorded by your selected sources" },
  "/usage": { title: "Usage", subtitle: "Token volume, composition and context pressure" },
  "/cost": { title: "Cost & spend", subtitle: "API list-price equivalents for your selected sources" },
  "/performance": { title: "Performance", subtitle: "Latency, time-to-first-token and throughput" },
  "/context": { title: "Context", subtitle: "How long your contexts are, per model, and what long ones coincide with" },
  "/reliability": { title: "Reliability", subtitle: "Outcomes, failures and metering coverage" },
  "/models": { title: "Models", subtitle: "Compare every model on volume, price and speed" },
  "/quota": { title: "Quota", subtitle: "Weekly and monthly plan burn with projections" },
  "/conversations": { title: "Conversations", subtitle: "Where the tokens actually go, session by session" },
};

export function Layout() {
  const { labsEnabled, hideArtwork, setPreference } = usePreferences();
  const { filters, set, toggleIn, reset } = useFilters();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const queryClient = useQueryClient();

  const meta = useMeta();

  const scope = useEndpoint<ScopeResponse>("/api/scope", selectionFilters(filters));
  // The previous selection's summary is not this one's: never count it as a match or a zero.
  const scopeData = scope.isPlaceholderData ? undefined : scope.data;
  const updating = usePlaceholderShown();
  const saved = useSavedShown();
  const activeFilters = activeFilterCount(filters);
  const isLabs = location.pathname === "/labs" || location.pathname.startsWith("/labs/");
  const heading = isLabs ? { title: "Labs", subtitle: "Follow patterns in your usage" }
    : TITLES[location.pathname] ?? { title: "Conversation", subtitle: "The selected session cohort, request by request" };
  const page = isLabs ? "labs" : location.pathname.startsWith("/conversations/") ? "conversation" : location.pathname.slice(1) || "overview";

  const refresh = async () => {
    await fetchJson("/api/dataset/refresh");
    await queryClient.invalidateQueries();
  };

  return (
    <div className="relay-app">
      <a className="relay-skip" href="#main-content">Skip to content</a>
      <div className="relay-frame">
      <aside className="relay-sidebar">
        <Wordmark />
        <p className="mt-2 text-[10px] leading-4 text-muted">opencodex + Claude Code</p>
        <nav className="relay-nav" aria-label="Analytics sections">
          {[...NAV, ...(labsEnabled ? [{ to: "/labs", label: "Labs", icon: FlaskConical }] : [])].map(item => (
            <NavLink
              key={item.to}
              to={{ pathname: item.to, search: location.search }}
              end={item.end}
              className={({ isActive }) => clsx("relay-nav-link", isActive && "relay-nav-active")}
            >
              <item.icon size={14.5} strokeWidth={2} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <label className="mx-4 mt-3 flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-soft">
          <input type="checkbox" role="switch" checked={labsEnabled}
            onChange={event => setPreference("labsEnabled", event.target.checked)} className="accent-accent" />
          Enable Labs
        </label>
        <label className="mx-4 mt-2 flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-soft">
          <input type="checkbox" role="switch" checked={hideArtwork}
            onChange={event => setPreference("hideArtwork", event.target.checked)} className="accent-accent" />
          Hide artwork
        </label>
        <div className="relay-activity">
          <div className="px-2">
            <p className="relay-activity-label">All local activity</p>
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
              {DEMO ? "pricing: illustrative examples" : meta.data.pricing.available ? "pricing: opencodex engine" : `pricing unavailable`}
            </p>
          ) : null}
        </div>
      </aside>

      <div className="relay-workspace">
          {DEMO ? <div data-demo-banner className="sticky top-0 z-40 flex items-center gap-3 border-b border-line bg-accent-soft px-4 py-2 text-ink">
            <YaldiDemoArtwork />
            <div className="text-[11.5px] leading-5">
              <p className="font-semibold">Demo / synthetic data</p>
              <p>Illustrative example prices, not live rates. Projects, usage and quota are synthetic. API list-price equivalents, not bills.</p>
              {DEMO.clock === "fixed" ? <p>Screenshot clock: {new Date(DEMO.now!).toISOString()}</p> : null}
            </div>
          </div> : null}
        <header className="relay-toolbar">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Segmented
                value={hasCustomWindow(filters) ? "" : filters.range}
                options={RANGES.map(range => ({ id: range.id, label: range.label }))}
                onChange={range => set({ range })}
              />
              {hasCustomWindow(filters) ? <span className="px-1 text-[11px] text-accent">Custom window</span> : null}
              <SourceFilter scope={scopeData} />
              <ProjectFilter />
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
                <CheckList items={["ok", "error", "cancelled", "unobserved"]} selected={filters.statuses} onToggle={value => toggleIn("statuses", value)} />
              </Popover>
              {activeFilters > 0 ? (
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-muted transition hover:text-bad"
                >
                  Reset filters · {activeFilters}
                </button>
              ) : null}
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={filters.search}
                  onChange={event => set({ search: event.target.value })}
                  aria-label="Search requests"
                  placeholder="Search model, error, id…"
                  className="w-[190px] rounded-lg border border-line bg-surface py-1.5 pl-7 pr-2 text-[11.5px] text-ink outline-none transition placeholder:text-muted focus:border-accent/50"
                />
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-line bg-surface p-1.5 text-muted transition hover:text-ink"
                aria-label="Refresh data"
                title="Re-read local opencodex and Claude Code data"
              >
                <RefreshCw size={13} className={meta.isFetching ? "animate-spin" : undefined} />
              </button>
              <button
                type="button"
                onClick={toggle}
                className="rounded-lg border border-line bg-surface p-1.5 text-muted transition hover:text-ink"
                title="Toggle theme"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
              </button>
            </div>
          </div>
        </header>
        <main className="relay-content" data-page={page} id="main-content" data-updating={updating ? "true" : undefined} aria-busy={updating || undefined}>
          <div className="relay-heading">
            <span className="relay-eyebrow">{isLabs ? "09" : String(NAV.findIndex(item => item.to === location.pathname) + 1 || 8).padStart(2, "0")} / DASHBOARD</span>
            <h1>{heading.title}<span className="relay-title-stop">.</span></h1>
            <p>{heading.subtitle}</p>
          </div>
          {isLabs ? <p className="mb-1 text-[11.5px] font-medium text-ink-soft">Dashboard selection</p> : null}
          <ScopeStatus data={scopeData} loading={scope.isLoading || scope.isPlaceholderData} error={scope.error} />
          {updating ? <p role="status" data-updating-notice className="mb-3 rounded-xl border border-line bg-warn-soft px-3 py-2 text-[11.5px] leading-5 text-warn">
            Updating: the numbers below are from the previous selection and are not this selection's result yet.
          </p> : null}
          {saved ? <p role="status" data-saved-notice className="mb-3 rounded-xl border border-line bg-info-soft px-3 py-2 text-[11.5px] leading-5 text-info">
            {saved.failed
              ? `Could not refresh. Showing saved results as of ${formatDateTime(saved.savedAt)}.`
              : `Showing saved results as of ${formatDateTime(saved.savedAt)} while they refresh.`}
          </p> : null}
          {hasScope(filters) && scopeData?.matched.requests === 0 && page !== "quota" && page !== "conversation" && !isLabs
            ? <NoScopeMatches /> : <Outlet />}
          <footer className="relay-footer"><span>{new Date(displayNow()).getHours() < 5 ? "It's late. The tokens will keep till morning." : "Every request leaves a trace."}</span><span>On your machine · Read-only analytics</span></footer>
        </main>
      </div>
      </div>
      <Delight />
    </div>
  );
}
