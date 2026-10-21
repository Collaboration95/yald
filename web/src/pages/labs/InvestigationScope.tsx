import { useId } from "react";
import { sourceLabel } from "../../api";
import type { RadarCohort, RadarWindow } from "../../types";

/** Present server-resolved scope, independently of the mutable dashboard toolbar. */
export function InvestigationScope({ window, cohort, sample, unpricedRequests, unattributedRequests, notes = [] }: {
  window: RadarWindow;
  cohort: RadarCohort;
  sample?: { eligibleRequests: number; totalRequests: number };
  unpricedRequests?: number;
  unattributedRequests?: number;
  notes?: readonly string[];
}) {
  const id = useId();
  const time = (ts: number) => new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "long", timeZone: window.tz,
  }).format(ts);
  const dimensions: [string, string][] = [
    ["Sources", cohort.sources.length ? cohort.sources.map(sourceLabel).join(", ") : "All sources"],
    ["Projects", cohort.projects.length ? cohort.projects.join(" · ") : "All projects, including unattributed requests"],
    ["Providers", cohort.providers.join(" · ") || "All providers"],
    ["Models", cohort.models.join(" · ") || "All models"],
    ["Efforts", cohort.efforts.join(" · ") || "All efforts"],
    ["Outcomes", cohort.statuses.join(" · ") || "All outcomes"],
    ["Routes", cohort.routeKinds.join(" · ") || "All routes"],
    ["Session", cohort.conversationId ?? "All sessions, including unnamed requests"],
    ["Search", cohort.search || "No search filter"],
  ];
  return <section className="card p-4 text-[12px] leading-5 text-ink-soft" aria-labelledby={id}>
    <h2 id={id} className="font-semibold text-ink">Investigation scope</h2>
    <p className="mt-1">This investigation uses a fixed window and cohort. Dashboard filters describe the next selection.</p>
    <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
      <dt className="font-medium text-ink">From (included)</dt><dd><time dateTime={new Date(window.from).toISOString()}>{time(window.from)}</time></dd>
      <dt className="font-medium text-ink">Until (excluded)</dt><dd><time dateTime={new Date(window.to).toISOString()}>{time(window.to)}</time></dd>
      <dt className="font-medium text-ink">Time zone</dt><dd>{window.tz}</dd>
      {dimensions.map(([label, value]) => <ScopeDimension key={label} label={label} value={value} />)}
    </dl>
    {sample ? <p className="mt-3">{sample.eligibleRequests.toLocaleString()} of {sample.totalRequests.toLocaleString()} requests eligible for this investigation.</p> : null}
    {unpricedRequests !== undefined ? <p>{unpricedRequests.toLocaleString()} requests without a price. Estimated costs are API list-price equivalents.</p> : null}
    {unattributedRequests !== undefined ? <p>{unattributedRequests.toLocaleString()} requests without project attribution.</p> : null}
    {cohort.projects.length ? <p>Project selections exclude requests without a known folder.</p> : null}
    {notes.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
  </section>;
}

function ScopeDimension({ label, value }: { label: string; value: string }) {
  return <><dt className="font-medium text-ink">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd></>;
}
