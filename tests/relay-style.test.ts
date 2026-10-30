import { describe, expect, test } from "bun:test";
import { makeRelayStyle } from "../web/src/lib/relayStyle";
import type { ChartOption } from "../web/src/components/Chart";
import {
  barChart, boxplotChart, pairedBarChart, heatmapChart, lineChart, scatterChart,
  stackedAreaChart, stackedBarChart, type ThemeTokens,
} from "../web/src/components/chartOptions";
import { formatCompact, formatInteger, formatUsd } from "../web/src/lib/format";
import { colorAt, COMPOSITION_COLORS, OUTCOME_COLORS } from "../web/src/lib/palette";

const models = ["gpt-6-sol", "gpt-6-astra", "deepseek-flash", "gpt-6-luna"];
const dates = ["Sep 30", "Oct 01", "Oct 02"];

function theme(dark: boolean): ThemeTokens {
  return dark
    ? { text: "#e8edf6", axis: "#7d899e", split: "#1e293b", tooltipBg: "rgba(14, 21, 34, 0.96)", tooltipBorder: "#2b3a51", area: "rgba(52, 211, 153, 0.14)" }
    : { text: "#12161f", axis: "#7b8496", split: "#eef1f5", tooltipBg: "rgba(255, 255, 255, 0.98)", tooltipBorder: "#e6e9ee", area: "rgba(22, 163, 74, 0.12)" };
}

// EChartsCoreOption deliberately allows extensible option shapes. Keep the
// loose inspection cast here rather than asserting renderer-specific types.
function inspect(option: ChartOption): any { return option; }

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)])) as T;
  }
  return value; // Preserve callbacks, undefined and null; JSON would lose them.
}

function fixtures(tokens: ThemeTokens): [string, ChartOption][] {
  const grouped = [
    { name: "gpt-6-sol", data: [0, 12_500, null] },
    { name: "gpt-6-astra", data: [90_000, 0, 5] },
  ];
  return [
    ["usage / model stacked area", stackedAreaChart(tokens, dates, grouped, { formatter: formatCompact })],
    ["cost / stacked columns", stackedBarChart(tokens, dates, [
      { name: "gpt-6-sol", data: [0, 0.0025, null] },
      { name: "gpt-6-astra", data: [1.25, 0, 2.5] },
    ], { formatter: formatUsd })],
    ["horizontal stacked bars", stackedBarChart(tokens, dates, grouped, { horizontal: true, showLegend: false })],
    ["performance / nullable percentile lines", lineChart(tokens, dates, [
      { name: "Latency p50", data: [0, null, 3500] },
      { name: "TTFT p95", data: [null, 0, 900], dashed: true },
    ], { formatter: value => `${(value / 1000).toFixed(1)}s` })],
    ["quota / percent timeline", lineChart(tokens, dates, [
      { name: "main policy · 5h", data: [0, null, 100], area: true },
    ], { formatter: value => `${value.toFixed(0)}%`, showLegend: false })],
    ["context / histogram", barChart(tokens, ["0–8k", "8–32k", "32k+"], [0, 1200, 7], { formatter: formatInteger, color: "#7c3aed" })],
    ["models / horizontal ranking", barChart(tokens, models, [0, 12500, 3, 700], { horizontal: true, formatter: formatCompact, showLabels: true })],
    ["usage / activity heatmap", heatmapChart(tokens, [
      { weekday: 6, hour: 23, value: 0, requests: 0 },
      { weekday: 0, hour: 0, value: 10, requests: 2 },
      { weekday: 2, hour: 17, value: 25000, requests: 9 },
    ], 25000, { formatter: formatCompact, unit: "tokens" })],
    ["context / box plot per model", boxplotChart(tokens, [
      { label: "gpt-6-sol", box: [800, 4_000, 20_000, 90_000, 240_000], p99: 410_000, max: 520_000, n: 400 },
      { label: "tiny", box: null, p99: null, max: 3_000, n: 4 },
      { label: "zero-floor", box: [0, 0, 10, 50, 90], p99: null, max: 120, n: 12 },
    ], { formatter: formatCompact })],
    ["cost / tokens beside cost by class", pairedBarChart(tokens, ["Fresh input", "Cache read"], [
      { name: "Share of tokens", data: [0.02, null] }, { name: "Share of cost", data: [0.25, 0.5] },
    ], { formatter: value => `${(value * 100).toFixed(1)}%` })],
    ["cost / class mix share area", stackedAreaChart(tokens, dates, [
      { name: "Fresh input", data: [0.2, null, 0.1] }, { name: "Output", data: [0.8, null, 0.9] },
    ], { formatter: value => `${Math.round(value * 100)}%`, colors: COMPOSITION_COLORS, max: 1 })],
    ["context / p50 and p90 by source", lineChart(tokens, dates, [
      { name: "Claude Code p50", data: [1000, null, 5000], color: "#16a34a" },
      { name: "Claude Code p90", data: [4000, null, 9000], color: "#16a34a", dashed: true },
    ], { formatter: formatCompact, preserveGaps: true })],
    ["models / price versus speed bubbles", scatterChart(tokens, [{
      name: "Models", points: [[0, 0.0025, 0], [1500, 2.5, 160000], [3000, 0.125]],
    }], { xName: "TTFT p50 (s)", yName: "$ per 1M tokens", xFormatter: value => `${(value / 1000).toFixed(1)}s`, yFormatter: formatUsd, scaleSize: 40 })],
    ["performance / model scatter", scatterChart(tokens, [
      { name: "gpt-6-sol", points: [[0, 0, 1], [900, 1200, 1]] },
      { name: "gpt-6-astra", points: [[1500, 24000, 1]] },
    ], { xName: "TTFT", yName: "output tokens", scaleSize: 4 })],
  ];
}

