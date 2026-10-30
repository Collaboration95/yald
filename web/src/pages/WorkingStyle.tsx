import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { fetchJson, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { usePreferences } from "../lib/preferences";
import { DEMO } from "../lib/demo";
import { colorAt } from "../lib/palette";
import { Card, CardHeader, Expandable, InfoTip, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, lineChart, stackedBarChart } from "../components/chartOptions";
import { YaldiArtwork, type YaldiArtworkState } from "../components/YaldiArtwork";
import { formatDuration, formatInteger, formatPercent, formatUsd } from "../lib/format";
import { downloadCaseFile, exportNotes } from "../lib/caseFileImage";
import type { RecapResponse, WorkingStyleResponse } from "../types";

function recapPose(error: unknown, requests: number | undefined, notes: { text: string }[]): YaldiArtworkState {
  if (error) return "error";
  if (!requests) return "empty";
  return notes.some(note => note.text.startsWith("Too little data")) ? "insufficient" : "analysing";
}

/** A summary, not evidence: its numbers never link to a Labs case. Static, and complete with the artwork hidden. */
function CaseFile() {
  const { filters } = useFilters();
  const { hideArtwork } = usePreferences();
  const { theme } = useTheme();
  const [includeNames, setIncludeNames] = useState(false);
  const params = new URLSearchParams({ format: "json", recap: "1", last: "7d" });
  if (filters.tz) params.set("tz", filters.tz);
  const query = useQuery<RecapResponse>({ queryKey: ["/api/report", params.toString()], queryFn: () => fetchJson("/api/report", params.toString()), staleTime: 60_000 });
  const report = query.data?.report;
  const notes = report?.workingStyle?.notes ?? [];
  const pose = recapPose(query.error, report?.kpis.requests, notes);
  const shared = exportNotes(notes, includeNames);
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Case file <span className="font-normal text-muted">recap</span> <InfoTip>A summary of the last 7 days in fixed sentences, not fixed evidence. The same text comes from yald report --recap. Days with data are days with requests, not days of work.</InfoTip></span>}
        subtitle={report?.meta.window.label}
        action={notes.length ? (
          <span className="flex items-center gap-2 text-[11px] text-muted">
            <label className="flex items-center gap-1"><input type="checkbox" className="accent-accent" checked={includeNames} onChange={event => setIncludeNames(event.target.checked)} /> Include session id</label>
            <button type="button" className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-ink-soft transition hover:text-ink"
              onClick={() => void downloadCaseFile({ label: report!.meta.window.label, notes: shared, demo: Boolean(DEMO), art: hideArtwork ? null : `/yaldi/state-${pose}${theme === "dark" ? "-dark" : ""}.svg` })}>
              <Download size={12} /> Export PNG
            </button>
          </span>
        ) : undefined}
      />
      <div className="flex items-start gap-4">
        <YaldiArtwork state={pose} size={80} />
        <StateBlock loading={query.isLoading} error={query.error} empty={!report || report.kpis.requests === 0} emptyLabel="No requests in the last 7 days">
          <ul className="space-y-1.5 text-[12.5px] leading-5 text-ink-soft">
            {notes.map(note => <li key={note.text}>{note.text}</li>)}
          </ul>
        </StateBlock>
      </div>
    </Card>
  );
}

const ARCHETYPE_INFO = "Poke: 1-3 requests. Quick: 4-24. Deep: 25-999 within one local day. Marathon: 1,000 or more, or 25 or more across two or more local days. Labels describe size and span, not value. Clipped sessions may be larger than shown.";

