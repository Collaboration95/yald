import { useMemo } from "react";
import { AlertTriangle, BatteryCharging, Clock, Flame } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Legend, ProgressBar, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { lineChart, stackedBarChart } from "../components/chartOptions";
import { formatCompact, formatCountdown, formatDateTime, formatInteger, formatRelative, shortId } from "../lib/format";
import type { LedgerResponse, QuotaResponse } from "../types";

const RANGE_LABELS: Record<string, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  "90d": "the last 90 days",
  all: "the full history",
};

function Gauge({ percent, tone }: { percent: number; tone: "accent" | "warn" | "bad" }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * circumference;
  const colors: Record<string, string> = { accent: "var(--accent)", warn: "var(--warn)", bad: "var(--bad)" };
  return (
    <div className="relative flex flex-col items-center">
      <svg viewBox="0 0 80 80" className="h-[76px] w-[76px] -rotate-90">
        <circle cx="40" cy="40" r={radius} fill="none" stroke="var(--line)" strokeWidth="7" />
        <circle cx="40" cy="40" r={radius} fill="none" stroke={colors[tone]} strokeWidth="7" strokeLinecap="round" strokeDasharray={dash + " " + circumference} />
      </svg>
      <span className="num absolute top-[26px] text-[17px] font-semibold text-ink">{percent.toFixed(0)}%</span>
    </div>
  );
}

