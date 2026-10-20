import { Suspense } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { usePreferences } from "../../lib/preferences";
import { InvestigationState } from "./InvestigationState";

/** The route boundary prevents disabled investigation components from mounting or polling. */
export function LabsLayout() {
  const { labsEnabled, setPreference } = usePreferences();
  const { search } = useLocation();
  return <div className="space-y-4">
    <section className="card flex flex-wrap items-start justify-between gap-4 p-4" aria-labelledby="labs-preference-title">
      <div>
        <h2 id="labs-preference-title" className="text-[14px] font-semibold text-ink">{labsEnabled ? "Labs is on" : "Labs is off"}</h2>
        <p className="mt-1 max-w-xl text-[12px] leading-5 text-ink-soft">{labsEnabled
          ? "Explore patterns in your selected requests. You can turn Labs off at any time."
          : "Labs is optional. Turn it on to explore investigations, or continue with the dashboard."}</p>
      </div>
      <button type="button" aria-pressed={labsEnabled} onClick={() => setPreference("labsEnabled", !labsEnabled)}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] font-medium text-ink">
        {labsEnabled ? "Disable Labs" : "Enable Labs"}
      </button>
    </section>
    {labsEnabled ? <Suspense fallback={<InvestigationState kind="loading" />}><Outlet /></Suspense>
      : <Link to={{ pathname: "/", search }} className="inline-block rounded-lg px-1 py-2 text-[12px] text-accent">Return to Overview</Link>}
  </div>;
}