// Data/axis/formatter semantics do not branch on theme. Keep one representative
// theme here; color mapping and theme switching are exercised in both below.
describe("Relay production chart data contracts", () => {
  const dark = false;
  const tokens = theme(dark);
  for (const [name, option] of fixtures(tokens)) {
    test(`${name}: preserves data, axes, series semantics and source options`, () => {
      const before = snapshot(option);
      freeze(option);
      const source = inspect(option);
      const result = inspect(makeRelayStyle(dark, models).chart(option));
      expect(result.series).toHaveLength(source.series.length);
      source.series.forEach((series: any, index: number) => {
        const transformed = result.series[index];
        expect(transformed.data).toEqual(series.data);
        for (const key of ["name", "type", "stack", "connectNulls", "symbol", "symbolSize"] as const) {
          expect(transformed[key]).toBe(series[key]);
        }
        if (series.lineStyle?.type) expect(transformed.lineStyle.type).toBe(series.lineStyle.type);
        if (series.label?.formatter) expect(transformed.label.formatter).toBe(series.label.formatter);
      });
      for (const axis of ["xAxis", "yAxis"] as const) {
        if (!source[axis]) continue;
        for (const key of ["type", "data", "name", "boundaryGap"] as const) {
          expect(result[axis][key]).toEqual(source[axis][key]);
        }
        if (source[axis].axisLabel?.formatter) {
          expect(result[axis].axisLabel.formatter).toBe(source[axis].axisLabel.formatter);
        }
      }
      expect(result.tooltip.formatter).toBe(source.tooltip.formatter);
      expect(result.tooltip.valueFormatter).toBe(source.tooltip.valueFormatter);
      if (source.legend) expect(result.legend.show).toBe(source.legend.show);
      expect(option).toEqual(before);
    });
  }

  test("monetary, percent and latency callbacks retain their units and precision", () => {
    const style = makeRelayStyle(dark, models);
    const money = inspect(style.chart(stackedBarChart(tokens, dates, [
      { name: "gpt-6-sol", data: [0, 0.0025, 1.25] },
    ], { formatter: formatUsd })));
    expect(money.tooltip.valueFormatter(0)).toBe("$0.00");
    expect(money.tooltip.valueFormatter(0.0025)).toBe("$0.0025");
    // Stacked bars originally lack an axis formatter. Relay must not
    // introduce raw-number USD axes while formatting the tooltip as money.
    expect(money.yAxis.axisLabel.formatter(0.0025)).toBe("$0.0025");
    const quota = inspect(style.chart(lineChart(tokens, dates, [
      { name: "main policy · 5h", data: [0, null, 100] },
    ], { formatter: value => `${value.toFixed(0)}%` })));
    expect(quota.tooltip.valueFormatter(0)).toBe("0%");
    expect(quota.yAxis.axisLabel.formatter(100)).toBe("100%");
    const latency = inspect(style.chart(lineChart(tokens, dates, [
      { name: "TTFT p95", data: [null, 0, 1500], dashed: true },
    ], { formatter: value => `${(value / 1000).toFixed(1)}s` })));
    expect(latency.yAxis.axisLabel.formatter(1500)).toBe("1.5s");
    expect(latency.series[0].data).toEqual([null, 0, 1500]);
    expect(latency.series[0].lineStyle.type).toBe("dashed");
  });

  test("heatmap preserves drilldown coordinate order, tooltip indices and all-zero scale", () => {
    const cells = [
      { weekday: 6, hour: 23, value: 0, requests: 0 },
      { weekday: 0, hour: 0, value: 9, requests: 1 },
      { weekday: 2, hour: 17, value: 10, requests: 2 },
      { weekday: 1, hour: 8, value: 25000, requests: 11 },
    ];
    const style = makeRelayStyle(dark, models);
    const original = heatmapChart(tokens, cells, 25000, { formatter: formatCompact, unit: "tokens" });
    const result = inspect(style.chart(freeze(original)));
    expect(result.series[0].data.map((cell: any) => cell.value)).toEqual([
      [23, 6, 0], [0, 0, 9], [17, 2, 10], [8, 1, 25000],
    ]);
    expect(result.tooltip.formatter({ dataIndex: 0 })).toBe("Sun 23:00<br/><b>0 tokens</b><br/>0 requests");
    expect(result.tooltip.formatter({ dataIndex: 2 })).toBe("Wed 17:00<br/><b>10 tokens</b><br/>2 requests");
    expect(result.tooltip.formatter({ dataIndex: 4 })).toBe("");
    expect(result.visualMap.min).toBe(0);
    expect(result.visualMap.max).toBe(25000);
    const allZero = inspect(style.chart(heatmapChart(tokens, [cells[0]!], 0)));
    expect(allZero.series[0].data[0].value).toEqual([23, 6, 0]);
    expect(allZero.visualMap.max).toBe(1);
  });

  test("box plot keeps only measurable rows, floors zero for the log axis and names unavailable percentiles", () => {
    const rows = [
      { label: "a", box: [0, 10, 100, 1000, 5000] as [number, number, number, number, number], p99: null, max: 9000, n: 50 },
      { label: "few", box: null, p99: null, max: 20, n: 3 },
      { label: "b", box: [5, 6, 7, 8, 9] as [number, number, number, number, number], p99: 12, max: 15, n: 700 },
    ];
    const result = inspect(makeRelayStyle(dark, models).chart(freeze(boxplotChart(tokens, rows, { formatter: formatCompact }))));
    expect(result.xAxis.type).toBe("log");
    expect(result.yAxis.data).toEqual(["a", "b"]);
    expect(result.series[0].data).toEqual([[1, 10, 100, 1000, 5000], [5, 6, 7, 8, 9]]);
    // p99 is withheld for "a", so only "b" gets a diamond; both rows get a max ring.
    expect(result.series[1].data).toEqual([[12, 1]]);
    expect(result.series[2].data).toEqual([[9000, 0], [15, 1]]);
    expect(result.tooltip.formatter({ seriesType: "boxplot", dataIndex: 0 })).toContain("p99 too few requests");
    expect(result.tooltip.formatter({ seriesType: "scatter", value: [12, 1] })).toContain("p99 12");
    expect(result.legend?.show ?? false).toBe(false);
  });

  test("paired bars keep an unavailable value as a gap, not zero", () => {
    const result = inspect(makeRelayStyle(dark, models).chart(freeze(pairedBarChart(tokens, ["a", "b"], [{ name: "x", data: [0.1, null] }], { formatter: value => `${value}` }))));
    expect(result.series[0].data).toEqual([0.1, null]);
    expect(result.tooltip.valueFormatter(null)).toBe("Unavailable");
  });

  test("scatter tooltip and bubble area retain all three coordinates, including zero and absent volume", () => {
    const original = scatterChart(tokens, [{ name: "Models", points: [
      [0, 0, 0], [1500, 2.5, 160000], [3000, 0.125], [1000, 5, 100000000],
    ] }], { xName: "TTFT p50 (s)", yName: "$ per 1M tokens", xFormatter: value => `${(value / 1000).toFixed(1)}s`, yFormatter: formatUsd, scaleSize: 40 });
    const result = inspect(makeRelayStyle(dark, models).chart(freeze(original)));
    expect(result.series[0].data).toEqual(inspect(original).series[0].data);
    expect(result.series[0].data.map(result.series[0].symbolSize)).toEqual([8, 10, 8, 40]);
    expect(result.tooltip.formatter({ seriesName: "Models", value: [1500, 2.5, 160000] }))
      .toBe("<b>Models</b><br/>TTFT p50 (s): 1.5s<br/>$ per 1M tokens: $2.50<br/>tokens: 160,000");
    expect(result.xAxis.axisLabel.formatter(0)).toBe("0.0s");
    expect(result.yAxis.axisLabel.formatter(0.0025)).toBe("$0.0025");
  });
});

