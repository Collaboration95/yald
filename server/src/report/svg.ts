// Two hand-written SVG shapes for the report: a stacked bar chart with shaded
// bands and a request line, and an inline bar for table cells. No chart
// library, no DOM; every string that reaches markup goes through esc().

/** Model colours, copied from web/src/lib/palette.ts (PALETTE). */
export const MODEL_COLORS = [
  "#16a34a", "#2563eb", "#7c3aed", "#f59e0b", "#0ea5e9",
  "#e11d48", "#14b8a6", "#a855f7", "#f97316", "#64748b",
] as const;

/** Token-class colours, copied from web/src/lib/palette.ts (COMPOSITION_COLORS); reasoning added. */
export const CLASS_COLORS = {
  freshInput: "#2563eb",
  cacheWrite: "#7c3aed",
  cacheRead: "#16a34a",
  output: "#f59e0b",
  reasoning: "#e11d48",
} as const;

export function modelColor(index: number): string {
  return MODEL_COLORS[((index % MODEL_COLORS.length) + MODEL_COLORS.length) % MODEL_COLORS.length]!;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, ch => ESCAPES[ch]!);
}

const n = (value: number) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : 0);

/** A segment is coloured either by a CSS class (theme-aware) or a literal colour. */
export interface Segment { value: number; className?: string; color?: string }

function fillAttr(segment: Segment): string {
  if (segment.className) return ` class="${esc(segment.className)}"`;
  return ` fill="${esc(segment.color ?? "currentColor")}"`;
}

/**
 * Inline horizontal bar. Segments are laid end to end, scaled so that `total`
 * spans the full width (default: their sum); the remainder shows as track.
 */
export function inlineBar(segments: Segment[], options: { label: string; total?: number; big?: boolean }): string {
  const values = segments.map(s => (Number.isFinite(s.value) && s.value > 0 ? s.value : 0));
  const sum = values.reduce((a, b) => a + b, 0);
  const total = options.total !== undefined && options.total > 0 ? Math.max(options.total, sum) : sum;
  let x = 0;
  const rects = segments.map((segment, i) => {
    const width = total > 0 ? (values[i]! / total) * 100 : 0;
    const rect = width > 0 ? `<rect x="${n(x)}" width="${n(width)}" height="10"${fillAttr(segment)}/>` : "";
    x += width;
    return rect;
  }).join("");
  return `<svg class="inline-bar${options.big ? " big" : ""}" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(options.label)}"><title>${esc(options.label)}</title><rect class="bar-track" width="100" height="10"/>${rects}</svg>`;
}

export interface StackedBar { from: number; to: number; label: string; segments: Segment[] }
export interface Band { from: number; to: number; name: string }

export interface StackedBarChartInput {
  id: string;
  title: string;
  desc: string;
  domain: [number, number];
  bars: StackedBar[];
  bands?: Band[];
  /** Optional line on a secondary (right) axis, one value per bar. */
  line?: number[];
  formatValue: (value: number) => string;
  formatLine?: (value: number) => string;
}

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten so axis ticks read cleanly. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

/**
 * Stacked vertical bars over a time domain, with optional shaded bands
 * (drawn behind, labelled at the top) and a dotted line on the right axis.
 */
