import { Link, useLocation, useParams } from "react-router-dom";
import { LABS_INVESTIGATIONS } from "./investigations";
import { InvestigationState } from "./InvestigationState";

export function LabsPage() {
  const { search } = useLocation();
  return <section aria-label="Investigations" className="grid gap-3 lg:grid-cols-3">
    {LABS_INVESTIGATIONS.map(investigation => <article key={investigation.path} className="card p-4">
      <h2 className="text-[14px] font-semibold text-ink"><Link to={{ pathname: `/labs/${investigation.path}`, search }}
        className="inline-block rounded py-1 hover:text-accent">{investigation.title}</Link></h2>
      <p className="mt-2 text-[12px] leading-5 text-ink-soft">{investigation.description}</p>
      {!investigation.Component ? <p className="mt-3 text-[11.5px] text-muted">Not available yet.</p> : null}
    </article>)}
  </section>;
}

export function LabsInvestigationPage() {
  const { investigation: path } = useParams();
  const { search } = useLocation();
  const investigation = LABS_INVESTIGATIONS.find(entry => entry.path === path);
  const Component = investigation?.Component;
  return <div className="space-y-3">
    <Link to={{ pathname: "/labs", search }} className="inline-block rounded px-1 py-2 text-[12px] text-accent">All investigations</Link>
    {Component ? <Component /> : <InvestigationState kind="empty" title={investigation?.title ?? "Labs page unavailable"}
      detail={investigation ? "This investigation is not available yet. You can explore another dashboard section in the meantime."
        : "This Labs page is not available yet. Choose an investigation or return to the dashboard."} />}
  </div>;
}
