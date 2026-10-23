import type { ChartOption } from "../../components/Chart";
import { lineChart, type ThemeTokens } from "../../components/chartOptions";
import { formatCompact } from "../../lib/format";
import type { ContextEvidence, ContextSession } from "../../types";

/** Preserve the server's complete selector and fixed scope; only identify the investigation. */
export function contextEvidenceHref(evidence: ContextEvidence): string {
  const [path, search = ""] = evidence.href.split("?");
  const params = new URLSearchParams(search);
  params.set("investigation", "context-replay");
  return `${path}?${params}`;
}

/** Presentation only: submitted input per request, in time order. Requests without measured input leave a gap, not a zero. */
export function contextTimelineOption(theme: ThemeTokens, session: ContextSession, tz: string): ChartOption {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const labels = session.requests.map(row => day.format(row.ts));
  // The formatter takes only the value: chart axes also pass an index as a second argument.
  return lineChart(theme, labels, [
    { name: "Input per request", data: session.requests.map(row => row.eligible ? row.inputTokens : null), area: true },
  ], { formatter: value => formatCompact(value), preserveGaps: true, showLegend: false });
}
