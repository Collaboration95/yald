import { clsx } from "clsx";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarDays,
  CircleDollarSign,
  Layers,
  LayoutDashboard,
  FlaskConical,
  MessagesSquare,
  Moon,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Timer,
} from "lucide-react";
import { fetchJson, hasScope, RANGES, selectionFilters, useEndpoint, useMeta } from "../api";
import { usePlaceholderShown, useSavedShown } from "../lib/staleness";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { CheckList, Popover, Segmented } from "./ui";
import { Wordmark } from "./Wordmark";
import { Delight } from "./Delight";
import { FilterNotes, ModelFilter, NoScopeMatches, OUTCOME_LABELS, ProjectFilter, SourceFilter, effortLabel } from "./ScopeControls";
import { formatDateTime, formatRelative } from "../lib/format";
import type { ScopeResponse } from "../types";
import { usePreferences } from "../lib/preferences";
import { DEMO } from "../lib/demo";
import { YaldiDemoArtwork } from "./YaldiArtwork";
import { isLabsAnalysis } from "../lib/labsFilters";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/usage", label: "Usage", icon: Activity },
  { to: "/cost", label: "Cost", icon: CircleDollarSign },
  { to: "/performance", label: "Performance", icon: Timer },
  { to: "/context", label: "Context", icon: Layers },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/style", label: "Working style", icon: CalendarDays },
];

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/usage": "Usage",
  "/cost": "Cost",
  "/performance": "Performance",
  "/context": "Context",
  "/sessions": "Sessions",
  "/style": "Working style",
};

function SettingsMenu() {
  const { labsEnabled, hideArtwork, setPreference } = usePreferences();
  const row = "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[11.5px] text-ink-soft hover:bg-surface-3";
  return (
    <Popover label={<Settings size={13} />} ariaLabel="Settings" chevron={false} width={200}>
      <label className={row}>
        <input type="checkbox" role="switch" checked={labsEnabled} onChange={event => setPreference("labsEnabled", event.target.checked)} className="accent-accent" />
        Labs
      </label>
      <label className={row}>
        <input type="checkbox" role="switch" checked={hideArtwork} onChange={event => setPreference("hideArtwork", event.target.checked)} className="accent-accent" />
        Hide artwork
      </label>
    </Popover>
  );
}

export function Layout() {
  const { labsEnabled } = usePreferences();
  const { filters, set, toggleIn } = useFilters();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const queryClient = useQueryClient();

  const meta = useMeta();

  const scope = useEndpoint<ScopeResponse>("/api/scope", selectionFilters(filters));
  // The previous selection's summary is not this one's: never count it as a match or a zero.
  const scopeData = scope.isPlaceholderData ? undefined : scope.data;
  const updating = usePlaceholderShown();
  const saved = useSavedShown();
  const isLabs = location.pathname === "/labs" || location.pathname.startsWith("/labs/");
  // Board and investigations share the visible cohort; evidence keeps its explicit case scope.
  const showFilters = !isLabs || isLabsAnalysis(location.pathname);
  const showRequestFilters = !isLabs;
  const title = isLabs ? "Labs" : TITLES[location.pathname] ?? "Session";
  const page = isLabs ? "labs" : location.pathname.startsWith("/sessions/") ? "session" : location.pathname.slice(1) || "overview";

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
        <div className="relay-activity">
          <div className="px-2">
            <p>{meta.data ? `Updated ${formatRelative(meta.data.builtAt)}` : "Loading…"}</p>
            {meta.data?.versions.opencodex ? <p>opencodex v{meta.data.versions.opencodex}</p> : null}
            {meta.data?.versions.yald ? <p>Yald v{meta.data.versions.yald}</p> : null}
          </div>
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
              {showFilters ? <>
              <Segmented
                value={filters.from || filters.to || filters.last ? "" : filters.range}
                options={RANGES.map(range => ({ id: range.id, label: range.label }))}
                onChange={range => set({ range })}
              />
              {filters.from || filters.to || filters.last ? <span className="px-1 text-[11px] text-accent">Custom window</span> : null}
              <SourceFilter scope={scopeData} />
              <ProjectFilter />
              {showRequestFilters ? <Popover
                label={filters.providers.length ? `Provider · ${filters.providers.length}` : "Provider"}
                active={filters.providers.length > 0}
              >
                <CheckList
                  items={meta.data?.providers ?? []}
                  selected={filters.providers}
                  onToggle={value => toggleIn("providers", value)}
                />
              </Popover> : null}
              <ModelFilter scope={scopeData} />
              {showRequestFilters ? <><Popover label={filters.efforts.length ? `Effort · ${filters.efforts.length}` : "Effort"} active={filters.efforts.length > 0} width={200}>
                <CheckList items={meta.data?.efforts ?? []} selected={filters.efforts} onToggle={value => toggleIn("efforts", value)} labelFor={effortLabel} />
              </Popover>
              <Popover label={filters.statuses.length ? `Outcome · ${filters.statuses.length}` : "Outcome"} active={filters.statuses.length > 0} width={220}>
                <CheckList items={["ok", "error", "cancelled", "unobserved"]} selected={filters.statuses} onToggle={value => toggleIn("statuses", value)} labelFor={status => OUTCOME_LABELS[status] ?? status} />
              </Popover></> : null}
              </> : null}
              {showRequestFilters ? <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={filters.search}
                  onChange={event => set({ search: event.target.value })}
                  aria-label="Search requests"
                  placeholder="Search model, error, id…"
                  className="w-[170px] rounded-lg border border-line bg-surface py-1.5 pl-7 pr-2 text-[11.5px] text-ink outline-none transition placeholder:text-muted focus:border-accent/50"
                />
              </div> : null}
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
              <SettingsMenu />
            </div>
          </div>
        </header>
        <main className="relay-content" data-page={page} id="main-content" data-updating={updating ? "true" : undefined} aria-busy={updating || undefined}>
          <div className="relay-heading">
            <h1>{title}<span className="relay-title-stop">.</span></h1>
            {updating ? <span role="status" data-updating-notice className="relay-updating-chip">Updating…</span> : null}
          </div>
          <FilterNotes data={scopeData} error={scope.error} />
          {saved ? <p role="status" data-saved-notice className="mb-3 text-[11.5px] leading-5 text-muted">
            {saved.failed
              ? `Could not refresh. Showing saved results from ${formatDateTime(saved.savedAt)}.`
              : `Showing saved results from ${formatDateTime(saved.savedAt)} while they refresh.`}
          </p> : null}
          {hasScope(filters) && scopeData?.matched.requests === 0 && page !== "session" && !isLabs
            ? <NoScopeMatches /> : <Outlet />}
        </main>
      </div>
      </div>
      <Delight />
    </div>
  );
}
