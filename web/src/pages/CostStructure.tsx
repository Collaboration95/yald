import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { sourceLabel } from "../api";
import { usePreferences } from "../lib/preferences";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Segmented, StateBlock } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, lineChart, paretoChart, pairedBarChart, stackedAreaChart } from "../components/chartOptions";
import { COMPOSITION_COLORS, colorAt } from "../lib/palette";
import { formatCompact, formatInteger, formatPercent, formatUsd } from "../lib/format";
import type { PriceTierId, SpendStructureResponse } from "../types";

/** True once the element has come within `margin` of the viewport (and stays true); false without IntersectionObserver. */
export function useInView<T extends Element>(margin = "800px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin, seen]);
  return [ref, seen];
}

interface Section {
  data: SpendStructureResponse | undefined;
  loading: boolean;
  error: unknown;
}

const TIER_COLORS: Record<PriceTierId, string> = { economy: colorAt(0), standard: colorAt(1), premium: colorAt(3) };
const CLASS_NAMES = { freshInput: "Fresh input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output" } as const;
const CLASS_KEYS = ["freshInput", "cacheRead", "cacheWrite", "output"] as const;
const COLORS: Record<string, string> = { ...COMPOSITION_COLORS, "Tier adjustment": "#94a3b8" };

function Coverage({ data }: { data: SpendStructureResponse | undefined }) {
  if (!data) return null;
  const { pricing } = data;
  return (
    <p className="mt-2 text-[10.5px] leading-4 text-muted">
      {formatInteger(pricing.pricedRequests)} of {formatInteger(pricing.totalRequests)} requests priced
      {pricing.unpricedRequests > 0 ? ` · ${formatInteger(pricing.unpricedRequests)} unpriced requests (${formatCompact(pricing.unpricedTokens)} tokens) carry no dollars and are left out of every figure here` : ""}.
      Dollars are API list-price equivalents, not a bill.
    </p>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.04em] text-muted">{label}</p>
      <p className="num text-[20px] font-semibold leading-tight text-ink">{value}</p>
      <p className="truncate text-[10.5px] text-muted" title={hint}>{hint}</p>
    </div>
  );
}

/** Concentration of spend across sessions: Pareto curve and the top-share figures. */
export function ConcentrationCard({ data, loading, error }: Section) {
  const { chartTheme } = useTheme();
  const c = data?.concentration;
  const option = useMemo(() => {
    if (!c || c.curve.length < 2) return null;
    const marks = [["top 1%", c.top1pct], ["top 5%", c.top5pct]].flatMap(([label, entry]) => {
      const share = entry as typeof c.top1pct;
      return share ? [{ label: `${label as string} · ${formatPercent(share.share, 0)}`, x: share.sessions / c.sessions, y: share.share }] : [];
    });
    return paretoChart(chartTheme, c.curve, marks);
  }, [c, chartTheme]);
  const tooFew = (minimum: number) => `needs ${minimum}+ priced sessions`;
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Spend concentration" subtitle="How much of the priced cost the biggest sessions hold, sessions ranked by cost" />
      <StateBlock loading={loading} error={error} empty={!c || c.sessions === 0} emptyLabel="No priced sessions in this window">
        {c ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Figure label="Top 1% of sessions" value={c.top1pct ? formatPercent(c.top1pct.share) : "too few"} hint={c.top1pct ? `${c.top1pct.sessions} sessions · ${formatUsd(c.top1pct.cost)}` : tooFew(c.minimums.top1pct)} />
              <Figure label="Top 5% of sessions" value={c.top5pct ? formatPercent(c.top5pct.share) : "too few"} hint={c.top5pct ? `${c.top5pct.sessions} sessions · ${formatUsd(c.top5pct.cost)}` : tooFew(c.minimums.top5pct)} />
              <Figure label="Top 10 sessions" value={c.top10Sessions ? formatPercent(c.top10Sessions.share) : "too few"} hint={c.top10Sessions ? formatUsd(c.top10Sessions.cost) : tooFew(c.minimums.top10Sessions)} />
              <Figure label="Gini" value={c.gini === null ? "too few" : c.gini.toFixed(2)} hint={c.gini === null ? tooFew(c.minimums.gini) : "0 even, 1 all in one session"} />
            </div>
            {option ? <Chart option={option} height={236} className="mt-3" /> : null}
            <p className="mt-1 text-[10.5px] leading-4 text-muted">
              Curve: the top x of sessions (log scale) hold y of cost; the dashed line is an even spread. {formatInteger(c.sessions)} sessions with a priced request.
              {c.partlyPricedSessions > 0 ? ` ${formatInteger(c.partlyPricedSessions)} are partly priced, so their cost is a lower bound.` : ""}
              {c.unpricedSessions > 0 ? ` ${formatInteger(c.unpricedSessions)} sessions have no priced request and are outside the curve.` : ""}
              {c.noSessionId.requests > 0 ? ` ${formatInteger(c.noSessionId.requests)} requests have no session id and are outside it too.` : ""}
              {c.clippedSessions > 0 ? ` ${formatInteger(c.clippedSessions)} sessions continue outside the window; only their in-window part counts.` : ""}
              {" "}This describes this window and this definition of a session, a source plus conversation id; a resumed or very long session counts as one.
            </p>
            <Coverage data={data} />
          </>
        ) : null}
      </StateBlock>
    </Card>
  );
}

