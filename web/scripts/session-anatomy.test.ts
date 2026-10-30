import { describe, expect, test } from "bun:test";
import { contextTimelineOption } from "../src/pages/labs/contextReplayChart";
import { chainName, chainTree } from "../src/pages/SessionAnatomy";
import type { AnatomyChain } from "../src/types";

const chain = (key: string, kind: AnatomyChain["kind"], parent: string | null, costUsd: number): AnatomyChain => ({
  key, kind, parent, costUsd, agentId: null, agentType: kind === "subagent" ? "Explore" : null, model: "m", depth: null, spawn: null, firstAt: 0, lastAt: 0,
  requests: 1, tokens: 10, unpricedRequests: 0, startupCostUsd: null, firstRequestMissing: false, ticks: [], context: [], contextEligible: 0,
});

describe("the cost tree", () => {
  test("a parent's value is the sum of its area and its subagents': a zero root draws an empty chart", () => {
    const tree = chainTree([chain("main", "main", null, 5), chain("a", "subagent", "main", 2), chain("b", "subagent", "a", 1)], "cost", () => "#000");
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ value: 8, children: [{ value: 5 }, { value: 3, children: [{ value: 2 }, { value: 1 }] }] });
  });

  test("a chain whose parent is outside the selection stays at the top level", () => {
    expect(chainTree([chain("a", "subagent", "gone", 2)], "cost", () => "#000").map(node => node.value)).toEqual([2]);
  });

  test("names never call an unmarked chain main", () => {
    expect(chainName(chain("unlabelled", "unlabelled", null, 0))).toBe("Unlabelled");
    expect(chainName(chain("abcdef123", "subagent", null, 0))).toBe("Explore abcdef");
  });
});

describe("the Context Replay chart", () => {
  const theme = { text: "#000", axis: "#111", split: "#222", tooltipBg: "#fff", tooltipBorder: "#333", area: "#444" };
  const request = (ts: number, inputTokens: number) => ({ ts, inputTokens, eligible: true }) as never;
  const event = (ts: number, trigger: string | null) => ({ ts, chain: null, trigger, preTokens: null, postTokens: null, durationMs: null, position: 0, requestsSincePrevious: 0 });

  test("draws no marker without a recorded event, even across an input drop", () => {
    const option = contextTimelineOption(theme, { requests: [request(1, 900), request(2, 10)] }, "UTC") as { series: Record<string, unknown>[] };
    expect(option.series[0]!.markLine).toBeUndefined();
  });

  test("gives each event a blank slot between its two requests, with a text label", () => {
    const option = contextTimelineOption(theme, { requests: [request(10, 900), request(20, 10)] }, "UTC", [event(15, "manual")]) as { series: { data: unknown[]; markLine: { data: unknown[]; label: { formatter: (params: { dataIndex: number }) => string } } }[] };
    expect(option.series[0]!.data).toEqual([900, null, 10]);
    expect(option.series[0]!.markLine.data).toEqual([{ xAxis: 1 }]);
    expect(option.series[0]!.markLine.label.formatter({ dataIndex: 0 })).toBe("manual");
  });
});
