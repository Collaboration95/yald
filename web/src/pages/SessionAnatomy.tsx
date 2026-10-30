import { useMemo, useState } from "react";
import { Badge, Card, CardHeader, Expandable, InfoTip, Segmented, Stat, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { contextTimeChart, swimlaneChart, treemapChart, type TreeNode } from "../components/chartOptions";
import { useChartStyle } from "../lib/chartStyle";
import { colorAt } from "../lib/palette";
import { useTheme } from "../lib/theme";
import { formatCompact, formatDateTime, formatDuration, formatInteger, formatPercent, formatUsd, shortId } from "../lib/format";
import type { AnatomyChain, AnatomyCompaction, SessionAnatomy } from "../types";

type Size = "cost" | "tokens" | "requests";
const SIZE_FIELD = { cost: "costUsd", tokens: "tokens", requests: "requests" } as const;
const KIND_COLOR = { main: 0, subagent: 1, unlabelled: 3 } as const;

export function chainName(chain: Pick<AnatomyChain, "key" | "kind" | "agentType">): string {
  if (chain.kind === "main") return "Main thread";
  if (chain.kind === "unlabelled") return "Unlabelled";
  return `${chain.agentType ?? "Subagent"} ${shortId(chain.key, 6)}`;
}

const cost = (chain: AnatomyChain) => (chain.requests === chain.unpricedRequests ? "—" : `${chain.unpricedRequests ? "≥ " : ""}${formatUsd(chain.costUsd)}`);
const summary = (chain: AnatomyChain) => `<b>${chainName(chain)}</b><br/>${chain.model ?? "—"}<br/>${formatInteger(chain.requests)} requests · ${formatCompact(chain.tokens)} tokens · ${cost(chain)}${chain.spawn || chain.kind !== "subagent" ? "" : "<br/>spawn point not recorded"}`;

/** Chains nested under the chain that spawned them. A chain with children keeps its own area as a child, so sizes still add up. */
export function chainTree(chains: AnatomyChain[], size: Size, color: (chain: AnatomyChain) => string): TreeNode[] {
  const present = new Set(chains.map(chain => chain.key));
  const children = new Map<string | null, AnatomyChain[]>();
  for (const chain of chains) {
    const parent = chain.parent && present.has(chain.parent) ? chain.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), chain]);
  }
  const node = (chain: AnatomyChain): TreeNode => {
    const leaf: TreeNode = { name: chainName(chain), value: chain[SIZE_FIELD[size]], color: color(chain), tooltip: summary(chain) };
    const below = (children.get(chain.key) ?? []).map(node);
    return below.length ? { name: `${chainName(chain)} and its subagents`, value: below.reduce((sum, child) => sum + child.value, leaf.value), children: [leaf, ...below] } : leaf;
  };
  return (children.get(null) ?? []).map(node);
}

function compactionMarkers(events: AnatomyCompaction[]) {
  return events.map(event => ({
    ts: event.ts, label: event.trigger ?? "compaction",
    tooltip: `Recorded compaction (${event.trigger ?? "trigger not recorded"})<br/>${formatDateTime(event.ts)}<br/>${formatCompact(event.preTokens)} → ${formatCompact(event.postTokens)} tokens, Claude Code's own count<br/>${formatDuration(event.durationMs)}`,
  }));
}

