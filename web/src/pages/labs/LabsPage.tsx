import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useEndpoint } from "../../api";
import { formatInteger, formatRatio, formatShortDate, formatUsd, formatUsdDelta } from "../../lib/format";
import type { CacheEconomicsResponse, ContextResponse, ProjectRadarResponse, SpendChangesResponse } from "../../types";
import { LABS_INVESTIGATIONS } from "./investigations";
import { InvestigationState } from "./InvestigationState";
import { projectLabel, projectMover } from "./ProjectRadar";
import { LAB_TABS, useLabsFilters, type LabPath } from "./shared";

/** One case on the board: the finding and one number first; the investigation behind it is one click away. */
function CaseCard({ path, title, loading, error, headline, big, detail }: {
  path: LabPath; title: string; loading: boolean; error: boolean; headline: ReactNode; big?: string; detail?: ReactNode;
}) {
  const { search } = useLocation();
  return <article className="card flex flex-col p-4">
    <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-muted">{title}</p>
    {loading ? <p className="mt-2 text-[12px] text-muted">Looking…</p> : error ? <p className="mt-2 text-[12px] text-muted">Unavailable right now.</p> : <>
      {big ? <p className="num mt-2 text-[28px] font-bold leading-none tracking-tight text-ink">{big}</p> : null}
      <h2 className="mt-2 text-[13.5px] font-semibold leading-5 text-ink">{headline}</h2>
      {detail ? <p className="mt-1 text-[12px] leading-5 text-ink-soft">{detail}</p> : null}
    </>}
    <Link to={{ pathname: `/labs/${path}`, search }} className="mt-auto inline-block pt-3 text-[12px] font-medium text-accent hover:underline">Investigate</Link>
  </article>;
}

function SpikesCard() {
  const filters = useLabsFilters("spend-spikes");
  const query = useEndpoint<SpendChangesResponse>("/api/labs/spend", filters, {}, { keepPrevious: false, persist: false });
  const spikes = query.data?.days.filter(day => day.state === "spike").sort((a, b) => (b.pricedCostUsd ?? 0) - (a.pricedCostUsd ?? 0)) ?? [];
  const top = spikes[0];
  return <CaseCard path="spend-spikes" title="Spend spikes" loading={query.isLoading} error={query.isError}
    big={top ? formatUsd(top.pricedCostUsd) : undefined}
    headline={top ? `${spikes.length} unusual ${spikes.length === 1 ? "day" : "days"}; biggest ${formatShortDate(top.date)}` : "No unusually expensive days"}
    detail={top?.baseline.ratio ? `${formatRatio(top.baseline.ratio)} a typical day.` : undefined} />;
}

function ProjectsCard() {
  const filters = useLabsFilters("project-radar");
  const query = useEndpoint<ProjectRadarResponse>("/api/labs/projects", filters, {}, { keepPrevious: false, persist: false });
  const mover = query.data ? projectMover(query.data.projects) : undefined;
  const change = mover?.comparison.pricedCostUsd.absoluteChange ?? 0;
  return <CaseCard path="project-radar" title="Projects" loading={query.isLoading} error={query.isError}
    big={mover ? formatUsdDelta(change) : undefined}
    headline={mover ? `${projectLabel(mover.project)} ${change >= 0 ? "spent more" : "spent less"} than the period before` : "No project changed in cost"} />;
}

function CacheCard() {
  const filters = useLabsFilters("cache-detective");
  const query = useEndpoint<CacheEconomicsResponse>("/api/labs/cache", filters, { limit: 1 }, { keepPrevious: false, persist: false });
  const totals = query.data?.totals;
  const ok = !!totals && totals.eligibleRequests > 0 && totals.direction !== "insufficient";
  return <CaseCard path="cache-detective" title="Cache savings" loading={query.isLoading} error={query.isError}
    big={ok ? formatUsd(totals.netUsd) : undefined}
    headline={ok ? (totals.direction === "cost" ? "Caching cost more than it saved" : "Caching saved you money") : "Not enough cache data to compare"} />;
}

function GrowthCard() {
  const filters = useLabsFilters("context-replay");
  const query = useEndpoint<ContextResponse>("/api/context", filters, {}, { keepPrevious: false, persist: false });
  const growth = query.data?.growth;
  const ratio = growth?.medianRatio ?? null;
  return <CaseCard path="context-replay" title="Context growth" loading={query.isLoading} error={query.isError}
    big={ratio !== null ? formatRatio(ratio) : undefined}
    headline={ratio !== null ? "Sessions grow this much from first to last request" : "Not enough long sessions to measure growth"}
    detail={growth && growth.ranked > 0 ? `${formatInteger(growth.ranked)} sessions measured.` : undefined} />;
}

export function LabsPage() {
  return <section aria-label="Investigations" className="grid gap-3 sm:grid-cols-2">
    <SpikesCard />
    <ProjectsCard />
    <CacheCard />
    <GrowthCard />
  </section>;
}

export function LabsInvestigationPage() {
  const { investigation: path } = useParams();
  const investigation = LABS_INVESTIGATIONS.find(entry => entry.path === path);
  const Component = investigation?.Component;
  const known = LAB_TABS.some(tab => tab.path === path);
  return Component ? <Component /> : <InvestigationState kind="empty" title={known ? "Not available yet" : "Labs page unavailable"}
    detail="Choose one of the investigations above." />;
}
