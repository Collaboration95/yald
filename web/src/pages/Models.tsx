import { useMemo, useState } from "react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, ProgressBar, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, scatterChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatInteger, formatPercent } from "../lib/format";
import type { BreakdownRow, ModelsResponse } from "../types";

type SortKey = "tokens" | "requests" | "cost" | "ttftP50" | "p50DurationMs" | "outputTokensPerSecond" | "successRate" | "costPer1MTokens";

export function ModelsPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const [sort, setSort] = useState<SortKey>("tokens");
  const [asc, setAsc] = useState(false);
  const query = useEndpoint<ModelsResponse>("/api/models", filters);
  const data = query.data;

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.models].sort((a, b) => {
      const left = (a[sort] ?? -1) as number;
      const right = (b[sort] ?? -1) as number;
      return asc ? left - right : right - left;
    });
  }, [data, sort, asc]);

  const priceVsSpeed = useMemo(() => {
    if (!data) return null;
    const points = data.scatter.filter(entry => (entry.costPer1MTokens ?? 0) > 0 && entry.ttftP50 !== null);
    return scatterChart(chartTheme, [{
      name: "Models",
      points: points.map(entry => [entry.ttftP50 as number, entry.costPer1MTokens as number, entry.tokens] as [number, number, number]),
    }], {
      xFormatter: value => `${(value / 1000).toFixed(1)}s`,
      yFormatter: value => `$${value.toFixed(2)}`,
      xName: "TTFT p50 (s)",
      yName: "$ per 1M tokens",
      scaleSize: 40,
    });
  }, [data, chartTheme]);

  const tokenShareOption = useMemo(() => {
    if (!data) return null;
    const top = data.models.slice(0, 12);
    return barChart(chartTheme, top.map(model => model.key), top.map(model => model.tokens), {
      formatter: value => formatCompact(value),
      horizontal: true,
    });
  }, [data, chartTheme]);

  const providerOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.providers.map(provider => provider.key), data.providers.map(provider => provider.tokens), {
      formatter: value => formatCompact(value),
      horizontal: true,
      color: "#2563eb",
    });
  }, [data, chartTheme]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setAsc(current => !current);
    else {
      setSort(key);
      setAsc(key === "ttftP50" || key === "p50DurationMs" || key === "costPer1MTokens");
    }
  };

  const effortMatrix = useMemo(() => {
    if (!data || data.effortMatrix.length === 0) return null;
    const totals = new Map<string, number>();
    for (const row of data.effortMatrix) {
      for (const [model, value] of Object.entries(row.values)) {
        totals.set(model, (totals.get(model) ?? 0) + value);
      }
    }
    const topModels = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([model]) => model);
    const max = Math.max(...data.effortMatrix.flatMap(row => topModels.map(model => row.values[model] ?? 0)), 1);
    return { rows: data.effortMatrix, models: topModels, max };
  }, [data]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Price vs time-to-first-token" subtitle="Bubble size is total tokens; cheaper and faster sits bottom-left" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.scatter.length === 0}>
            {priceVsSpeed ? <Chart option={priceVsSpeed} height={300} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Tokens by provider" subtitle="Where the volume is routed" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.providers.length === 0}>
            {providerOption ? <Chart option={providerOption} height={300} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Tokens by model" subtitle="Top twelve models in the selected window" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.models.length === 0}>
            {tokenShareOption ? <Chart option={tokenShareOption} height={Math.max(220, Math.min(420, (data?.models.slice(0, 12).length ?? 0) * 30 + 40))} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Effort mix" subtitle="Tokens routed per reasoning effort" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.efforts.length === 0}>
            <ul className="space-y-2.5">
              {data?.efforts.map(effort => (
                <li key={effort.key}>
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="font-medium text-ink">{effort.key}</span>
                    <span className="num text-muted">
                      {formatCompact(effort.tokens)} · {formatPercent(effort.share)}
                    </span>
                  </div>
                  <ProgressBar value={effort.share} max={data.efforts[0]?.share ?? 1} className="mt-1.5" />
                  <p className="mt-1 text-[10.5px] text-muted">
                    p50 {formatDuration(effort.p50DurationMs)} · {effort.outputTokensPerSecond ? effort.outputTokensPerSecond.toFixed(1) : "—"} tok/s · {formatPercent(effort.successRate)} ok
                  </p>
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Model comparison" subtitle="Click a column header to sort; rates come from the opencodex pricing engine" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.models.length === 0}>
          <TableShell className="max-h-[520px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Model</Th>
                <Th align="right" active={sort === "requests"} asc={asc} onClick={() => toggleSort("requests")}>Req</Th>
                <Th align="right" active={sort === "tokens"} asc={asc} onClick={() => toggleSort("tokens")}>Tokens</Th>
                <Th align="right">Share</Th>
                <Th align="right" active={sort === "cost"} asc={asc} onClick={() => toggleSort("cost")}>Cost</Th>
                <Th align="right" active={sort === "costPer1MTokens"} asc={asc} onClick={() => toggleSort("costPer1MTokens")}>$/1M</Th>
                <Th align="right" active={sort === "ttftP50"} asc={asc} onClick={() => toggleSort("ttftP50")}>TTFT p50</Th>
                <Th align="right" active={sort === "p50DurationMs"} asc={asc} onClick={() => toggleSort("p50DurationMs")}>p50</Th>
                <Th align="right" active={sort === "outputTokensPerSecond"} asc={asc} onClick={() => toggleSort("outputTokensPerSecond")}>tok/s</Th>
                <Th align="right" active={sort === "successRate"} asc={asc} onClick={() => toggleSort("successRate")}>Success</Th>
                <Th align="right">Cache</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((model: BreakdownRow) => (
                <tr key={model.key} className="transition hover:bg-surface-2">
                  <Td className="max-w-[240px] truncate font-medium text-ink">{model.key}</Td>
                  <Td align="right">{formatInteger(model.requests)}</Td>
                  <Td align="right">{formatCompact(model.tokens)}</Td>
                  <Td align="right">{formatPercent(model.share)}</Td>
                  <Td align="right">{model.cost > 0 ? `$${model.cost.toFixed(2)}` : <span className="text-muted">unpriced</span>}</Td>
                  <Td align="right">{model.costPer1MTokens ? `$${model.costPer1MTokens.toFixed(2)}` : "—"}</Td>
                  <Td align="right">{formatDuration(model.ttftP50)}</Td>
                  <Td align="right">{formatDuration(model.p50DurationMs)}</Td>
                  <Td align="right">{model.outputTokensPerSecond ? model.outputTokensPerSecond.toFixed(1) : "—"}</Td>
                  <Td align="right" className={model.successRate !== null && model.successRate < 0.95 ? "text-bad" : undefined}>{formatPercent(model.successRate)}</Td>
                  <Td align="right">{formatPercent(model.cacheHitRate)}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>

      {effortMatrix ? (
        <Card>
          <CardHeader title="Effort × model matrix" subtitle="Tokens per reasoning effort for the busiest models" />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr>
                  <th className="border-b border-line px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted">Effort</th>
                  {effortMatrix.models.map(model => (
                    <th key={model} className="border-b border-line px-2 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted">{model}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {effortMatrix.rows.map(row => (
                  <tr key={row.effort}>
                    <td className="border-b border-line/70 px-2 py-1.5 font-medium text-ink">{row.effort}</td>
                    {effortMatrix.models.map(model => {
                      const value = row.values[model] ?? 0;
                      const intensity = value / effortMatrix.max;
                      return (
                        <td key={row.effort + model} className="border-b border-line/70 px-2 py-1.5 text-right">
                          <span
                            className="inline-block rounded px-1.5 py-0.5"
                            style={{
                              background: value > 0 ? `color-mix(in oklab, var(--accent) ${Math.max(8, intensity * 70)}%, transparent)` : undefined,
                              color: intensity > 0.45 ? "white" : undefined,
                            }}
                          >
                            {value > 0 ? formatCompact(value) : "—"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