export function WorkingStylePage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<WorkingStyleResponse>("/api/style", filters);
  const data = query.data;

  const mixOption = useMemo(() => {
    if (!data?.totals.sessions) return null;
    const labels = ["Sessions", "Requests", "Priced cost"];
    return stackedBarChart(chartTheme, labels, data.archetypes.map(row => ({
      name: row.name, data: [row.sessionShare, row.requestShare, row.costShare].map(value => (value === null ? null : value * 100)),
    })), { horizontal: true, formatter: value => `${Math.round(value)}%` });
  }, [data, chartTheme]);
  const peaksOption = useMemo(() => {
    if (!data?.concurrency.peakHistogram.length) return null;
    return barChart(chartTheme, data.concurrency.peakHistogram.map(entry => String(entry.peak)), data.concurrency.peakHistogram.map(entry => entry.days), { formatter: value => formatInteger(value), color: () => colorAt(0) });
  }, [data, chartTheme]);
  const dayOption = useMemo(() => {
    if (!data?.concurrency.busiestSeries.length) return null;
    const labels = data.concurrency.busiestSeries.map(point => new Date(point.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
    const option = lineChart(chartTheme, labels, [{ name: "Sessions", data: data.concurrency.busiestSeries.map(point => point.sessions) }], { formatter: value => formatInteger(value), showLegend: false }) as { series: Record<string, unknown>[] };
    return { ...option, series: option.series.map(series => ({ ...series, step: "end", smooth: false })) };
  }, [data, chartTheme]);
  const hoursOption = useMemo(() => {
    if (!data?.totals.requests) return null;
    return barChart(chartTheme, data.hours.map(entry => String(entry.hour).padStart(2, "0")), data.hours.map(entry => entry.requests), { formatter: value => formatInteger(value), color: index => colorAt(index < 6 ? 3 : 0) });
  }, [data, chartTheme]);
  const busiestDayRequests = Math.max(1, ...(data?.activity.days.map(day => day.requests) ?? [0]));

  return (
    <div className="space-y-3">
      <CaseFile />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sessions" value={data ? formatInteger(data.totals.sessions) : "—"} hint={data?.totals.requestsWithoutSession ? `${formatInteger(data.totals.requestsWithoutSession)} requests without a session` : undefined} />
        <Stat label="Peak at once" value={data?.concurrency.busiestDay ? formatInteger(data.concurrency.maxPeak) : "—"} hint={data?.concurrency.busiestDay ?? undefined} info="Most sessions with a request in one 10-minute bin. Sessions left open but idle are not counted." />
        <Stat label="Days with data" value={data ? `${formatInteger(data.activity.activeDays)} of ${formatInteger(data.activity.windowDays)}` : "—"} hint={data ? `longest run ${formatInteger(data.activity.longestStreak)}, current ${formatInteger(data.activity.currentStreak)}` : undefined} info="Days with at least one request. A day without data may be a day without work, a source that was not running, or a gap." />
        <Stat label="Night share" value={formatPercent(data?.night.share ?? null)} hint="00:00-05:59 local clock" info="Requests by the selected time zone's clock. It says nothing about sleep, overtime or health." />
      </div>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5">Session shapes <InfoTip>{ARCHETYPE_INFO}</InfoTip></span>} />
        <StateBlock loading={query.isLoading} error={query.error} empty={!mixOption} emptyLabel="No sessions in this window">
          {mixOption ? <Chart option={mixOption} height={190} /> : null}
          <Expandable items={data?.archetypes.filter(row => row.sessions > 0) ?? []}>
            {rows => (
              <TableShell>
                <thead>
                  <tr><Th>Shape</Th><Th align="right">Sessions</Th><Th align="right">Requests</Th><Th align="right">Priced cost</Th><Th align="right">Median requests</Th><Th align="right">Median span</Th><Th align="right">Unpriced</Th><Th align="right">Clipped</Th></tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.name}>
                      <Td className="font-medium text-ink">{row.name}</Td>
                      <Td align="right">{formatInteger(row.sessions)}</Td>
                      <Td align="right">{formatInteger(row.requests)}</Td>
                      <Td align="right">{formatUsd(row.costUsd)}</Td>
                      <Td align="right">{row.medianRequests === null ? "—" : formatInteger(row.medianRequests)}</Td>
                      <Td align="right">{formatDuration(row.medianSpanMs)}</Td>
                      <Td align="right">{formatInteger(row.unpricedRequests)}</Td>
                      <Td align="right">{formatInteger(row.clippedSessions)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Expandable>
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Sessions at once" subtitle="Days by their busiest 10 minutes" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!peaksOption}>
            {peaksOption ? <Chart option={peaksOption} height={220} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="The busiest day" subtitle={data?.concurrency.busiestDay ?? undefined} />
          <StateBlock loading={query.isLoading} error={query.error} empty={!dayOption}>
            {dayOption ? <Chart option={dayOption} height={220} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Days with data" subtitle="Darker days have more requests" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data?.activity.activeDays}>
            <div className="grid grid-cols-7 gap-1" role="img" aria-label={data ? `${data.activity.activeDays} of ${data.activity.windowDays} days have data` : undefined}>
              {data?.activity.days.map(day => (
                <span key={day.date} title={`${day.date}: ${formatInteger(day.requests)} requests`} className="h-4 rounded-sm border border-line"
                  style={{ background: day.requests ? "var(--accent)" : "transparent", opacity: day.requests ? 0.3 + 0.7 * (day.requests / busiestDayRequests) : 1 }} />
              ))}
            </div>
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Requests by hour" subtitle="00-05 is night on the local clock" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hoursOption}>
            {hoursOption ? <Chart option={hoursOption} height={220} /> : null}
          </StateBlock>
        </Card>
      </div>
    </div>
  );
}