describe("Relay production chart styles", () => {
  for (const dark of [false, true]) {
    describe(dark ? "dark theme" : "light theme", () => {
      const tokens = theme(dark);

      test("heatmap colors agree with the HTML gradient legend", () => {
        const style = makeRelayStyle(dark, models);
        const result = inspect(style.chart(heatmapChart(tokens, [
          { weekday: 0, hour: 0, value: 10, requests: 1 },
        ], 10)));
        for (const stop of result.visualMap.inRange.color) expect(style.heatmapGradient).toContain(stop);
      });

      test("model colors agree across ranking order, chart families, legends and table tags", () => {
        const style = makeRelayStyle(dark, models);
        const reordered = makeRelayStyle(dark, [...models].reverse());
        expect(new Set(models.map(style.modelColor)).size).toBe(models.length);
        for (const order of [models, [...models].reverse(), [models[2]!, models[0]!]]) {
          const series = order.map((name, index) => ({ name, data: [index, 0, null] }));
          const line = inspect(style.chart(lineChart(tokens, dates, series)));
          const area = inspect(style.chart(stackedAreaChart(tokens, dates, series)));
          const stacked = inspect(style.chart(stackedBarChart(tokens, dates, series)));
          const scatter = inspect(style.chart(scatterChart(tokens, order.map(name => ({ name, points: [[0, 5, 1]] })))));
          const bars = [false, true].map(horizontal => inspect(style.chart(barChart(tokens, order, order.map(() => 0), { horizontal }))));
          order.forEach((name, index) => {
            const expected = style.modelColor(name); // Same accessor used by ModelTag.
            expect(reordered.modelColor(name)).toBe(expected);
            expect(style.colorFor(name, colorAt(index))).toBe(expected); // HTML Legend.
            expect(line.series[index].lineStyle.color).toBe(expected);
            expect(area.series[index].areaStyle.color).toBe(expected);
            expect(stacked.series[index].itemStyle.color).toBe(expected);
            expect(scatter.series[index].itemStyle.color).toBe(expected);
            for (const bar of bars) expect(bar.series[0].itemStyle.color({ dataIndex: index })).toBe(expected);
          });
        }
        const unknown = "new-provider/new-model";
        expect(style.modelColor(unknown)).toBe(reordered.modelColor(unknown));
      });

      test("success, failure and cancellation keep distinct semantic colors in stacked timelines and legends", () => {
        const style = makeRelayStyle(dark, models);
        const entries = [{ name: "cancelled", value: 0 }, { name: "error", value: 2 }, { name: "ok", value: 98 }];
        const timeline = inspect(style.chart(stackedBarChart(tokens, dates, entries.map(entry => ({ name: entry.name, data: [0, entry.value, 0] })))));
        const colors = entries.map((entry, index) => {
          const expected = style.colorFor(entry.name, OUTCOME_COLORS[entry.name]!);
          expect(style.colorFor(entry.name, colorAt(index + 4))).toBe(expected);
          expect(timeline.series[index].itemStyle.color).toBe(expected);
          return expected;
        });
        expect(new Set(colors).size).toBe(3);
      });

      test("restyling the same frozen option across theme changes does not accumulate edits", () => {
        const option = freeze(stackedBarChart(tokens, dates, [
          { name: "gpt-6-sol", data: [0, 0, null] }, { name: "gpt-6-astra", data: [0, 12, 0] },
        ]));
        const before = snapshot(option);
        const style = makeRelayStyle(dark, models);
        const first = style.chart(option);
        makeRelayStyle(!dark, models).chart(option);
        expect(style.chart(option)).toEqual(first);
        expect(option).toEqual(before);
      });
    });
  }
});
