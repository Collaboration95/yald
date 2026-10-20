import { useId, type ReactNode } from "react";
import { YaldiArtwork } from "../../components/YaldiArtwork";

export type InvestigationStateKind = "loading" | "analysing" | "error" | "empty" | "insufficient" | "resting";
const CONTENT: Record<InvestigationStateKind, { title: string; description: string; role?: "status" | "alert" }> = {
  loading: { title: "Loading investigation", description: "Reading the selected local data.", role: "status" },
  analysing: { title: "Analysing investigation", description: "Comparing eligible observations in the selected local data.", role: "status" },
  error: { title: "Investigation unavailable", description: "The selected data could not be loaded. Try again.", role: "alert" },
  empty: { title: "No requests to investigate", description: "Try another source, project, time window or request filter.", role: "status" },
  insufficient: { title: "Not enough data", description: "More eligible observations are needed to show this comparison.", role: "status" },
  resting: { title: "Ready to investigate", description: "Choose an investigation and a scope to explore your local usage.", role: "status" },
};

/** The text is complete without artwork. Supply specific missing-data reasons in detail. */
export function InvestigationState({ kind, title, detail, children, onRetry }: { kind: InvestigationStateKind; title?: string; detail?: string; children?: ReactNode; onRetry?: () => void }) {
  const content = CONTENT[kind];
  const id = useId();
  return <section className="card flex items-start gap-4 p-5" role={content.role} aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`}>
    <YaldiArtwork state={kind === "loading" ? "investigating" : kind} />
    <div className="min-w-0 flex-1">
      <h2 id={`${id}-title`} className="text-sm font-semibold text-ink">{title ?? content.title}</h2>
      <p id={`${id}-detail`} className="mt-1 text-sm text-ink-soft">{detail ?? content.description}</p>
      {children}
      {kind === "error" && onRetry ? <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm text-ink">Try again</button> : null}
    </div>
  </section>;
}
