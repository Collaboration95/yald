// Renders a ReportData payload as one self-contained HTML document: inline
// CSS, inline SVG, the payload embedded as JSON, and no network references.
import { readFileSync } from "node:fs";
import type { ReportData, Source } from "./types";
import { CLASS_COLORS, esc, inlineBar, modelColor, stackedBarChart, type Segment } from "./svg";

// The server ships as TypeScript source (package.json "files": server/src), so
// the stylesheet is read once at module load from next to this file and
// inlined into every report. Nothing is fetched when the report is opened.
const CSS = readFileSync(new URL("./report.css", import.meta.url), "utf8");

export const REPO_URL = "https://github.com/Collaboration95/yald";
export const QUOTA_DOCS_URL = `${REPO_URL}/blob/main/docs/metrics.md#claude-code-quota`;

const LOCALE = "en-US";
const ALL_SOURCES: Source[] = ["claude-code", "ocx"];
const SOURCE_NAMES: Record<string, string> = { "claude-code": "Claude Code", ocx: "opencodex" };
const sourceName = (source: string) => SOURCE_NAMES[source] ?? source;
const sourceClass = (source: string) => (source === "claude-code" || source === "ocx" ? source : "");

type Row = ReportData["phases"][number];
type Classes = ReportData["composition"];

// ---------- number formatting (copied from web/src/lib/format.ts) ----------

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

function compact(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(digits)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(digits)}k`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function integer(value: number | null | undefined): string {
  return finite(value) ? Math.round(value).toLocaleString(LOCALE) : "—";
}

function usd(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs >= 10_000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(value: number | null | undefined, digits = 1): string {
  return finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

const share = (part: number, whole: number) => (whole > 0 && finite(part) ? part / whole : 0);

// ---------- time formatting in the report's zone ----------

interface Clock {
  tz: string;
  offset: (ts: number) => string;
  time: (ts: number) => string;
  day: (ts: number) => string;
  dayKey: (ts: number) => string;
  full: (ts: number) => string;
}

function makeClock(requested: string): Clock {
  let tz = requested;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const parts = (options: Intl.DateTimeFormatOptions) => {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options });
    return (ts: number) => Object.fromEntries(format.formatToParts(ts).map(p => [p.type, p.value])) as Record<string, string>;
  };
  const hm = parts({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dmy = parts({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const off = parts({ timeZoneName: "shortOffset" });
  const safe = (fn: (ts: number) => string) => (ts: number) => (finite(ts) ? fn(ts) : "—");
  const offset = safe(ts => off(ts).timeZoneName ?? "");
  const time = safe(ts => { const p = hm(ts); return `${p.hour}:${p.minute}`; });
  const day = safe(ts => { const p = dmy(ts); return `${p.weekday} ${p.day} ${p.month}`; });
  const dayKey = safe(ts => { const p = dmy(ts); return `${p.year}-${p.month}-${p.day}`; });
  const full = safe(ts => { const p = dmy(ts); return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${time(ts)} ${offset(ts)}`; });
  return { tz, offset, time, day, dayKey, full };
}

/** Short form for table rows: "Sun 09:00–15:00" or "Sat 23:30 – Sun 09:00". */
function shortRange(clock: Clock, from: number, to: number): string {
  if (!finite(from) || !finite(to)) return "—";
  if (to - from > 6 * 86_400_000) return range(clock, from, to);
  const weekday = (ts: number) => clock.day(ts).split(" ")[0];
  if (clock.dayKey(from) === clock.dayKey(to)) return `${weekday(from)} ${clock.time(from)}–${clock.time(to)}`;
  return `${weekday(from)} ${clock.time(from)} – ${weekday(to)} ${clock.time(to)}`;
}

function range(clock: Clock, from: number, to: number): string {
  if (!finite(from) || !finite(to)) return "—";
  if (clock.dayKey(from) === clock.dayKey(to)) return `${clock.day(from)}, ${clock.time(from)}–${clock.time(to)}`;
  return `${clock.day(from)} ${clock.time(from)} – ${clock.day(to)} ${clock.time(to)}`;
}