export function stackedBarChart(input: StackedBarChartInput): string {
  const width = 960;
  const height = 290;
  const margin = { top: 30, right: input.line ? 52 : 16, bottom: 30, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const [d0, d1] = input.domain;
  const span = d1 > d0 ? d1 - d0 : 1;
  const x = (t: number) => margin.left + ((Math.min(Math.max(t, d0), d1) - d0) / span) * plotW;
  const bottom = margin.top + plotH;

  const stackTotals = input.bars.map(bar => bar.segments.reduce((a, s) => a + (Number.isFinite(s.value) && s.value > 0 ? s.value : 0), 0));
  const yMax = niceCeil(Math.max(0, ...stackTotals));
  const y = (v: number) => bottom - (v / yMax) * plotH;

  const parts: string[] = [];
  const titleId = `${input.id}-title`;
  const descId = `${input.id}-desc`;
  parts.push(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${esc(titleId)} ${esc(descId)}">`);
  parts.push(`<title id="${esc(titleId)}">${esc(input.title)}</title><desc id="${esc(descId)}">${esc(input.desc)}</desc>`);

  // Bands sit behind everything.
  for (const band of input.bands ?? []) {
    const bx0 = x(band.from);
    const bx1 = x(band.to);
    if (bx1 - bx0 <= 0) continue;
    parts.push(`<rect class="band" x="${n(bx0)}" y="${margin.top - 18}" width="${n(bx1 - bx0)}" height="${n(plotH + 18)}"/>`);
    parts.push(`<line class="band-edge" x1="${n(bx0)}" x2="${n(bx0)}" y1="${margin.top - 18}" y2="${bottom}"/>`);
    const room = Math.floor((bx1 - bx0 - 8) / 6.6);
    if (room >= 3) {
      const name = band.name.length > room ? `${band.name.slice(0, room - 1)}…` : band.name;
      parts.push(`<text class="band-label" x="${n(bx0 + 5)}" y="${margin.top - 5}">${esc(name)}</text>`);
    }
  }

  // Horizontal grid with left-axis labels.
  for (let i = 0; i <= 4; i++) {
    const value = (yMax / 4) * i;
    const gy = y(value);
    parts.push(`<line class="${i === 0 ? "axis" : "grid-line"}" x1="${margin.left}" x2="${width - margin.right}" y1="${n(gy)}" y2="${n(gy)}"/>`);
    parts.push(`<text x="${margin.left - 8}" y="${n(gy + 4)}" text-anchor="end">${esc(input.formatValue(value))}</text>`);
  }

  // Bars.
  const labelEvery = Math.max(1, Math.ceil(input.bars.length / 12));
  input.bars.forEach((bar, i) => {
    const bx0 = x(bar.from);
    const bx1 = x(bar.to);
    const slot = bx1 - bx0;
    if (slot <= 0) return;
    const pad = Math.min(slot * 0.16, 6);
    const bw = Math.max(slot - pad * 2, 1);
    let acc = 0;
    for (const segment of bar.segments) {
      const value = Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0;
      if (value <= 0) continue;
      const top = y(acc + value);
      const h = y(acc) - top;
      parts.push(`<rect x="${n(bx0 + pad)}" y="${n(top)}" width="${n(bw)}" height="${n(Math.max(h, 0.5))}"${fillAttr(segment)}/>`);
      acc += value;
    }
    if (i % labelEvery === 0) parts.push(`<text x="${n(bx0 + slot / 2)}" y="${height - 10}" text-anchor="middle">${esc(bar.label)}</text>`);
  });

  // Request line on the right axis.
  if (input.line && input.line.length === input.bars.length && input.bars.length > 0) {
    const lineMax = niceCeil(Math.max(0, ...input.line));
    const ly = (v: number) => bottom - (Math.max(v, 0) / lineMax) * plotH;
    const fmt = input.formatLine ?? String;
    parts.push(`<text x="${width - margin.right + 8}" y="${n(ly(lineMax) + 4)}">${esc(fmt(lineMax))}</text>`);
    parts.push(`<text x="${width - margin.right + 8}" y="${n(ly(lineMax / 2) + 4)}">${esc(fmt(lineMax / 2))}</text>`);
    parts.push(`<text x="${width - margin.right + 8}" y="${n(bottom + 4)}">0</text>`);
    const coords = input.bars.map((bar, i) => [x(bar.from) + (x(bar.to) - x(bar.from)) / 2, ly(input.line![i]!)] as const);
    if (coords.length > 1) parts.push(`<polyline class="requests" points="${coords.map(([cx, cy]) => `${n(cx)},${n(cy)}`).join(" ")}"/>`);
    for (const [cx, cy] of coords) parts.push(`<circle class="request-dot" cx="${n(cx)}" cy="${n(cy)}" r="2.6"/>`);
  }

  parts.push("</svg>");
  return parts.join("");
}
