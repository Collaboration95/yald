import { useState } from "react";
import { escapeGlob, activeFilterCount, selectionFilters, sourceLabel, SOURCES, unescapeGlob, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { formatCompact, formatInteger, shortPath } from "../lib/format";
import type { ProjectsResponse, ScopeResponse } from "../types";
import { CheckList, InfoTip, Popover } from "./ui";

const PROJECTS_STALE_MS = 5 * 60_000;

/** Plain words for the stored outcome and effort values. */
export const OUTCOME_LABELS: Record<string, string> = { ok: "Succeeded", error: "Failed", cancelled: "Cancelled", unobserved: "No outcome recorded" };
export const effortLabel = (effort: string) => (effort === "unknown" ? "Not recorded" : effort);

/** Plain words for the `agents` filter values; a Codex root thread is unlabelled, never main. */
export const AGENT_LABELS: Record<string, string> = { main: "Main thread", subagent: "Subagents", unlabelled: "Unlabelled" };

export function AgentFilter() {
  const { filters, toggleIn } = useFilters();
  return (
    <Popover label={filters.agents.length ? `Agent · ${filters.agents.length}` : "Agent"} active={filters.agents.length > 0} width={220}>
      <CheckList items={Object.keys(AGENT_LABELS)} selected={filters.agents} onToggle={value => toggleIn("agents", value)} labelFor={agent => AGENT_LABELS[agent] ?? agent} />
      <p className="px-2 pb-1 pt-2 text-[11px] leading-4 text-muted">Requests with no recorded marker are Unlabelled, including Codex threads that may hold subagent traffic.</p>
    </Popover>
  );
}

export function SourceFilter({ scope }: { scope?: ScopeResponse }) {
  const { filters, set, toggleIn } = useFilters();
  const unknown = filters.sources.filter(id => !SOURCES.some(source => source.id === id));
  return (
    <Popover label={filters.sources.length ? `Source · ${filters.sources.length}` : "Source"} active={filters.sources.length > 0} align="left" width={260}>
      {SOURCES.map(source => (
        <label key={source.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[11.5px] text-ink-soft hover:bg-surface-3">
          <input type="checkbox" checked={!filters.sources.length || filters.sources.includes(source.id)} onChange={() => toggleIn("sources", source.id)} className="accent-accent" />
          <span className="flex-1">{source.label}</span>
          <span className="num text-muted">{scope ? formatInteger(scope.sources.find(item => item.source === source.id)?.requests ?? 0) : "—"}</span>
        </label>
      ))}
      {unknown.map(id => <button key={id} type="button" onClick={() => toggleIn("sources", id)} className="block px-2 py-2 text-[11px] text-bad">Remove unknown source: {id}</button>)}
      {filters.sources.length ? <button type="button" onClick={() => set({ sources: [] })} className="mt-1 px-2 py-1 text-[11px] text-accent">Include both</button> : null}
    </Popover>
  );
}

/** Only models with requests in the window, with counts like Source and Project; long lists get a search box. */
export function ModelFilter({ scope }: { scope?: ScopeResponse }) {
  const { filters, toggleIn } = useFilters();
  const inWindow = scope?.models ?? [];
  const outside = filters.models.filter(model => !inWindow.some(entry => entry.model === model));
  return (
    <Popover label={filters.models.length ? `Model · ${filters.models.length}` : "Model"} active={filters.models.length > 0} width={320}>
      <CheckList
        items={[...outside, ...inWindow.map(entry => entry.model)]}
        selected={filters.models}
        onToggle={value => toggleIn("models", value)}
        counts={Object.fromEntries(inWindow.map(entry => [entry.model, entry.requests]))}
        empty={scope ? "No models in this window" : "Loading…"}
      />
    </Popover>
  );
}

export function ProjectFilter() {
  const { filters, set, toggleIn } = useFilters();
  // Omit only the project selection: otherwise choosing one project removes all the other choices.
  // The list changes with the window and the data, not over seconds: no polling. Refresh refetches it.
  const query = useEndpoint<ProjectsResponse>("/api/projects", selectionFilters({ ...filters, projects: [] }), {}, { refetchInterval: false, staleTime: PROJECTS_STALE_MS });
  const choices = query.data?.projects.filter(project => project.project !== "(unattributed)") ?? [];
  const unattributed = query.data?.projects.find(project => project.project === "(unattributed)");
  const missing = filters.projects.filter(glob => !choices.some(choice => escapeGlob(choice.project) === glob));
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = needle ? choices.filter(choice => choice.project.toLowerCase().includes(needle)) : choices;

  return (
    <Popover label={filters.projects.length ? `Project · ${filters.projects.length}` : "Project"} active={filters.projects.length > 0} align="left" width={340}>
      {choices.length > 8 ? (
        <input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search projects" placeholder="Search…"
          className="mb-1.5 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50" />
      ) : null}
      {missing.length > 0 ? <div className="mb-2 border-b border-line pb-2">
        {missing.map(glob => <label key={glob} title={unescapeGlob(glob)} className="flex cursor-pointer items-start gap-2 px-2 py-2 text-[11.5px] text-ink-soft">
          <input type="checkbox" checked onChange={() => toggleIn("projects", glob)} className="mt-0.5 accent-accent" />
          <span className="break-all">{shortPath(unescapeGlob(glob))}</span>
        </label>)}
      </div> : null}
      {query.isLoading ? <p className="px-2 py-2 text-[11px] text-muted">Loading projects…</p> : null}
      {query.error ? <p role="alert" className="px-2 py-2 text-[11px] text-bad">Could not load project choices. {query.error.message}</p> : null}
      {!query.isLoading && !query.error && !choices.length ? <p className="px-2 py-2 text-[11px] text-muted">No projects in this window.</p> : null}
      {shown.map(choice => {
        const disabled = choice.project.includes(",");
        return <label key={choice.project} title={choice.project} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] text-ink-soft hover:bg-surface-3">
          <input type="checkbox" disabled={disabled} checked={filters.projects.includes(escapeGlob(choice.project))} onChange={() => toggleIn("projects", escapeGlob(choice.project))} className="accent-accent" />
          <span className="min-w-0 flex-1 truncate">{shortPath(choice.project)}</span>
          <span className="num shrink-0 text-muted">{formatInteger(choice.requests)}</span>
        </label>;
      })}
      {unattributed ? <p className="mt-1 flex items-center justify-between gap-2 border-t border-line px-2 py-2 text-[11px] text-muted">
        <span className="flex items-center gap-1">Unattributed <InfoTip label="About unattributed requests">No known folder, so any project selection leaves these out.</InfoTip></span>
        <span className="num">{formatInteger(unattributed.requests)}</span>
      </p> : null}
      <form className="mt-1 border-t border-line px-2 pt-2" onSubmit={event => {
        event.preventDefault();
        const glob = draft.trim();
        if (!glob) return;
        if (glob.includes(",")) { setError("One pattern at a time."); return; }
        set({ projects: [...new Set([...filters.projects, glob])] });
        setDraft(""); setError("");
      }}>
        <div className="flex gap-1.5">
          <input id="project-glob" value={draft} onChange={event => { setDraft(event.target.value); setError(""); }} aria-label="Add a folder pattern" placeholder="Add a pattern, e.g. ~/work/app-*" aria-describedby="project-glob-error" aria-invalid={Boolean(error)} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink placeholder:text-muted" />
          <button type="submit" className="rounded-lg border border-line px-2 py-1.5 text-[11.5px] text-accent">Add</button>
        </div>
        <p id="project-glob-error" role={error ? "alert" : undefined} className="mt-1 text-[11px] text-bad">{error}</p>
      </form>
    </Popover>
  );
}

/** "2 projects", "Codex only", "1 model": what the active filters narrow to. */
function filterSummary(filters: ReturnType<typeof useFilters>["filters"]): string {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (filters.sources.length) parts.push(filters.sources.map(sourceLabel).join(" + "));
  if (filters.projects.length) parts.push(plural(filters.projects.length, "project"));
  if (filters.agents.length) parts.push(filters.agents.map(agent => AGENT_LABELS[agent] ?? agent).join(" + "));
  if (filters.providers.length) parts.push(plural(filters.providers.length, "provider"));
  if (filters.models.length) parts.push(plural(filters.models.length, "model"));
  if (filters.efforts.length) parts.push(plural(filters.efforts.length, "effort"));
  if (filters.statuses.length) parts.push(plural(filters.statuses.length, "outcome"));
  if (filters.routeKinds.length) parts.push(plural(filters.routeKinds.length, "route"));
  if (filters.search.trim()) parts.push(`“${filters.search.trim()}”`);
  if (filters.conversationId) parts.push("one session");
  return parts.join(", ");
}

/**
 * Replaces the old always-on selection box. Nothing renders unless a filter narrows the data or a
 * note applies: the load error, or the requests a project selection leaves out.
 */
export function FilterNotes({ data, error }: { data?: ScopeResponse; error: unknown }) {
  const { filters, reset } = useFilters();
  const count = activeFilterCount(filters);
  if (!count && !error) return null;
  return <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted" data-filter-notes>
    {count ? <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-ink-soft">
      <span>Filtered: <span className="font-medium text-ink">{filterSummary(filters)}</span></span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={reset} className="font-medium text-accent hover:underline">Reset</button>
    </span> : null}
    {error ? <span className="text-bad">Could not load selection details. {String((error as Error).message ?? error)}</span> : null}
    {data?.coverage ? <span>
      Project selection leaves out {formatInteger(data.coverage.unattributedRows)} requests ({formatCompact(data.coverage.unattributedTokens)} tokens) with no known folder.
    </span> : null}
  </div>;
}

export function NoScopeMatches() {
  const { reset } = useFilters();
  return <section className="card px-4 py-10 text-center">
    <h2 className="text-[14px] font-semibold text-ink">No requests match these filters</h2>
    <p className="mt-2 text-[12px] text-muted">Try another source, project, time range or filter. Unattributed requests cannot match a project.</p>
    <button type="button" onClick={reset} className="mt-4 rounded-lg border border-line px-3 py-2 text-[12px] text-accent">Reset filters</button>
  </section>;
}