// ---------- small markup helpers ----------

const td = (content: string, className = "") => `<td${className ? ` class="${className}"` : ""}>${content}</td>`;
const num = (content: string) => td(esc(content), "num");
const th = (label: string, numeric = false) => `<th${numeric ? ' class="num"' : ""} scope="col">${esc(label)}</th>`;

function table(caption: string, head: string[], numericFrom: number, rows: string[], visibleCaption = false, className = ""): string {
  const header = head.map((label, i) => th(label, i >= numericFrom)).join("");
  return `<div class="table-shell"><table${className ? ` class="${className}"` : ""}><caption class="${visibleCaption ? "" : "sr-only"}">${esc(caption)}</caption><thead><tr>${header}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function srTable(caption: string, head: string[], rows: string[][]): string {
  const body = rows.map(cells => `<tr>${cells.map((cell, i) => (i === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`)).join("")}</tr>`).join("");
  return `<table class="sr-only"><caption>${esc(caption)}</caption><thead><tr>${head.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

function card(title: string, sub: string, body: string, variant = ""): string {
  return `<section class="card${variant ? ` ${variant}` : ""}"><div class="card-header"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ""}</div>${body}</section>`;
}

function sourceLabel(source: string): string {
  const cls = sourceClass(source);
  return `<span class="nowrap">${cls ? `<span class="dot ${cls}" aria-hidden="true"></span>` : ""}${esc(sourceName(source))}</span>`;
}

function shownSources(data: ReportData): Source[] {
  const picked = ALL_SOURCES.filter(s => data.meta.filters.sources.includes(s));
  return picked.length > 0 ? picked : ALL_SOURCES;
}

function sourceLegend(sources: Source[], extra = ""): string {
  const items = sources.map(s => `<li><span class="swatch" style="background:var(--src-${s})" aria-hidden="true"></span>${esc(sourceName(s))}</li>`).join("");
  return `<ul class="legend">${items}${extra}</ul>`;
}

// ---------- sections ----------

function header(data: ReportData, clock: Clock): string {
  const { meta } = data;
  const sources = meta.filters.sources.length > 0 ? meta.filters.sources.map(sourceName).join(", ") : "all sources";
  const projects = meta.filters.projects.length > 0 ? meta.filters.projects.join(", ") : "all projects";
  const version = `yald v${meta.yaldVersion}`;
  return `<header class="report-header">
<span class="eyebrow">yald report<span class="stop">.</span></span>
<h1>${esc(meta.title)}</h1>
<p class="window">${esc(meta.window.label)}</p>
<ul class="meta">
<li><b>Time zone</b> ${esc(clock.tz)} (${esc(clock.offset(meta.window.from))})</li>
<li><b>Generated</b> ${esc(clock.full(meta.generatedAt))}</li>
<li><b>Version</b> ${esc(version)}</li>
<li><b>Sources</b> ${esc(sources)}</li>
<li><b>Projects</b> ${esc(projects)}</li>
</ul>
<p class="credit"><a href="${REPO_URL}">Numbers from ${esc(version)}</a></p>
</header>`;
}

function kpis(data: ReportData): string {
  const k = data.kpis;
  const priced = data.coverage.pricing !== "unavailable";
  const items: Array<[string, string, string, boolean?]> = [
    ["Requests", integer(k.requests), ""],
    ["Total tokens", compact(k.tokens), integer(k.tokens)],
    ["Output tokens", compact(k.output), k.reasoning > 0 ? `${compact(k.reasoning)} reasoning included` : ""],
    ["Cost", priced ? usd(k.costUsd) : "—", "API list-price equivalent"],
    ["Cache hit rate", percent(k.cacheHitRate), "observed cache reads ÷ observed input"],
    ["Cache savings", priced ? usd(k.cacheSavingsUsd) : "—", "vs. fresh-input price"],
    ["Conversations", integer(k.conversations), ""],
    ["Active hours", integer(k.activeHours), "hours with a request"],
    ["Success rate", percent(k.successRate), "opencodex only", true],
  ];
  const cells = items.map(([label, value, hint, tag]) => `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div>${hint ? `<div class="kpi-hint${tag ? " tag" : ""}">${esc(hint)}</div>` : ""}</div>`).join("");
  return `<section class="kpis" aria-label="Key figures">${cells}</section>`;
}

function splitBar(row: Row, sources: Source[]): string {
  const total = sources.reduce((a, s) => a + (row.tokensBySource?.[s] ?? 0), 0);
  const label = sources.map(s => `${sourceName(s)} ${percent(share(row.tokensBySource?.[s] ?? 0, total), 0)}`).join(" · ");
  const bar = inlineBar(sources.map(s => ({ value: row.tokensBySource?.[s] ?? 0, className: `s-${s}` })), { label });
  const text = sources.length > 1 ? sources.map(s => (share(row.tokensBySource?.[s] ?? 0, total) * 100).toFixed(0)).join("/") : "";
  return `<div class="share split">${bar}${text ? `<span class="muted">${esc(text)}</span>` : ""}</div>`;
}

function phasesSection(data: ReportData, clock: Clock, sources: Source[]): string {
  const named = data.phases.slice(0, -2);
  if (named.length === 0) return "";
  const rows = data.phases.map((p, i) => {
    // The contract identifies summary rows by position, not by user-editable names.
    const kind = i === data.phases.length - 1 ? "total" : i === data.phases.length - 2 ? "outside" : "";
    const when = kind === "outside" ? "rest of window" : shortRange(clock, p.from, p.to);
    return `<tr${kind ? ` class="${kind}"` : ""}>${td(esc(p.name), "ink wrap")}${td(esc(when), "nowrap")}${num(integer(p.requests))}${num(compact(p.freshInput))}${num(compact(p.cacheWrite))}${num(compact(p.cacheRead))}${num(compact(p.output))}${num(compact(p.reasoning))}${num(compact(p.tokens))}${num(usd(p.costUsd))}${num(integer(p.conversations))}${td(esc(p.topModel ?? "—"), "nowrap")}${td(splitBar(p, sources))}</tr>`;
  });
  const head = ["Phase", `Local time (${clock.offset(data.meta.window.from)})`, "Requests", "Fresh input", "Cache write", "Cache read", "Output", "Reasoning", "Tokens", "Cost", "Conversations", "Top model", `Token split, % (${sources.map(sourceName).join(" / ")})`];
  const body = sourceLegend(sources) + table("Usage by phase", head, 2, rows, false, "dense");
  return card("Phases", `One row per phase, then the time outside every phase and the whole window. Cost is the API list-price equivalent.`, body, "open");
}

function timelineSection(data: ReportData, clock: Clock, sources: Source[]): string {
  const points = data.timeline.points;
  if (points.length === 0) return "";
  const { from: wFrom, to: wTo } = data.meta.window;
  const bars = points.map((p, i) => {
    const next = points[i + 1]?.ts ?? wTo;
    return {
      from: p.ts,
      to: next,
      label: p.label,
      segments: sources.map((s): Segment => ({ value: p.bySource?.[s]?.tokens ?? 0, className: `s-${s}` })),
    };
  });
  const domain: [number, number] = [wFrom, wTo];
  const requests = points.map(p => sources.reduce((a, s) => a + (p.bySource?.[s]?.requests ?? 0), 0));
  const tokens = points.map(p => sources.reduce((a, s) => a + (p.bySource?.[s]?.tokens ?? 0), 0));
  const peak = tokens.indexOf(Math.max(...tokens));
  const bands = data.phases.slice(0, -2).map(p => ({ from: p.from, to: p.to, name: p.name }));
  const unit = data.timeline.bucket === "day" ? "day" : "hour";
  const desc = [
    `Tokens per ${unit}, stacked by source (${sources.map(sourceName).join(", ")}), from ${clock.full(domain[0])} to ${clock.full(domain[1])}.`,
    peak >= 0 && tokens[peak]! > 0 ? `Busiest ${unit}: ${points[peak]!.label} with ${compact(tokens[peak])} tokens and ${integer(requests[peak])} requests.` : "",
    bands.length > 0 ? `Shaded phases: ${bands.map(b => b.name).join(", ")}.` : "",
    "The line shows requests on the right axis.",
  ].filter(Boolean).join(" ");
  const chart = stackedBarChart({
    id: "timeline",
    title: `Tokens and requests per ${unit}`,
    desc,
    domain,
    bars,
    bands,
    line: requests,
    formatValue: v => compact(v, 0),
    formatLine: v => compact(v, 0),
  });
  const legend = sourceLegend(sources, `<li><span class="line-swatch" aria-hidden="true"></span>Requests (right axis)</li>${bands.length ? '<li><span class="swatch" style="background:var(--band);outline:1px dashed var(--line-strong)" aria-hidden="true"></span>Phase</li>' : ""}`);
  const hidden = srTable(
    `Tokens and requests per ${unit}`,
    [unit === "day" ? "Day" : "Hour", ...sources.map(s => `${sourceName(s)} tokens`), ...sources.map(s => `${sourceName(s)} requests`)],
    points.map(p => [p.label, ...sources.map(s => integer(p.bySource?.[s]?.tokens ?? 0)), ...sources.map(s => integer(p.bySource?.[s]?.requests ?? 0))]),
  );
  return card("Timeline", `Tokens per ${unit} by source, with phases shaded behind. Times in ${esc(clock.tz)}.`, `${legend}<div class="chart-scroll">${chart}</div>${hidden}`);
}

const CLASS_ORDER: Array<[keyof Classes, string]> = [
  ["freshInput", "Fresh input"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
  ["output", "Output"],
  ["reasoning", "Reasoning"],
];

function compositionSection(data: ReportData): string {
  const c = data.composition;
  const total = CLASS_ORDER.reduce((a, [key]) => a + (finite(c[key]) ? c[key] : 0), 0);
  const label = `Token composition: ${CLASS_ORDER.map(([key, name]) => `${name} ${percent(share(c[key], total))}`).join(", ")}`;
  const bar = inlineBar(CLASS_ORDER.map(([key]) => ({ value: c[key], color: CLASS_COLORS[key] })), { label, big: true });
  const list = CLASS_ORDER.map(([key, name]) => `<li><span class="swatch" style="background:${CLASS_COLORS[key]}" aria-hidden="true"></span>${esc(name)}<b>${esc(compact(c[key]))}</b><span class="muted">${esc(percent(share(c[key], total)))}</span></li>`).join("");
  const hidden = srTable("Token composition", ["Class", "Tokens", "Share"], CLASS_ORDER.map(([key, name]) => [name, integer(c[key]), percent(share(c[key], total))]));
  return card("Token composition", `${esc(compact(total))} tokens by class.`, `${bar}<ul class="composition-list">${list}</ul>${hidden}`);
}

function cacheSection(data: ReportData): string {
  const { cache } = data;
  const priced = data.coverage.pricing !== "unavailable";
  const classes: Array<[keyof ReportData["cache"]["costByClass"], string]> = [["freshInput", "Fresh input"], ["cacheWrite", "Cache write"], ["cacheRead", "Cache read"], ["output", "Output (incl. reasoning)"]];
  const total = classes.reduce((a, [key]) => a + (finite(cache.costByClass[key]) ? cache.costByClass[key] : 0), 0);
  const facts = `<dl class="facts"><div><dt>Cache hit rate</dt><dd>${esc(percent(cache.hitRate))}</dd></div><div><dt>Cache savings</dt><dd>${esc(priced ? usd(cache.savingsUsd) : "—")}</dd></div></dl>`;
  const rows = classes.map(([key, name]) => {
    const value = cache.costByClass[key];
    const bar = inlineBar([{ value, color: CLASS_COLORS[key] }], { label: `${name}: ${percent(share(value, total))} of dollars`, total });
    return `<tr>${td(esc(name), "ink")}${num(priced ? usd(value) : "—")}${td(`<div class="share">${bar}<span class="muted">${esc(percent(share(value, total)))}</span></div>`)}</tr>`;
  });
  // Per-token rates miss per-request fees and tier adjustments; show the gap so the
  // table adds up to the cost KPI.
  const other = finite(data.kpis.costUsd) ? Math.round((data.kpis.costUsd - total) * 100) / 100 : 0;
  if (priced && Math.abs(other) >= 0.01) rows.push(`<tr>${td("Other (request fees, tiers)", "ink")}${num(usd(other))}${td("")}</tr>`);
  rows.push(`<tr class="total">${td("Total")}${num(priced ? usd(Math.abs(other) >= 0.01 ? data.kpis.costUsd! : total) : "—")}${td("")}</tr>`);
  const sub = "Dollars by token class (API list-price equivalent). Savings compare cache reads with paying the fresh-input price for the same tokens.";
  return card("Cache economics", sub, facts + table("Dollars by token class", ["Token class", "Cost", "Share of dollars"], 1, rows), "peach");
}

function modelsSection(data: ReportData): string {
  if (data.models.length === 0) return "";
  const rows = data.models.map((m, i) => {
    const color = modelColor(i);
    const name = `<span class="dot" style="background:${color}" aria-hidden="true"></span>${esc(m.model)}`;
    const bar = inlineBar([{ value: m.share, color }], { label: `${m.model}: ${percent(m.share)} of tokens`, total: 1 });
    return `<tr>${td(name, "ink wrap")}${td(esc(m.provider), "wrap")}${td(sourceLabel(m.source))}${num(integer(m.requests))}${num(compact(m.tokens))}${td(`<div class="share">${bar}<span>${esc(percent(m.share))}</span></div>`)}${num(compact(m.output))}${num(usd(m.costUsd))}${num(finite(m.usdPerMTok) ? `$${m.usdPerMTok.toFixed(2)}` : "—")}${num(percent(m.cacheHitRate))}${num(finite(m.ttftP50Ms) ? `${integer(m.ttftP50Ms)} ms` : "—")}</tr>`;
  });
  const head = ["Model", "Provider", "Source", "Requests", "Tokens", "Share of tokens", "Output", "Cost", "$ / M tokens", "Cache hit", "TTFT p50"];
  return card("Models", "Share is of all tokens in the window. Cost is the API list-price equivalent; a dash means the model has no list price.", table("Models", head, 3, rows), "open");
}

function conversationsSection(data: ReportData, clock: Clock): string {
  if (data.conversations.length === 0) return "";
  const rows = data.conversations.map(c => `<tr>${td(esc(c.id), "mono ink")}${td(sourceLabel(c.source))}${td(esc(c.models.join(", ") || "—"), "wrap")}${td(esc(c.project ?? "—"), "wrap")}${num(integer(c.requests))}${num(compact(c.tokens))}${num(usd(c.costUsd))}${td(esc(range(clock, c.from, c.to)), "nowrap")}</tr>`);
  const head = ["Conversation", "Source", "Models", "Project", "Requests", "Tokens", "Cost", "Active"];
  return card("Top conversations", "Largest conversations by tokens. Cost is the API list-price equivalent.", table("Top conversations", head, 4, rows), "open");
}

function pct(value: number | null): string {
  return finite(value) ? `${value.toFixed(0)}%` : "—";
}

function quotaSection(data: ReportData): string {
  const windows = data.quota.windows;
  let body: string;
  if (windows.length === 0) {
    body = `<p class="note">No opencodex quota samples in this window.</p>`;
  } else {
    const rows = windows.map(w => {
      const cells = w.status === "measured"
        ? `${num(pct(w.usedPctStart))}${num(pct(w.usedPctEnd))}${num(finite(w.burnPctPerDay) ? `${w.burnPctPerDay.toFixed(1)}%` : "—")}`
        : `<td colspan="3" class="muted">${esc(`not enough samples in this window (${w.samples})`)}</td>`;
      return `<tr>${td(esc(w.account), "ink wrap")}${td(esc(w.window))}${num(integer(w.samples))}${cells}</tr>`;
    });
    body = table("opencodex quota burn", ["Account", "Window", "Samples", "Used at start", "Used at end", "Burn per day"], 2, rows);
  }
  body += `<p class="note"><b>Claude Code quota: unavailable.</b> Claude Code does not write its 5-hour and weekly limits anywhere yald can read. <a href="${QUOTA_DOCS_URL}">Why Claude Code quota is unavailable</a></p>`;
  return card("Quota", "Measured burn per opencodex quota window during the report window.", body, "lavender");
}

function coverageSection(data: ReportData, clock: Clock): string {
  const c = data.coverage;
  const sentences: string[] = [];
  sentences.push(c.sourcesRead.length > 0 ? `Sources read: ${c.sourcesRead.join("; ")}.` : "No sources were read.");
  sentences.push(`All times are shown in ${clock.tz}; the window is half-open, so a request at exactly the end belongs to the next window.`);
  if (c.pricing === "unavailable") sentences.push("Pricing was unavailable, so no dollar amounts are shown.");
  else sentences.push("Every dollar figure is the API list-price equivalent, not an amount billed.");
  if (c.unpriced.length > 0) {
    const count = c.unpriced.reduce((a, u) => a + u.requests, 0);
    const list = c.unpriced.map(u => `${u.model} (${integer(u.requests)})`).join(", ");
    sentences.push(`${integer(count)} ${count === 1 ? "request" : "requests"} used models without a list price and ${count === 1 ? "is" : "are"} left out of dollar totals: ${list}.`);
  }
  if (finite(c.estimatedCostShare) && c.estimatedCostShare > 0) sentences.push(`${percent(c.estimatedCostShare)} of the dollar total is marked as estimated by the opencodex pricing engine.`);
  if (c.rowsWithoutConversation > 0) sentences.push(`${integer(c.rowsWithoutConversation)} ${c.rowsWithoutConversation === 1 ? "request has" : "requests have"} no conversation id and ${c.rowsWithoutConversation === 1 ? "is" : "are"} not in the conversation counts.`);
  if (finite(c.ledgerStartsAt)) sentences.push(`The opencodex spend ledger starts at ${clock.full(c.ledgerStartsAt)}, after the window begins; earlier spend-ledger events are unavailable.`);
  if (c.unattributedRows === null) sentences.push("No project filter was applied.");
  else if (c.unattributedRows > 0) sentences.push(`${integer(c.unattributedRows)} ${c.unattributedRows === 1 ? "request" : "requests"} in the window ${c.unattributedRows === 1 ? "has" : "have"} no project folder and ${c.unattributedRows === 1 ? "is" : "are"} excluded.`);
  sentences.push("Success rate counts opencodex requests only; Claude Code transcripts record only completed requests.");
  return card("Coverage and caveats", "", `<ul class="sentences">${sentences.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`);
}

/** Embeds the payload so other pages can read it; `<` is escaped so the tag cannot be closed early. */
export function embedJson(data: ReportData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function renderReportHtml(data: ReportData): string {
  const clock = makeClock(data.meta.tz);
  const sources = shownSources(data);
  const empty = !(data.kpis.requests > 0);
  const main = empty
    ? `<p class="empty" role="status">No requests in this window</p>`
    : [
      phasesSection(data, clock, sources),
      timelineSection(data, clock, sources),
      `<div class="grid two">${compositionSection(data)}${cacheSection(data)}</div>`,
      modelsSection(data),
      conversationsSection(data, clock),
    ].join("\n");
  const title = `${data.meta.title} · yald report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="${esc(`yald v${data.meta.yaldVersion}`)}">
<title>${esc(title)}</title>
<style>
${CSS}</style>
</head>
<body>
<main class="page">
${header(data, clock)}
${kpis(data)}
${main}
<div class="grid two">${quotaSection(data)}${coverageSection(data, clock)}</div>
<footer class="footer">Report schema v${esc(data.schemaVersion)}. The full payload is embedded in this file as JSON (<code>script#yald-report</code>).</footer>
</main>
<script type="application/json" id="yald-report">${embedJson(data)}</script>
</body>
</html>
`;
}
