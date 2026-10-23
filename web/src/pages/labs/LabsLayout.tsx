import { Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import { usePreferences } from "../../lib/preferences";
import { InvestigationState } from "./InvestigationState";
import { LAB_TABS } from "./shared";

/** The route boundary prevents disabled investigation components from mounting or polling. */
export function LabsLayout() {
  const { labsEnabled, setPreference } = usePreferences();
  const { search } = useLocation();
  if (!labsEnabled) {
    return <div className="card flex items-center justify-between gap-4 p-4">
      <p className="text-[12.5px] text-ink-soft">Labs is off.</p>
      <button type="button" onClick={() => setPreference("labsEnabled", true)} className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] font-medium text-ink">Turn on Labs</button>
    </div>;
  }
  return <div className="space-y-4">
    <nav aria-label="Investigations" className="flex flex-wrap gap-1 border-b border-line">
      <NavLink to={{ pathname: "/labs", search }} end className={({ isActive }) => clsx("-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium", isActive ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink-soft")}>Overview</NavLink>
      {LAB_TABS.map(tab => <NavLink key={tab.path} to={{ pathname: `/labs/${tab.path}`, search }}
        className={({ isActive }) => clsx("-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium", isActive ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink-soft")}>{tab.label}</NavLink>)}
    </nav>
    <Suspense fallback={<InvestigationState kind="loading" />}><Outlet /></Suspense>
  </div>;
}
