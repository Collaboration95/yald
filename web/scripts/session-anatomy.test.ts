import { describe, expect, test } from "bun:test";
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