export function QuotaPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const quotaQuery = useEndpoint<QuotaResponse>("/api/quota", filters);
  const ledger = useEndpoint<LedgerResponse>("/api/ledger", filters);
  const quota = quotaQuery.data;

  const visibleSeries = useMemo(() => (quota?.series ?? []).filter(entry => entry.points.length > 0).slice(0, 6), [quota]);

  const seriesOption = useMemo(() => {
    if (visibleSeries.length === 0) return null;
    const times = [...new Set(visibleSeries.flatMap(entry => entry.points.map(point => point.ts)))].sort((a, b) => a - b);
    const labels = times.map(ts => new Date(ts).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit" }));
    const series = visibleSeries.map(entry => {
      const byTime = new Map(entry.points.map(point => [point.ts, point.usedPercent]));
      return {
        name: (entry.account === "__main__" ? "main policy" : shortId(entry.account, 10)) + " · " + entry.window,
        data: times.map(ts => byTime.get(ts) ?? null),
      };
    });
    return lineChart(chartTheme, labels, series, { formatter: value => value.toFixed(0) + "%" });
  }, [visibleSeries, chartTheme]);

  const ledgerOption = useMemo(() => {
    if (!ledger.data || ledger.data.buckets.length === 0) return null;
    return stackedBarChart(chartTheme, ledger.data.buckets.map(bucket => bucket.label), [
      { name: "settled sends", data: ledger.data.buckets.map(bucket => bucket.settled) },
    ], { formatter: value => formatCompact(value, 0), showLegend: false });
  }, [ledger.data, chartTheme]);

  const tokensOption = useMemo(() => {
    if (!ledger.data || ledger.data.buckets.length === 0) return null;
    return lineChart(chartTheme, ledger.data.buckets.map(bucket => bucket.label), [
      { name: "settled tokens", data: ledger.data.buckets.map(bucket => bucket.tokens), area: true },
    ], { formatter: value => formatCompact(value), showLegend: false });
  }, [ledger.data, chartTheme]);

  const windowLabel = RANGE_LABELS[filters.range] ?? filters.range;
  const primary = quota?.windows.find(window => window.account === "__main__") ?? quota?.windows[0];
  const primaryBurn = primary ? quota?.burn.find(entry => entry.account === primary.account && entry.window === primary.window) : undefined;
  const samplesInWindow = quota?.observed.samples ?? 0;
  const hasChart = visibleSeries.some(entry => entry.points.length >= 2);
  const lastSample = quota?.observed.last ?? null;
  const noSamplesLabel = lastSample
    ? "No quota samples in " + windowLabel + " — the proxy last reported " + formatRelative(lastSample) + "."
    : "No quota samples recorded yet";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={primary ? primary.window + " window" : "Quota"}
          value={primary ? primary.usedPercent + "%" : "—"}
          hint={primary ? (primary.account === "__main__" ? "main policy" : shortId(primary.account, 14)) + " · updated " + formatRelative(primary.updatedAt) : undefined}
          tone={primary && primary.usedPercent >= 90 ? "bad" : primary && primary.usedPercent >= 70 ? "warn" : "good"}
          icon={<BatteryCharging size={13} />}
        />
        <Stat
          label="Burn rate"
          value={primaryBurn?.status === "measured" ? primaryBurn.percentPerDay.toFixed(2) + "%" : "—"}
          hint={primaryBurn?.status === "measured" ? "Measured over " + windowLabel : "Needs two samples in " + windowLabel}
          tone="info"
        />
        <Stat
          label="Resets"
          value={primary?.resetAtMs ? formatCountdown(primary.resetAtMs) : "—"}
          hint={primary?.resetAtMs ? formatDateTime(primary.resetAtMs) : "no reset reported"}
          icon={<Clock size={13} />}
        />
        <Stat
          label="Projected exhaustion"
          value={primaryBurn?.status === "measured" && primaryBurn.projectedExhaustionAt ? formatCountdown(primaryBurn.projectedExhaustionAt) : "—"}
          hint={
            primaryBurn?.status !== "measured"
              ? "Needs two samples in " + windowLabel
              : primaryBurn.willExhaustBeforeReset
                ? "Before the window resets"
                : "Window resets first"
          }
          tone={primaryBurn?.willExhaustBeforeReset ? "bad" : "good"}
          icon={primaryBurn?.willExhaustBeforeReset ? <Flame size={13} /> : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Utilisation history"
            subtitle={
              "Showing " + formatInteger(samplesInWindow) + " samples from " + windowLabel +
              (visibleSeries.some(entry => entry.baselineIncluded) ? " · one earlier sample kept as a baseline" : "")
            }
            action={<Badge tone="info">{formatInteger(quota?.observed.samples ?? 0)} samples</Badge>}
          />
          <StateBlock loading={quotaQuery.isLoading} error={quotaQuery.error} empty={!seriesOption || !hasChart} emptyLabel={noSamplesLabel}>
            {seriesOption ? <Chart option={seriesOption} height={260} /> : null}
          </StateBlock>
          {hasChart && samplesInWindow === 0 ? (
            <p className="mt-2 text-[10.5px] text-muted">
              No samples inside {windowLabel}; the line keeps the last reported value so you can still see the level.
            </p>
          ) : null}
        </Card>
        <Card>
          <CardHeader title="Current windows" subtitle="Latest reported utilisation per plan window" />
          <StateBlock
            loading={quotaQuery.isLoading}
            error={quotaQuery.error}
            empty={!quota || quota.windows.length === 0}
            emptyLabel="No quota windows recorded yet"
          >
            <div className="grid grid-cols-2 gap-2">
              {quota?.windows.map(window => (
                <div key={window.account + window.window} className="rounded-xl border border-line p-2.5">
                  <Gauge percent={window.usedPercent} tone={window.usedPercent >= 90 ? "bad" : window.usedPercent >= 70 ? "warn" : "accent"} />
                  <p className="mt-1.5 text-center text-[10.5px] font-medium text-ink-soft">
                    {window.window} · {window.account === "__main__" ? "main" : shortId(window.account, 10)}
                  </p>
                  <p className="text-center text-[10px] text-muted">{window.resetAtMs ? "resets " + formatCountdown(window.resetAtMs) : "—"}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-4 text-muted">
              Utilisation is a point-in-time value from the latest provider response, so it does not change with the range selector.
                The history chart and burn rate below do.
            </p>
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Settled sends" subtitle={"Physical upstream sends that reached a terminal status · " + windowLabel} />
          <StateBlock loading={ledger.isLoading} error={ledger.error} empty={!ledgerOption} emptyLabel="No send activity in this range">
            {ledgerOption ? <Chart option={ledgerOption} height={230} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Settled tokens" subtitle={"Token volume charged back through send accounting · " + windowLabel} />
          <StateBlock loading={ledger.isLoading} error={ledger.error} empty={!tokensOption} emptyLabel="No send activity in this range">
            {tokensOption ? <Chart option={tokensOption} height={230} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Burn table" subtitle={"Rate measured over " + windowLabel + ", projected forward to the reset"} />
        <StateBlock loading={quotaQuery.isLoading} error={quotaQuery.error} empty={!quota || quota.burn.length === 0}>
          <TableShell>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Window</Th>
                <Th align="right">Used now</Th>
                <Th align="right">%/day</Th>
                <Th align="right">Resets</Th>
                <Th align="right">Projected exhaustion</Th>
                <Th align="center">Risk</Th>
              </tr>
            </thead>
            <tbody>
              {quota?.burn.map(entry => (
                <tr key={entry.account + entry.window} className="transition hover:bg-surface-2">
                  <Td className="max-w-[200px] truncate">{entry.account === "__main__" ? "main policy" : entry.account}</Td>
                  <Td>{entry.window}</Td>
                  <Td align="right">
                    <span className="inline-flex w-[110px] items-center gap-1.5">
                      <ProgressBar value={entry.usedPercent} max={100} tone={entry.usedPercent >= 90 ? "bad" : entry.usedPercent >= 70 ? "warn" : "accent"} />
                      <span className="num">{entry.usedPercent}%</span>
                    </span>
                  </Td>
                  <Td align="right">
                    {entry.status === "insufficient"
                      ? <span className="text-muted">no data in range</span>
                      : entry.percentPerDay > 0
                        ? entry.percentPerDay.toFixed(2)
                        : <span className="text-muted">flat</span>}
                  </Td>
                  <Td align="right">{entry.resetAtMs ? formatDateTime(entry.resetAtMs) : "—"}</Td>
                  <Td align="right">{entry.status === "measured" && entry.projectedExhaustionAt ? formatDateTime(entry.projectedExhaustionAt) : "—"}</Td>
                  <Td align="center">
                    {entry.status === "insufficient"
                      ? <Badge tone="neutral">insufficient data</Badge>
                      : entry.willExhaustBeforeReset
                        ? <Badge tone="bad"><AlertTriangle size={10} /> exhausts first</Badge>
                        : <Badge tone="good">resets first</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader title="Send accounting" subtitle={"Reserve, dispatch and settle accounting · " + windowLabel} />
          <StateBlock loading={ledger.isLoading} error={ledger.error} empty={!ledger.data}>
            <ul className="space-y-2.5 text-[11.5px]">
              {Object.entries(ledger.data?.byKind ?? {}).map(([kind, count]) => (
                <li key={kind} className="flex items-center justify-between">
                  <span className="text-ink-soft">{kind}</span>
                  <span className="num text-ink">{formatInteger(count)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between border-t border-line pt-2">
                <span className="text-ink-soft">settled tokens</span>
                <span className="num font-semibold text-ink">{formatCompact(ledger.data?.settledTokens ?? 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-ink-soft">distinct sends</span>
                <span className="num text-ink">{formatInteger(ledger.data?.distinctSends ?? 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-ink-soft">largest single send</span>
                <span className="num text-ink">{formatCompact(ledger.data?.largestSend ?? 0)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-ink-soft">median send</span>
                <span className="num text-ink">{formatCompact(ledger.data?.medianSend ?? 0)}</span>
              </li>
            </ul>
          </StateBlock>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="How to read this" subtitle="What opencodex does and does not know about quota" />
          <div className="space-y-2 text-[11.5px] leading-5 text-ink-soft">
            <p><strong className="text-ink">Current utilisation</strong> comes from the latest provider response header, so it is point-in-time and independent of the range selector.</p>
            <p><strong className="text-ink">Burn rate</strong> is measured from the samples inside the selected range, which is why switching between 24h, 7d and 30d changes it. One sample before the range is kept so short ranges still show the change across their boundary.</p>
            <p><strong className="text-ink">Settled sends</strong> count physical upstream calls, which is larger than logical requests whenever a retry or combo fan-out happened. Lost entries are sends charged with no terminal outcome.</p>
            <p className="rounded-xl bg-surface-2 p-2.5 text-[11px] text-muted">
              Quota samples refresh while the proxy runs. Send history rotates, so older ranges may show fewer sends than requests.
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="All quota series" subtitle={"Accounts and windows captured in " + windowLabel} />
        <StateBlock loading={quotaQuery.isLoading} error={quotaQuery.error} empty={visibleSeries.length === 0} emptyLabel={"No samples in " + windowLabel}>
          <Legend
            items={visibleSeries.map((entry, index) => ({
              label: entry.account + " · " + entry.window,
              color: ["#16a34a", "#2563eb", "#7c3aed", "#f59e0b", "#0ea5e9", "#e11d48"][index % 6]!,
              value: formatInteger(entry.sampleCount) + " samples in range · latest " + (entry.points[entry.points.length - 1]?.usedPercent ?? 0) + "%",
            }))}
          />
        </StateBlock>
      </Card>
    </div>
  );
}
