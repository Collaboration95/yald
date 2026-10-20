#!/usr/bin/env node
// Generates the production Yaldi vectors from shared parts, so every mark and
// state keeps the same palette, proportions, framing and baseline.
//
//   node docs/brand/yaldi/build-assets.mjs           # write SVGs + manifest
//   node docs/brand/yaldi/build-assets.mjs --raster  # also favicon.ico, PNGs, QA sheets
//
// The SVGs it writes are plain, hand-editable vectors, but this file is their
// source of truth: change a part here and regenerate rather than editing outputs.
// Rasterizing needs Google Chrome (headless) and ImageMagick; neither is a
// runtime or build dependency of Yald.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const pub = join(root, "web/public");

export const palette = {
  paper: "#fbf6eb",
  paperShade: "#ebe1cd",
  ink: "#202021",
  coral: "#d34d43",
  coralShade: "#b23d35",
  glow: "#f28b7e",
  cape: "#8e837b",
  capeShade: "#6f655e",
  glass: "#dfe6e6",
  // Dark surfaces: a paper-coloured keyline keeps the ink outline, hands, feet
  // and magnifier handle from disappearing into the background.
  halo: "#fbf6eb",
};
const P = palette;

// ---------------------------------------------------------------- primitives
// Elements are rendered in two passes for dark surfaces: a silhouette "halo"
// pass (every shape filled and stroked in the keyline colour, strokes widened)
// and the normal artwork on top. `detail` elements are skipped in the halo pass.
let keyline = 3; // halo width in the drawing's own units; set per asset
const attrs = (a) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

function el(tag, a, mode) {
  const { detail, ...rest } = a;
  if (mode !== "halo") return `<${tag} ${attrs(rest)}/>`;
  if (detail) return "";
  const out = { ...rest, opacity: undefined };
  const sw = Number(rest["stroke-width"] ?? 0);
  if (rest.fill && rest.fill !== "none") out.fill = P.halo;
  if (rest.stroke && rest.stroke !== "none") {
    out.stroke = P.halo;
    out["stroke-width"] = sw + keyline * 2;
  } else if (out.fill && out.fill !== "none") {
    out.stroke = P.halo;
    out["stroke-width"] = keyline * 2;
  }
  out["stroke-linejoin"] = "round";
  if (out["stroke-linecap"] === undefined) out["stroke-linecap"] = "round";
  return `<${tag} ${attrs(out)}/>`;
}
const g = (transform, body) => (transform ? `<g transform="${transform}">${body}</g>` : `<g>${body}</g>`);

// ---------------------------------------------------------------- the head
// Drawn in the 128-unit space of the approved logo-concept.svg so the mark and
// every full-body state share one head. `eyes` and `lens` vary by state.
const EYES = {
  open: () => [
    el("ellipse", { cx: 47, cy: 72, rx: 6, ry: 9, fill: P.glow, detail: true }),
    el("ellipse", { cx: 81, cy: 72, rx: 6, ry: 9, fill: P.glow, detail: true }),
  ],
  down: () => [
    el("ellipse", { cx: 46, cy: 77, rx: 6, ry: 8, fill: P.glow, detail: true }),
    el("ellipse", { cx: 80, cy: 77, rx: 6, ry: 8, fill: P.glow, detail: true }),
  ],
  wide: () => [
    el("ellipse", { cx: 46, cy: 71, rx: 7.5, ry: 11.5, fill: P.glow, detail: true }),
    el("ellipse", { cx: 82, cy: 71, rx: 7.5, ry: 11.5, fill: P.glow, detail: true }),
  ],
  // Lids lowered: a thoughtful, reading-the-chart look.
  focused: () => [
    el("path", { d: "M40 70h14v3a7 7 0 0 1-14 0z", fill: P.glow, detail: true }),
    el("path", { d: "M74 70h14v3a7 7 0 0 1-14 0z", fill: P.glow, detail: true }),
  ],
  // One eye open, one narrowed: not convinced yet.
  unsure: () => [
    el("ellipse", { cx: 47, cy: 72, rx: 6, ry: 9, fill: P.glow, detail: true }),
    el("path", { d: "M74 71h14v2a7 6 0 0 1-14 0z", fill: P.glow, detail: true }),
  ],
  closed: () => [
    el("path", { d: "M39 72q8 8 16 0", fill: "none", stroke: P.glow, "stroke-width": 4.5, "stroke-linecap": "round", detail: true }),
    el("path", { d: "M73 72q8 8 16 0", fill: "none", stroke: P.glow, "stroke-width": 4.5, "stroke-linecap": "round", detail: true }),
  ],
  happy: () => [
    el("path", { d: "M39 76q8-10 16 0", fill: "none", stroke: P.glow, "stroke-width": 4.5, "stroke-linecap": "round", detail: true }),
    el("path", { d: "M73 76q8-10 16 0", fill: "none", stroke: P.glow, "stroke-width": 4.5, "stroke-linecap": "round", detail: true }),
  ],
  // Inner corners raised: concerned, never cheerful (used for errors).
  worried: () => [
    el("path", { d: "M40 73l14-5v9a7 6 0 0 1-14 0z", fill: P.glow, detail: true }),
    el("path", { d: "M88 73l-14-5v9a7 6 0 0 0 14 0z", fill: P.glow, detail: true }),
  ],
};

