import { useState } from "react";
import { escapeGlob, selectionFilters, sourceLabel, SOURCES, unescapeGlob, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { formatCompact, formatInteger } from "../lib/format";
import type { ProjectsResponse, ScopeResponse } from "../types";
import { Popover } from "./ui";

const PROJECTS_STALE_MS = 5 * 60_000;

export function SourceFilter({ scope }: { scope?: ScopeResponse }) {
  const { filters, set, toggleIn } = useFilters();
  const unknown = filters.sources.filter(id => !SOURCES.some(source => source.id === id));
  return (
    <Popover label={filters.sources.length ? `Source · ${filters.sources.length}` : "Source"} active={filters.sources.length > 0} align="left" width={300}>
      <p className="px-2 pb-2 text-[11px] text-muted">Source follows the reader, not the API provider. Both are included by default.</p>
      {SOURCES.map(source => (
        <label key={source.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[11.5px] text-ink-soft hover:bg-surface-3">
          <input type="checkbox" checked={!filters.sources.length || filters.sources.includes(source.id)} onChange={() => toggleIn("sources", source.id)} className="accent-accent" />
          <span className="flex-1">{source.label}</span>
          <span className="num text-muted">{scope ? formatInteger(scope.sources.find(item => item.source === source.id)?.requests ?? 0) : "—"}</span>
        </label>
      ))}
      {unknown.map(id => <button key={id} type="button" onClick={() => toggleIn("sources", id)} className="block px-2 py-2 text-[11px] text-bad">Remove unknown source: {id}</button>)}
      <button type="button" onClick={() => set({ sources: [] })} className="mt-1 px-2 py-1 text-[11px] text-accent">Include both sources</button>
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
  const [error, setError] = useState("");

  return (
    <Popover label={filters.projects.length ? `Project · ${filters.projects.length}` : "Project"} active={filters.projects.length > 0} align="left" width={370}>
      <p id="project-matching-help" className="px-2 pb-2 text-[11px] leading-4 text-muted">
        Grouped by nearest git root. Selecting a folder includes its descendants, including nested projects. Globs follow the report matcher; selections are combined with OR.
      </p>
      {missing.length > 0 ? <div className="mb-2 border-b border-line pb-2">
        <p className="px-2 text-[10.5px] text-muted">Selected globs / folders outside these results</p>
        {missing.map(glob => <label key={glob} className="flex cursor-pointer items-start gap-2 px-2 py-2 text-[11.5px] text-ink-soft">
          <input type="checkbox" checked onChange={() => toggleIn("projects", glob)} className="mt-0.5 accent-accent" />
          <span className="break-all">{unescapeGlob(glob)}</span>
        </label>)}
      </div> : null}
      {query.isLoading ? <p className="px-2 py-2 text-[11px] text-muted">Loading projects…</p> : null}
      {query.error ? <p role="alert" className="px-2 py-2 text-[11px] text-bad">Could not load project choices. {query.error.message}</p> : null}
      {!query.isLoading && !query.error && !choices.length ? <p className="px-2 py-2 text-[11px] text-muted">No attributed projects under the other filters in this window.</p> : null}
      {choices.map(choice => {
        const nested = choices.filter(other => other.project.startsWith(`${choice.project}/`)).length;
        const disabled = choice.project.includes(",");
        return <label key={choice.project} className="flex items-start gap-2 rounded-lg px-2 py-2 text-[11.5px] text-ink-soft hover:bg-surface-3">
          <input type="checkbox" disabled={disabled} checked={filters.projects.includes(escapeGlob(choice.project))} onChange={() => toggleIn("projects", escapeGlob(choice.project))} className="mt-0.5 accent-accent" />
          <span className="min-w-0 flex-1">
            <span className="block break-all">{choice.project}</span>
            <span className="text-[10.5px] text-muted">{choice.gitRoot ? "git root" : "folder"} · {formatInteger(choice.requests)} requests{nested ? ` · +${nested} nested` : ""}
              {disabled ? " · comma in path cannot be selected" : ""}</span>
          </span>
        </label>;
      })}
      {unattributed ? <p className="mt-1 border-t border-line px-2 py-2 text-[11px] text-muted">
        Unattributed: {formatInteger(unattributed.requests)} requests · {formatCompact(unattributed.tokens)} tokens. No known folder; excluded by any project selection.
      </p> : null}
      <form className="mt-1 border-t border-line px-2 pt-2" onSubmit={event => {
        event.preventDefault();
        const glob = draft.trim();
        if (!glob) return;
        if (glob.includes(",")) { setError("Use one glob at a time; commas separate project selections in the URL."); return; }
        set({ projects: [...new Set([...filters.projects, glob])] });
        setDraft(""); setError("");
      }}>
        <label htmlFor="project-glob" className="text-[11px] text-ink-soft">Add a folder glob</label>
        <div className="mt-1 flex gap-1.5">
          <input id="project-glob" value={draft} onChange={event => { setDraft(event.target.value); setError(""); }} placeholder="~/work/app-*" aria-describedby="project-matching-help project-glob-error" aria-invalid={Boolean(error)} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink" />
          <button type="submit" className="rounded-lg border border-line px-2 py-1.5 text-[11.5px] text-accent">Add</button>
        </div>
        <p id="project-glob-error" role={error ? "alert" : undefined} className="mt-1 text-[11px] text-bad">{error}</p>
      </form>
    </Popover>
  );
}

export function ScopeStatus({ data, loading, error }: { data?: ScopeResponse; loading: boolean; error: unknown }) {
  const { filters } = useFilters();
  return <div role="status" className="mb-3 rounded-xl border border-line bg-surface px-3 py-2 text-[11.5px] leading-5 text-muted">
    {error ? <span className="text-bad">Could not load selection details. {String((error as Error).message ?? error)}</span>
      : loading || !data ? "Loading selection…" : <>
        <span className="font-medium text-ink">{formatInteger(data.matched.requests)} matching requests</span> · {formatCompact(data.matched.tokens)} tokens
        <span> · {formatInteger(data.windowTotal.requests)} requests in the full window</span>
        <span className="block">{filters.sources.length ? filters.sources.map(sourceLabel).join(", ") : "Both sources"} · {data.window.label}</span>
        {filters.projects.length ? <span className="block break-words">Projects: {filters.projects.map(unescapeGlob).join(", ")}</span> : null}
        {data.coverage ? <span className="block">
          Project selection excludes {formatInteger(data.coverage.unattributedRows)} unattributed requests ({formatCompact(data.coverage.unattributedTokens)} tokens) under the other filters in this window because no folder is known. They are not assigned to a project.
        </span> : null}
      </>}
  </div>;
}

export function NoScopeMatches() {
  const { reset } = useFilters();
  return <section className="card px-4 py-10 text-center">
    <h2 className="text-[14px] font-semibold text-ink">No requests match these filters</h2>
    <p className="mt-2 text-[12px] text-muted">Try another source, project glob, time window or request filter. Unattributed requests cannot match a project.</p>
    <button type="button" onClick={reset} className="mt-4 rounded-lg border border-line px-3 py-2 text-[12px] text-accent">Reset all filters</button>
  </section>;
}