export function SessionAnatomySection({ anatomy }: { anatomy: SessionAnatomy }) {
  const { chartTheme } = useTheme();
  const design = useChartStyle();
  const [size, setSize] = useState<Size>("cost");
  const [selected, setSelected] = useState(anatomy.chains[0]?.key ?? "");
  const { chains, compactions, stats } = anatomy;
  const colorOf = useMemo(() => (chain: AnatomyChain) => { const base = colorAt(KIND_COLOR[chain.kind]); return design?.color(base) ?? base; }, [design]);
  const chain = chains.find(item => item.key === selected) ?? chains[0];
  const tree = useMemo(() => treemapChart(chartTheme, chainTree(chains, size, colorOf)), [chains, size, colorOf, chartTheme]);
  const lanes = useMemo(() => {
    const index = new Map(chains.map((item, position) => [item.key, position]));
    const links = chains.flatMap(item => {
      const from = item.parent ? index.get(item.parent) : undefined;
      return item.spawn && from !== undefined ? [{ from, ts: item.spawn.ts, to: index.get(item.key)!, end: item.firstAt }] : [];
    });
    return swimlaneChart(chartTheme, chains.map(item => ({ label: chainName(item), start: item.firstAt, end: item.lastAt, color: colorOf(item), ticks: item.ticks, tooltip: summary(item) })), links);
  }, [chains, chartTheme, colorOf]);
  const context = useMemo(() => (chain && chain.context.length
    ? contextTimeChart(chartTheme, chain.context, compactionMarkers(compactions.filter(event => event.chain === chain.key)), value => formatCompact(value)) : null), [chain, compactions, chartTheme]);
  const unlinked = chains.filter(item => item.kind === "subagent" && !item.spawn).length;
  const { coverage } = stats;
  const coverageText = `${formatPercent(coverage.labelled, 0)} labelled, ${formatPercent(coverage.priced, 0)} priced, ${formatPercent(coverage.context, 0)} with measured input.`;

  if (!anatomy.split) {
    return <Card>
      <CardHeader title="Session anatomy" subtitle="One chain" />
      <p className="text-[12px] text-muted">{anatomy.note}</p>
    </Card>;
  }
  return <section className="space-y-3" aria-label="Session anatomy">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Chains" value={formatInteger(stats.chains)} hint={stats.maxDepth === null ? "no subagents" : `max depth ${formatInteger(stats.maxDepth)}`} info={coverageText} />
      <Stat label="Subagent requests" value={formatPercent(stats.subagentShare?.requests ?? null, 0)} hint={`${formatPercent(stats.subagentShare?.tokens ?? null, 0)} of tokens`} />
      <Stat label="Subagent cost" value={formatPercent(stats.subagentShare?.cost ?? null, 0)} hint="of priced cost" info="API list-price equivalents, priced requests only. A share describes structure, not whether a subagent was worth it." />
      <Stat label="First-request writes" value={formatUsd(stats.startupCostUsd)} hint={stats.startupsUnavailable ? `${formatInteger(stats.startupsUnavailable)} unavailable` : undefined} info="The cache-write cost of each subagent's first request, as on the Subagents page. Unavailable when the first request is outside this selection or unpriced." />
    </div>
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Cost tree <InfoTip>Each chain sized by {size}, nested under the chain that spawned it where a recorded tool call links them. Costs are list-price equivalents; a partly priced chain is a lower bound. {coverageText}</InfoTip></span>}
        action={<Segmented size="sm" value={size} options={[{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={setSize} />}
      />
      <Chart option={tree} height={240} />
      <Expandable items={chains} limit={6}>
        {rows => <TableShell className="mt-3">
          <thead><tr><Th>Chain</Th><Th>Model</Th><Th align="right">Depth</Th><Th align="right">Requests</Th><Th align="right">Tokens</Th><Th align="right">Priced cost</Th><Th>Spawn</Th></tr></thead>
          <tbody>{rows.map(item => <tr key={item.key}>
            <Td className="font-medium text-ink"><button type="button" onClick={() => setSelected(item.key)} className="text-info hover:underline">{chainName(item)}</button></Td>
            <Td className="max-w-[180px] truncate">{item.model ?? "—"}</Td>
            <Td align="right">{item.depth ?? "—"}</Td>
            <Td align="right">{formatInteger(item.requests)}</Td>
            <Td align="right">{formatCompact(item.tokens)}</Td>
            <Td align="right">{cost(item)}</Td>
            <Td>{item.kind !== "subagent" ? "—" : item.spawn ? chains.find(other => other.key === item.parent) ? chainName(chains.find(other => other.key === item.parent)!) : "Outside this selection" : <Badge>spawn point not recorded</Badge>}</Td>
          </tr>)}</tbody>
        </TableShell>}
      </Expandable>
    </Card>
    <Card>
      <CardHeader title="Timeline" subtitle={unlinked ? `One lane per chain · ${formatInteger(unlinked)} with spawn point not recorded` : "One lane per chain, with a line from the request that started each subagent"} />
      <Chart option={lanes} height={Math.min(760, 60 + chains.length * 26)} onEvents={{ click: params => { const lane = (params as { value?: number[] }).value?.[0]; if (typeof lane === "number" && chains[lane]) setSelected(chains[lane]!.key); } }} />
    </Card>
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Context of this chain <InfoTip>Input per measured request for one chain at a time, so unrelated contexts are not mixed. Dashed lines are recorded compactions. A session without a mark has no recorded compaction, which is not the same as no compaction.</InfoTip></span>}
        subtitle={chain ? `${chainName(chain)} · ${formatInteger(chain.contextEligible)} measured requests` : undefined}
        action={chains.length > 1 ? <select aria-label="Chain" value={chain?.key ?? ""} onChange={event => setSelected(event.target.value)} className="max-w-[220px] rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-ink-soft">
          {chains.map(item => <option key={item.key} value={item.key}>{chainName(item)}</option>)}
        </select> : undefined}
      />
      {context ? <Chart option={context} height={220} /> : <p className="py-6 text-center text-[12px] text-muted">No measured context sizes in this chain</p>}
    </Card>
  </section>;
}