function cap(mode) {
  return [
    el("path", { d: "M64 18L60 9", stroke: P.ink, "stroke-width": 7, "stroke-linecap": "round" }, mode),
    el("path", { d: "M64 19L71 9", stroke: P.ink, "stroke-width": 7, "stroke-linecap": "round" }, mode),
    el("path", {
      d: "M27 42C29 25 44 15 63 16C80 16 96 25 101 41L112 45C99 54 85 54 65 47C48 41 37 41 17 46Z",
      fill: P.coral, stroke: P.ink, "stroke-width": 6, "stroke-linejoin": "round",
    }, mode),
    // Seam and brim shading: only visible at mark sizes of 48 px and up.
    el("path", { d: "M63 19C58 26 56 34 57 43", fill: "none", stroke: P.coralShade, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
    el("path", { d: "M101 43L108 46C98 51 86 51 70 46", fill: "none", stroke: P.coralShade, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
  ].join("");
}

function head({ eyes = "open", lens = false, capTilt = 0 } = {}, mode) {
  const parts = [
    el("rect", { x: 17, y: 39, width: 94, height: 71, rx: 27, fill: P.paper, stroke: P.ink, "stroke-width": 6 }, mode),
    el("path", { d: "M24 92c4 10 12 14 24 14h32c12 0 20-4 24-14", fill: "none", stroke: P.paperShade, "stroke-width": 4, "stroke-linecap": "round", detail: true }, mode),
    el("rect", { x: 28, y: 50, width: 72, height: 48, rx: 17, fill: P.ink, detail: true }, mode),
    mode === "halo" ? "" : EYES[eyes]().join(""),
  ];
  if (lens) {
    parts.push(
      el("circle", { cx: 47, cy: 72, r: 18, fill: "none", stroke: P.paper, "stroke-width": 5, detail: true }, mode),
      el("path", { d: "M34 86L21 103", stroke: P.ink, "stroke-width": 10, "stroke-linecap": "round" }, mode),
    );
  }
  parts.push(capTilt ? g(`rotate(${capTilt} 64 40)`, cap(mode)) : cap(mode));
  return parts.join("");
}

// ---------------------------------------------------------------- marks
const svg = (w, h, body, { title, desc, label = true } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${
    label ? ` role="img" aria-labelledby="title${desc ? " desc" : ""}"` : ` aria-hidden="true"`
  }>\n` +
  (label ? `  <title id="title">${title}</title>\n` + (desc ? `  <desc id="desc">${desc}</desc>\n` : "") : "") +
  `  ${body}\n</svg>\n`;

// Full mark: the approved concept, tidied and centred in its 128 box. For 48 px and up.
function markFull(dark) {
  const body = (mode) => g("translate(0 7)", head({ eyes: "open", lens: true }, mode));
  return (dark ? g(null, body("halo")) : "") + body();
}

// 32-grid mark: the favicon silhouette with the cap bow added, on whole pixels.
// The lens ring is dropped below 40 px, where it smudges into an "@".
function mark32(dark) {
  keyline = 1;
  const body = (mode) =>
    [
      el("path", { d: "M16 4L14 1.5", stroke: P.ink, "stroke-width": 2, "stroke-linecap": "round" }, mode),
      el("path", { d: "M16 4L18.5 1.5", stroke: P.ink, "stroke-width": 2, "stroke-linecap": "round" }, mode),
      el("rect", { x: 2, y: 10, width: 28, height: 21, rx: 7, fill: P.ink }, mode),
      el("rect", { x: 4, y: 12, width: 24, height: 17, rx: 5, fill: P.paper, detail: true }, mode),
      el("rect", { x: 6, y: 16, width: 20, height: 11, rx: 3.5, fill: P.ink, detail: true }, mode),
      el("rect", { x: 10, y: 18, width: 3, height: 6, rx: 1.5, fill: P.glow, detail: true }, mode),
      el("rect", { x: 19, y: 18, width: 3, height: 6, rx: 1.5, fill: P.glow, detail: true }, mode),
      el("path", { d: "M4 14V12C4 6.5 9 3 16 3C22 3 26 5.5 27.5 10L31 11.4V14Z", fill: P.ink }, mode),
      el("path", { d: "M6 12C6 7.8 10.2 5 16 5C21 5 24.4 7.2 25.6 11.4L28 12Z", fill: P.coral, detail: true }, mode),
    ].join("");
  const out = (dark ? g(null, body("halo")) : "") + body();
  keyline = 3;
  return out;
}

// 16-grid favicon: a simpler silhouette rather than compressed detail —
// cap, head, face panel and two eyes, all on whole pixels.
function mark16() {
  return [
    // head (ink outline drawn as an outer shape for crisp 1 px edges)
    `<rect x="1" y="5" width="14" height="11" rx="3.5" fill="${P.ink}"/>`,
    `<rect x="2" y="6" width="12" height="9" rx="2.5" fill="${P.paper}"/>`,
    `<rect x="3" y="8" width="10" height="6" rx="1.5" fill="${P.ink}"/>`,
    `<rect x="5" y="9" width="2" height="4" rx="1" fill="${P.glow}"/>`,
    `<rect x="9" y="9" width="2" height="4" rx="1" fill="${P.glow}"/>`,
    // deerstalker: coral dome with the brim swept to the right
    `<path d="M2 7V6C2 2.4 4.6 0 8 0C11.2 0 13.4 1.7 14 4.4L16 5.2V7Z" fill="${P.ink}"/>`,
    `<path d="M3 6V5.6C3 3 5 1 8 1C10.6 1 12.4 2.3 13 4.8L15 5.8V6Z" fill="${P.coral}"/>`,
  ].join("");
}

// ---------------------------------------------------------------- full figure
// Every state shares a 160×160 canvas, centred on x=80 with feet on the
// baseline y=150, so swapping states never shifts the layout.
const W = 160;
const BASE = 150;
const HEAD_SCALE = 0.8;
const headAt = (opts, mode, { dx = 0, dy = 0, tilt = 0 } = {}) =>
  g(
    `translate(${28.8 + dx} ${8 + dy})${tilt ? ` rotate(${tilt} 64 110)` : ""} scale(${HEAD_SCALE})`,
    head(opts, mode),
  );

const limb = (x1, y1, x2, y2, mode, w = 13) =>
  el("path", { d: `M${x1} ${y1}L${x2} ${y2}`, stroke: P.ink, "stroke-width": w + 7, "stroke-linecap": "round" }, mode) +
  el("path", { d: `M${x1} ${y1}L${x2} ${y2}`, stroke: P.paper, "stroke-width": w, "stroke-linecap": "round", detail: true }, mode);
const hand = (cx, cy, mode, r = 7.5) => el("circle", { cx, cy, r, fill: P.ink }, mode);

function cape(mode, { spread = 0, low = 0 } = {}) {
  const b = 136 + low;
  return [
    el("path", {
      d: `M62 ${96 + low}C52 ${110 + low} ${46 - spread} ${124 + low} ${40 - spread} ${b}C52 ${b - 4} 58 ${b + 2} 66 ${b - 2}L94 ${b - 2}C102 ${b + 2} 108 ${b - 4} ${120 + spread} ${b}C${114 + spread} ${124 + low} 108 ${110 + low} 98 ${96 + low}Z`,
      fill: P.cape, stroke: P.ink, "stroke-width": 4, "stroke-linejoin": "round",
    }, mode),
    el("path", { d: `M${50 - spread} ${126 + low}C${56 - spread / 2} ${118 + low} 60 ${110 + low} 63 ${102 + low}`, fill: "none", stroke: P.capeShade, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
    el("path", { d: `M${110 + spread} ${126 + low}C${104 + spread / 2} ${118 + low} 100 ${110 + low} 97 ${102 + low}`, fill: "none", stroke: P.capeShade, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
  ].join("");
}

function standingBody(mode) {
  return [
    cape(mode),
    el("rect", { x: 63, y: 128, width: 13, height: 14, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, mode),
    el("rect", { x: 84, y: 128, width: 13, height: 14, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, mode),
    el("rect", { x: 59, y: 138, width: 20, height: BASE - 138, rx: 6, fill: P.ink }, mode),
    el("rect", { x: 81, y: 138, width: 20, height: BASE - 138, rx: 6, fill: P.ink }, mode),
    el("rect", { x: 60, y: 94, width: 40, height: 40, rx: 17, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, mode),
    el("path", { d: "M66 124c6 5 22 5 28 0", fill: "none", stroke: P.paperShade, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
    el("circle", { cx: 80, cy: 100, r: 4.5, fill: P.coral, stroke: P.ink, "stroke-width": 2.5 }, mode),
  ].join("");
}

// Glass is opaque so every state keeps opaque content on a transparent canvas;
// held over the face it shows a magnified eye instead of see-through glass.
function magnifier(cx, cy, r, angle, mode, { cracked = false, eye = false } = {}) {
  // handle points from the lens along `angle` (degrees, 0 = right, 90 = down)
  const a = (angle * Math.PI) / 180;
  const hx1 = +(cx + Math.cos(a) * (r + 3)).toFixed(1);
  const hy1 = +(cy + Math.sin(a) * (r + 3)).toFixed(1);
  const hx2 = +(cx + Math.cos(a) * (r + 17)).toFixed(1);
  const hy2 = +(cy + Math.sin(a) * (r + 17)).toFixed(1);
  return [
    el("path", { d: `M${hx1} ${hy1}L${hx2} ${hy2}`, stroke: P.ink, "stroke-width": 7, "stroke-linecap": "round" }, mode),
    el("circle", { cx, cy, r, fill: eye ? P.ink : P.glass, stroke: P.ink, "stroke-width": 6 }, mode),
    eye ? el("ellipse", { cx, cy: cy + 2, rx: r * 0.4, ry: r * 0.58, fill: P.glow, detail: true }, mode) : "",
    el("circle", { cx, cy, r: r - 4, fill: "none", stroke: P.paper, "stroke-width": 2, detail: true }, mode),
    el("path", { d: `M${cx - r * 0.55} ${cy - r * 0.1}a${r * 0.55} ${r * 0.55} 0 0 1 ${r * 0.45} ${-r * 0.45}`, fill: "none", stroke: "#ffffff", "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode),
    cracked
      ? el("path", { d: `M${cx + r * 0.55} ${cy - r * 0.8}L${cx + r * 0.1} ${cy - r * 0.25}L${cx + r * 0.35} ${cy + r * 0.05}L${cx - r * 0.2} ${cy + r * 0.4}L${cx - r * 0.4} ${cy + r * 0.85}M${cx + r * 0.1} ${cy - r * 0.25}L${cx - r * 0.45} ${cy - r * 0.35}`, fill: "none", stroke: P.ink, "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round", detail: true }, mode)
      : "",
  ].join("");
}

function notebook(x, y, w, h, tilt, bars, mode) {
  const rings = [0.25, 0.5, 0.75]
    .map((f) => el("path", { d: `M${x + w * f} ${y - 4}v8`, stroke: P.ink, "stroke-width": 3, "stroke-linecap": "round", detail: true }, mode))
    .join("");
  const bw = (w - 16) / bars.length;
  const chart = bars
    .map(([v, solid], i) => {
      const bh = (h - 20) * v;
      const bx = x + 8 + i * bw + 1;
      const by = y + h - 8 - bh;
      return solid
        ? el("rect", { x: +bx.toFixed(1), y: +by.toFixed(1), width: +(bw - 2.5).toFixed(1), height: +bh.toFixed(1), fill: P.coral, detail: true }, mode)
        : el("rect", { x: +bx.toFixed(1), y: +by.toFixed(1), width: +(bw - 2.5).toFixed(1), height: +bh.toFixed(1), fill: P.paperShade, detail: true }, mode);
    })
    .join("");
  return g(`rotate(${tilt} ${x + w / 2} ${y + h / 2})`, [
    el("rect", { x, y, width: w, height: h, rx: 3, fill: P.paper, stroke: P.ink, "stroke-width": 3.5 }, mode),
    el("path", { d: `M${x + 6} ${y + h - 8}H${x + w - 6}`, stroke: P.ink, "stroke-width": 2, detail: true }, mode),
    chart,
    rings,
  ].join(""));
}

function folder(x, y, w, h, tilt, mode, { stripes = false } = {}) {
  const inner = stripes
    ? [0, 1, 2, 3, 4, 5, 6]
        .map((i) => el("path", { d: `M${x + 4 + i * 8} ${y + h - 4}l10 -14`, stroke: P.coral, "stroke-width": 3.5, "stroke-linecap": "round", detail: true }, mode))
        .join("")
    : [0, 1, 2]
        .map((i) => el("path", { d: `M${x + 9} ${y + 12 + i * 7}H${x + w - 10 - i * 6}`, stroke: P.cape, "stroke-width": 2, "stroke-dasharray": "3 3", "stroke-linecap": "round", detail: true }, mode))
        .join("");
  return g(`rotate(${tilt} ${x + w / 2} ${y + h / 2})`, [
    el("path", { d: `M${x} ${y + 4}a4 4 0 0 1 4-4h12l4 5h${w - 24}a4 4 0 0 1 4 4v${h - 9}a4 4 0 0 1-4 4h-${w - 8}a4 4 0 0 1-4-4z`, fill: P.paperShade, stroke: P.ink, "stroke-width": 3.5, "stroke-linejoin": "round" }, mode),
    stripes ? g(null, `<clipPath id="fold-clip"><rect x="${x + 2}" y="${y + 7}" width="${w - 4}" height="${h - 9}" rx="3"/></clipPath><g clip-path="url(#fold-clip)">${inner}</g>`) : inner,
  ].join(""));
}

const sparks = (mode, x, y) =>
  [
    `M${x} ${y}l4 -13`, `M${x + 8} ${y + 6}l11 -8`, `M${x + 10} ${y + 17}l13 0`,
  ].map((d) => el("path", { d, stroke: P.coral, "stroke-width": 5, "stroke-linecap": "round" }, mode)).join("");

export const STATES = {
  investigating: {
    use: "Loading or searching: Yald is reading logs or computing an investigation.",
    alt: "Yaldi looking through a magnifying glass",
    draw: (m) => [
      standingBody(m),
      limb(98, 106, 110, 116, m), hand(111, 118, m),
      headAt({ eyes: "open" }, m),
      limb(64, 108, 52, 104, m), hand(50, 101, m),
      magnifier(66, 63, 17, 118, m, { eye: true }),
    ],
  },
  analysing: {
    use: "Analysis in progress or a computed comparison being explained.",
    alt: "Yaldi reading a small bar chart in a notebook",
    draw: (m) => [
      standingBody(m),
      headAt({ eyes: "focused" }, m, { tilt: 4 }),
      limb(64, 108, 64, 100, m), hand(64, 96, m),
      limb(97, 108, 108, 114, m),
      notebook(104, 92, 34, 40, 8, [[0.3, 1], [0.5, 1], [0.4, 1], [0.85, 1]], m),
      hand(110, 118, m),
    ],
  },
  "clue-found": {
    use: "An evidence-backed finding. Never use for errors or unverified claims.",
    alt: "Yaldi surprised at a discovered clue",
    draw: (m) => [
      standingBody(m),
      headAt({ eyes: "wide" }, m, { tilt: -3 }),
      limb(64, 108, 52, 92, m), hand(50, 88, m),
      limb(96, 108, 108, 92, m), hand(110, 88, m),
      sparks(m, 128, 26),
    ],
  },
  resting: {
    use: "Idle or nothing to report yet (for example Labs before a scope is chosen).",
    alt: "Yaldi asleep with the cap tilted",
    draw: (m) => [
      // sitting with legs forward and hands folded, as in the concept sheet
      cape(m, { spread: 14, low: 8 }),
      el("rect", { x: 56, y: 124, width: 14, height: 18, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, m),
      el("rect", { x: 90, y: 124, width: 14, height: 18, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, m),
      el("ellipse", { cx: 80, cy: 124, rx: 24, ry: 17, fill: P.paper, stroke: P.ink, "stroke-width": 4 }, m),
      el("ellipse", { cx: 60, cy: BASE - 7, rx: 12, ry: 7, fill: P.ink }, m),
      el("ellipse", { cx: 100, cy: BASE - 7, rx: 12, ry: 7, fill: P.ink }, m),
      hand(75, 125, m, 6.5), hand(85, 129, m, 6.5),
      headAt({ eyes: "closed", capTilt: 10 }, m, { dy: 14, tilt: -10 }),
    ],
  },
  empty: {
    use: "No data in the selected scope. Pair with text that says what is missing.",
    alt: "Yaldi holding an empty case file",
    draw: (m) => [
      standingBody(m),
      headAt({ eyes: "down" }, m, { tilt: 3 }),
      limb(64, 108, 60, 118, m),
      limb(96, 108, 100, 118, m),
      folder(50, 106, 60, 34, -4, m),
      hand(58, 122, m), hand(102, 120, m),
    ],
  },
  insufficient: {
    use: "Too little evidence for a finding. Pair with the coverage or threshold text.",
    alt: "Yaldi checking a notebook with too few bars",
    draw: (m) => [
      standingBody(m),
      limb(64, 108, 58, 116, m),
      notebook(24, 94, 36, 42, -6, [[0.3, 1], [0.75, 0], [0.55, 0]], m),
      hand(56, 120, m),
      headAt({ eyes: "unsure" }, m, { tilt: -4 }),
      limb(97, 106, 112, 78, m), hand(114, 70, m),
    ],
  },
  error: {
    use: "A load or read failure. Always alongside the error text; never cheerful.",
    alt: "Yaldi looking worried at a cracked magnifying glass",
    draw: (m) => [
      standingBody(m),
      headAt({ eyes: "worried", capTilt: -6 }, m, { dy: 2, tilt: 5 }),
      limb(96, 108, 104, 120, m),
      magnifier(124, 96, 16, 125, m, { cracked: true }),
      hand(106, 122, m),
      limb(64, 108, 58, 118, m), hand(57, 121, m),
    ],
  },
  demo: {
    use: "Synthetic sample data is shown. Pair with a visible “sample data” label.",
    alt: "Yaldi waving while holding a striped sample case file",
    draw: (m) => [
      standingBody(m),
      headAt({ eyes: "happy" }, m, { tilt: -3 }),
      limb(97, 106, 120, 84, m), hand(125, 78, m),
      el("path", { d: "M134 66q6 6 4 14M140 60q9 9 6 22", fill: "none", stroke: P.capeShade, "stroke-width": 3, "stroke-linecap": "round" }, m),
      limb(64, 108, 58, 118, m),
      folder(24, 106, 44, 32, -6, m, { stripes: true }),
      hand(63, 120, m),
    ],
  },
};

function stateSvg(name, dark) {
  const s = STATES[name];
  const body = (m) => s.draw(m).join("");
  // halo ids must be unique if the clip-path is used twice in one document
  const halo = dark ? g(null, body("halo").replaceAll("fold-clip", "fold-clip-halo")) : "";
  return svg(W, W, halo + body(), { title: `Yaldi: ${s.alt}` });
}

// ---------------------------------------------------------------- outputs
export const OUTPUTS = [
  { file: "web/public/favicon.svg", size: 16, theme: "both", shipped: true, use: "Browser tab favicon. 16-grid simplified silhouette.", make: () => svg(16, 16, mark16(), { title: "Yald" }) },
  { file: "web/public/yaldi/mark.svg", size: 128, theme: "light", shipped: true, use: "Full mark on light surfaces, 40 px and larger.", make: () => svg(128, 128, markFull(false), { title: "Yaldi", desc: "A rounded robot face with a coral detective cap and a magnifying glass." }) },
  { file: "web/public/yaldi/mark-dark.svg", size: 128, theme: "dark", shipped: true, use: "Full mark on dark surfaces, 40 px and larger (paper keyline).", make: () => svg(128, 128, markFull(true), { title: "Yaldi", desc: "A rounded robot face with a coral detective cap and a magnifying glass." }) },
  { file: "web/public/yaldi/mark-small.svg", size: 32, theme: "light", shipped: true, use: "Small mark on light surfaces, 24–40 px (e.g. next to the wordmark).", make: () => svg(32, 32, mark32(false), { title: "Yaldi" }) },
  { file: "web/public/yaldi/mark-small-dark.svg", size: 32, theme: "dark", shipped: true, use: "Small mark on dark surfaces, 24–40 px.", make: () => svg(32, 32, mark32(true), { title: "Yaldi" }) },
  ...Object.entries(STATES).flatMap(([name, s]) =>
    ["light", "dark"].map((theme) => ({
      file: `web/public/yaldi/state-${name}${theme === "dark" ? "-dark" : ""}.svg`,
      size: W, theme, shipped: true, state: name, alt: s.alt, use: s.use,
      make: () => stateSvg(name, theme === "dark"),
    })),
  ),
];

const RASTERS = [
  { file: "web/public/favicon.ico", sizes: [16, 32, 48], theme: "both", shipped: true, use: "Legacy favicon: 16 px simplified, 32 px small mark, 48 px full mark." },
  { file: "web/public/apple-touch-icon.png", size: 180, theme: "both", shipped: true, use: "Home-screen icon. Opaque paper tile by platform convention." },
];

const REFERENCE = [
  { file: "docs/brand/yaldi/logo-concept.svg", shipped: false, use: "Approved editable logo concept (original, unchanged)." },
  { file: "docs/brand/yaldi/mascot-concept.png", shipped: false, use: "Approved four-pose concept sheet (original, unchanged). Not animation frames." },
  { file: "docs/brand/yaldi/generation-prompt.txt", shipped: false, use: "Exact image-generation prompt and provenance for mascot-concept.png." },
  { file: "docs/brand/yaldi/qa/", shipped: false, use: "Rendered QA sheets (light and dark surfaces, real sizes). Regenerate with --raster." },
];

function write(rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

for (const o of OUTPUTS) write(o.file, o.make());

write(
  "docs/brand/yaldi/manifest.json",
  JSON.stringify(
    {
      generatedBy: "docs/brand/yaldi/build-assets.mjs",
      palette: Object.fromEntries(Object.entries(P)),
      stateCanvas: { width: W, height: W, baselineY: BASE, centreX: W / 2 },
      runtimeBase: "/yaldi/ (served from web/public/yaldi via Vite publicDir)",
      assets: [
        ...OUTPUTS.map(({ file, size, theme, shipped, state, alt, use }) => ({ file, width: size, height: size, theme, shipped, state, alt, use })),
        ...RASTERS.map(({ file, size, sizes, theme, shipped, use }) => ({ file, ...(size ? { width: size, height: size } : { sizes }), theme, shipped, use })),
        ...REFERENCE,
      ],
    },
    null,
    2,
  ) + "\n",
);

// ---------------------------------------------------------------- rasters
if (process.argv.includes("--raster")) {
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME=...`);
  const tmp = join(tmpdir(), `yaldi-raster-${process.pid}`);
  mkdirSync(tmp, { recursive: true });

  const shot = (html, w, h, out, bg = "00000000") => {
    const page = join(tmp, "page.html");
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block}</style>${html}`);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      `--default-background-color=${bg}`, `--window-size=${w},${h}`, `--screenshot=${out}`, `file://${page}`,
    ], { stdio: "ignore" });
  };
  const img = (rel, size, extra = "") => `<img src="file://${join(root, rel)}" width="${size}" height="${size}" ${extra}>`;

  const ico = [
    ["web/public/favicon.svg", 16],
    ["web/public/yaldi/mark-small.svg", 32],
    ["web/public/yaldi/mark.svg", 48],
  ].map(([rel, n]) => {
    const out = join(tmp, `ico-${n}.png`);
    shot(img(rel, n), n, n, out);
    return out;
  });
  execFileSync("magick", [...ico, join(pub, "favicon.ico")]);

  shot(
    `<div style="width:180px;height:180px;background:${P.paper};display:grid;place-items:center">${img("web/public/yaldi/mark.svg", 150)}</div>`,
    180, 180, join(pub, "apple-touch-icon.png"), "fbf6ebff",
  );

  // QA sheets: every shipped vector at its real sizes on the app's light and dark surfaces.
  const qa = join(here, "qa");
  rmSync(qa, { recursive: true, force: true });
  mkdirSync(qa, { recursive: true });
  const surfaces = { light: ["#ffffff", "#f5f6f8"], dark: ["#0e1522", "#070b14"] };
  for (const [theme, [surface, bg]] of Object.entries(surfaces)) {
    const sfx = theme === "dark" ? "-dark" : "";
    const marks = [
      ["web/public/favicon.svg", [16, 24, 32]],
      [`web/public/yaldi/mark-small${sfx}.svg`, [24, 32, 40]],
      [`web/public/yaldi/mark${sfx}.svg`, [48, 64, 128]],
    ]
      .map(([rel, sizes]) => sizes.map((n) => img(rel, n, `title="${rel} @${n}"`)).join(""))
      .join("");
    const states = Object.keys(STATES)
      .map((n) => `<figure>${img(`web/public/yaldi/state-${n}${sfx}.svg`, 160)}<figcaption>${n}</figcaption></figure>`)
      .join("");
    const small = Object.keys(STATES).map((n) => img(`web/public/yaldi/state-${n}${sfx}.svg`, 72)).join("");
    shot(
      `<style>body{background:${bg};font:12px system-ui;color:${theme === "dark" ? "#b3bdd0" : "#475063"}}
      .row{display:flex;align-items:flex-end;gap:18px;padding:18px;margin:12px;background:${surface};border-radius:10px}
      figure{margin:0;text-align:center;position:relative}
      figure::after{content:"";position:absolute;left:0;right:0;top:${BASE}px;border-top:1px dashed ${theme === "dark" ? "#2b3a51" : "#d6dbe3"}}</style>
      <div class="row">${marks}</div><div class="row">${states}</div><div class="row">${small}</div>`,
      1460, 520, join(qa, `sheet-${theme}.png`), surface.slice(1) + "ff",
    );
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`wrote ${OUTPUTS.length} vectors${process.argv.includes("--raster") ? " + rasters" : ""} (${relative(process.cwd(), here)})`);
