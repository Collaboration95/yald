import { useFilters } from "../lib/useFilters";
import { CheckList, Popover } from "./ui";
import { effortLabel, OUTCOME_LABELS } from "./ScopeControls";

export function MoreFilters({ providers, efforts }: { providers: string[]; efforts: string[] }) {
  const { filters, set, toggleIn } = useFilters();
  const count = [filters.providers, filters.efforts, filters.statuses].filter(values => values.length > 0).length;
  return <Popover label={<span title="Provider, Effort and Outcome">{count ? `More filters · ${count}` : "More filters"}</span>} active={count > 0} width={280}>
    <fieldset><legend className="px-2 py-1 text-[11px] font-semibold text-muted">Provider</legend>
      <CheckList items={[...new Set([...providers, ...filters.providers])]} selected={filters.providers} onToggle={value => toggleIn("providers", value)} />
    </fieldset>
    <fieldset><legend className="px-2 py-1 text-[11px] font-semibold text-muted">Effort</legend>
      <CheckList items={[...new Set([...efforts, ...filters.efforts])]} selected={filters.efforts} onToggle={value => toggleIn("efforts", value)} labelFor={effortLabel} />
    </fieldset>
    <fieldset><legend className="px-2 py-1 text-[11px] font-semibold text-muted">Outcome</legend>
      <CheckList items={[...new Set(["ok", "error", "cancelled", "unobserved", ...filters.statuses])]} selected={filters.statuses} onToggle={value => toggleIn("statuses", value)} labelFor={status => OUTCOME_LABELS[status] ?? status} />
    </fieldset>
    {count ? <button type="button" onClick={() => set({ providers: [], efforts: [], statuses: [] })} className="mt-2 px-2 py-1 text-[11.5px] font-medium text-accent">Clear more filters</button> : null}
  </Popover>;
}