/** Which models fall in each fixed price tier, and the published thresholds. */
export function TiersCard({ data, loading, error }: Section) {
  return (
    <Card>
      <CardHeader title="Price tiers" subtitle="A label on list input price per 1M tokens, nothing about quality" />
      <StateBlock loading={loading} error={error} empty={!data || data.pricing.pricedRequests === 0}>
        <ul className="space-y-3">
          {data?.tiers.definitions.map(tier => (
            <li key={tier.id}>
              <p className="flex items-center gap-2 text-[11.5px] font-medium text-ink">
                <span className="h-2 w-2 rounded-sm" style={{ background: TIER_COLORS[tier.id] }} />
                {tier.label}
                <span className="font-normal text-muted">{tier.maxRateIn === null ? `$${tier.minRateIn} and up` : `$${tier.minRateIn} to under $${tier.maxRateIn}`}</span>
              </p>
              <p className="mt-0.5 text-[10.5px] leading-4 text-muted">
                {data.tiers.models[tier.id].length ? data.tiers.models[tier.id].map(entry => entry.model).join(" · ") : "No priced requests in this window"}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[10.5px] leading-4 text-muted">Thresholds are fixed constants on the list input rate, not fitted to your data.</p>
      </StateBlock>
    </Card>
  );
}

/** Blended price per million tokens, with one line per tier, the tier mix and the token volume on one axis. */
export function PriceDriftCard({ data, loading, error }: Section) {
  const { chartTheme } = useTheme();
  const options = useMemo(() => {
    if (!data) return null;
    const buckets = data.series.buckets;
    const labels = buckets.map(bucket => bucket.label);
    const price = lineChart(chartTheme, labels, [
      { name: "Blended", data: buckets.map(bucket => bucket.blendedPer1M), color: colorAt(1) },
      ...data.tiers.definitions.map(tier => ({ name: `${tier.label} tier`, data: buckets.map(bucket => bucket.tiers[tier.id].blendedPer1M), color: TIER_COLORS[tier.id], dashed: true })),
    ], { formatter: value => `$${value.toFixed(2)}`, preserveGaps: true });
    const mix = stackedAreaChart(chartTheme, labels, data.tiers.definitions.map(tier => ({ name: `${tier.label} tier`, data: buckets.map(bucket => bucket.tiers[tier.id].requestShare) })),
      { formatter: value => formatPercent(value, 0), colors: Object.fromEntries(data.tiers.definitions.map(tier => [`${tier.label} tier`, TIER_COLORS[tier.id]])), max: 1 });
    const volume = barChart(chartTheme, labels, buckets.map(bucket => (bucket.pricedRequests ? bucket.pricedTokens : null)), { formatter: value => formatCompact(value), color: colorAt(9) });
    return { price, mix, volume };
  }, [data, chartTheme]);
  return (
    <Card>
      <CardHeader title="Blended price and price tiers" subtitle="Priced cost over priced tokens per 1M · if the tier lines are flat while the blended line moves, the mix moved" />
      <StateBlock loading={loading} error={error} empty={!data || data.pricing.pricedRequests === 0} emptyLabel="Nothing priced in this window">
        {options ? (
          <div className="space-y-1">
            <p className="text-[11.5px] font-medium text-ink-soft">Blended cost per 1M tokens, overall and per tier</p>
            <Chart option={options.price} height={216} />
            <p className="pt-2 text-[11.5px] font-medium text-ink-soft">Share of priced requests by tier</p>
            <Chart option={options.mix} height={170} />
            <p className="pt-2 text-[11.5px] font-medium text-ink-soft">Priced tokens</p>
            <Chart option={options.volume} height={130} />
          </div>
        ) : null}
        <p className="mt-2 text-[10.5px] leading-4 text-muted">
          This is arithmetic on tokens and today's price table: rows are priced at load with the current engine and overlays, so the series shows mix and the current table, not what was paid at the time. An empty bucket has no price, not a $0 one.
          {data && data.tiers.unclassifiedRequests > 0 ? ` ${formatInteger(data.tiers.unclassifiedRequests)} priced requests have no input rate and are outside the tiers.` : ""}
        </p>
        <Coverage data={data} />
      </StateBlock>
    </Card>
  );
}

/** Token-class cost mix per source over time, and each class's token share next to its cost share. */
export function ClassMixSection({ data, loading, error }: Section) {
  const { chartTheme } = useTheme();
  const { labsEnabled } = usePreferences();
  const { search } = useLocation();
  const [mode, setMode] = useState<"share" | "cost">("share");
  const sources = data?.classMix ?? [];
  const charts = useMemo(() => sources.map(source => {
    const withAdjustment = source.cost.adjustment > 0;
    const labels = source.buckets.map(bucket => bucket.label);
    const names = [...CLASS_KEYS.map(key => CLASS_NAMES[key]), ...(withAdjustment ? ["Tier adjustment"] : [])];
    const keys = [...CLASS_KEYS, ...(withAdjustment ? ["adjustment" as const] : [])];
    const series = keys.map((key, index) => ({
      name: names[index]!,
      data: source.buckets.map(bucket => (mode === "share" ? bucket.share[key] : bucket.total > 0 || key === "adjustment" ? bucket.cost[key] : null)),
    }));
    const area = stackedAreaChart(chartTheme, labels, series, {
      formatter: mode === "share" ? value => formatPercent(value, 0) : value => formatUsd(value), colors: COLORS, ...(mode === "share" ? { max: 1 } : {}),
    });
    const paired = pairedBarChart(chartTheme, CLASS_KEYS.map(key => CLASS_NAMES[key]), [
      { name: "Share of tokens", data: CLASS_KEYS.map(key => source.tokenShare[key]), color: colorAt(9) },
      { name: "Share of cost", data: CLASS_KEYS.map(key => source.costShare[key]), color: colorAt(1) },
    ], { formatter: value => formatPercent(value, 1) });
    return { source, area, paired };
  }), [sources, chartTheme, mode]);
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">Token-class cost mix</h2>
          <p className="mt-0.5 text-[11.5px] text-muted">What each token class costs per source, and how that moves. Reasoning is inside output and never added twice.</p>
        </div>
        <Segmented size="sm" value={mode} options={[{ id: "share", label: "Share" }, { id: "cost", label: "Cost" }]} onChange={setMode} />
      </div>
      <StateBlock loading={loading} error={error} empty={!data || sources.length === 0} emptyLabel="Nothing priced in this window">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {charts.map(({ source, area, paired }) => (
            <Card key={source.source}>
              <CardHeader
                title={sourceLabel(source.source)}
                subtitle={`${formatInteger(source.pricedRequests)} priced requests · ${formatUsd(source.totalCost)} list price`}
                action={source.cost.reasoning > 0 ? <Badge>of which reasoning {formatUsd(source.cost.reasoning)}</Badge> : undefined}
              />
              <Chart option={area} height={200} />
              <p className="mb-1 mt-3 text-[11.5px] font-medium text-ink-soft">Share of tokens beside share of cost</p>
              <Chart option={paired} height={172} />
              {source.source === "claude-code" ? (
                <p className="mt-1 text-[10.5px] leading-4 text-muted">
                  Cache writes are what later reads are priced against, so a large write share is not a judgement. The 1h cache-write premium is understated until the 5m/1h split is read.
                  {labsEnabled ? <> The net comparison is in <Link to={{ pathname: "/labs/cache-detective", search }} className="text-accent">Cache Detective</Link>.</> : " The net comparison is in Cache Detective (Labs)."}
                </p>
              ) : null}
              {source.cost.adjustment > 0 ? <p className="mt-1 text-[10.5px] leading-4 text-muted">Tier adjustment is cost the engine added for long-context or priority pricing that the class split could not place.</p> : null}
              {source.cost.reasoning > 0 ? <p className="mt-1 text-[10.5px] leading-4 text-muted">Reasoning cost is the output cost in proportion to reasoning tokens: an attribution, not a measurement.</p> : null}
            </Card>
          ))}
        </div>
        <Coverage data={data} />
      </StateBlock>
    </div>
  );
}
