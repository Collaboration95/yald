import { useMemo } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Legend, ModelTag, ProgressBar, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, donutChart, stackedBarChart } from "../components/chartOptions";
import { OUTCOME_COLORS } from "../lib/palette";
import { formatCompact, formatDateTime, formatDuration, formatInteger, formatPercent, formatRelative } from "../lib/format";
import type { ReliabilityResponse } from "../types";

export function ReliabilityPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<ReliabilityResponse>("/api/reliability", filters);
  const data = query.data;

  const outcomeOption = useMemo(() => {
    if (!data) return null;
    return donutChart(chartTheme, data.outcomes, {
      formatter: value => formatInteger(value),
      colors: OUTCOME_COLORS,
      centerValue: formatPercent((data.outcomes.find(entry => entry.name === "ok")?.value ?? 0) / Math.max(1, data.outcomes.reduce((sum, entry) => sum + entry.value, 0))),
      centerLabel: "success",
    });
  }, [data, chartTheme]);

  const statusOption = useMemo(() => {
    if (!data) return null;
    const statuses = data.statuses.slice(0, 8);
    return barChart(chartTheme, statuses.map(status => status.name), statuses.map(status => status.value), {
      formatter: value => formatCompact(value, 0),
      horizontal: true,
      color: index => (statuses[index]?.name.startsWith("2") ? "#16a34a" : statuses[index]?.name.startsWith("4") ? "#f59e0b" : "#dc2626"),
      showLabels: true,
    });
  }, [data, chartTheme]);

  const timelineOption = useMemo(() => {
    if (!data) return null;
    return stackedBarChart(chartTheme, data.errorTimeline.map(point => point.label), [
      { name: "ok", data: data.errorTimeline.map(point => point.ok) },
      { name: "cancelled", data: data.errorTimeline.map(point => point.cancelled) },
      { name: "error", data: data.errorTimeline.map(point => point.error) },
    ], { formatter: value => formatCompact(value, 0) });
  }, [data, chartTheme]);

  const attemptsOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.attempts.map(attempt => `${attempt.name} attempt${attempt.name === "1" ? "" : "s"}`), data.attempts.map(attempt => attempt.value), {
      formatter: value => formatCompact(value, 0),
      color: "#7c3aed",
    });
  }, [data, chartTheme]);

  const totals = data ? data.outcomes.reduce((sum, entry) => sum + entry.value, 0) : 0;
  const successRate = data ? (data.outcomes.find(entry => entry.name === "ok")?.value ?? 0) / Math.max(1, totals) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <Stat label="Requests" value={formatInteger(totals)} hint={data ? `${formatInteger(data.outcomes.find(o => o.name === "error")?.value ?? 0)} failed` : undefined} tone="neutral" />
        <Stat label="Success rate" value={formatPercent(successRate)} hint={data ? `${formatInteger(data.outcomes.find(o => o.name === "cancelled")?.value ?? 0)} client-closed` : undefined} tone={successRate > 0.97 ? "good" : "warn"} icon={<ShieldCheck size={13} />} />
        <Stat label="Distinct errors" value={data ? String(data.errors.length) : "—"} hint={data?.errors[0] ? `top: ${data.errors[0].name}` : undefined} tone="bad" icon={<AlertTriangle size={13} />} />
        <Stat label="Retried requests" value={data ? formatInteger(data.attempts.filter(attempt => attempt.name !== "1").reduce((sum, attempt) => sum + attempt.value, 0)) : "—"} hint="More than one upstream attempt" tone="warn" />
        <Stat
          label="Metered"
          value={data ? formatPercent(data.metering.coverage, 1) : "—"}
          hint={data ? `${formatInteger(data.metering.unreported + data.metering.unsupported)} rows without usage` : undefined}
          tone={data && data.metering.coverage < 0.9 ? "warn" : "info"}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader title="Outcomes" subtitle="Success, failure and client cancellation" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            <div className="flex items-center gap-3">
              {outcomeOption ? <Chart option={outcomeOption} height={180} className="max-w-[180px]" /> : null}
              <Legend
                items={(data?.outcomes ?? []).map(entry => ({
                  label: entry.name,
                  color: OUTCOME_COLORS[entry.name] ?? "#64748b",
                  value: formatInteger(entry.value),
                }))}
              />
            </div>
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="HTTP status codes" subtitle="What the proxy actually returned" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {statusOption ? <Chart option={statusOption} height={180} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Attempts per request" subtitle="Retry behaviour across the window" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {attemptsOption ? <Chart option={attemptsOption} height={180} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Outcomes over time" subtitle="Failures tend to cluster — this shows when" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.errorTimeline.length === 0}>
          {timelineOption ? <Chart option={timelineOption} height={240} /> : null}
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Error breakdown" subtitle="Grouped by the proxy's error code" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.errors.length === 0}>
            <TableShell>
              <thead>
                <tr>
                  <Th>Error</Th>
                  <Th align="right">Count</Th>
                  <Th align="right">Models</Th>
                  <Th align="right">Last seen</Th>
                  <Th align="right">Tokens burned</Th>
                </tr>
              </thead>
              <tbody>
                {data?.errors.map(error => (
                  <tr key={error.name} className="transition hover:bg-surface-2">
                    <Td className="font-medium text-ink">{error.name}</Td>
                    <Td align="right">{formatInteger(error.value)}</Td>
                    <Td align="right">{error.models}</Td>
                    <Td align="right" className="text-muted">{formatRelative(error.lastSeen)}</Td>
                    <Td align="right">{error.tokens > 0 ? formatCompact(error.tokens) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </StateBlock>
        </Card>

        <Card>
          <CardHeader title="Failure rate by model" subtitle="Failures as a share of that model's traffic" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.failureByModel.length === 0}>
            <ul className="space-y-2.5">
              {data?.failureByModel.slice(0, 10).map(model => (
                <li key={model.name}>
                  <div className="flex items-center justify-between gap-2">
                    <ModelTag model={model.name} className="max-w-[240px] text-[11.5px]" />
                    <span className="num shrink-0 text-[11px] text-muted">
                      {formatInteger(model.failures)} / {formatInteger(model.requests)} · {formatPercent(model.rate)}
                    </span>
                  </div>
                  <ProgressBar value={model.rate} max={Math.max(...data.failureByModel.map(entry => entry.rate), 0.01)} tone={model.rate > 0.1 ? "bad" : "warn"} className="mt-1.5" />
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent failures"
          subtitle="Newest non-success rows with their error codes"
          action={<span className="text-[11px] text-muted">failed tokens are billed upstream even when no usage is reported</span>}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.recentFailures.length === 0}>
          <TableShell>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Model</Th>
                <Th>Error</Th>
                <Th align="right">Attempts</Th>
                <Th align="right">Waited</Th>
                <Th align="center">Status</Th>
              </tr>
            </thead>
            <tbody>
              {data?.recentFailures.map(row => (
                <tr key={row.id} className="transition hover:bg-surface-2">
                  <Td className="whitespace-nowrap text-muted">{formatDateTime(row.ts)}</Td>
                  <Td><ModelTag model={row.model} provider={row.provider} className="max-w-[200px]" /></Td>
                  <Td className="max-w-[220px] truncate text-bad">{row.errorCode ?? row.closeReason ?? "unknown"}</Td>
                  <Td align="right">{row.attempts}</Td>
                  <Td align="right">{formatDuration(row.durationMs)}</Td>
                  <Td align="center" className="text-muted">{row.status}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>
    </div>
  );
}
