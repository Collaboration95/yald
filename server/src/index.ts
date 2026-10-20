import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOSTNAME, OCX_HOME, PORT } from "./env";
import { api } from "./api";
import { loadPricing, pricingStatus } from "./ocx/pricing";
import { getDataset } from "./ocx/store";
import { DEMO } from "./demo/mode";

api.get("/api/dataset/refresh", async c => {
  const dataset = await getDataset({ force: true });
  return c.json({ ok: true, rows: dataset.rows.length, parseMs: dataset.parse.durationMs, builtAt: dataset.builtAt });
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const hasWebDist = existsSync(webDist);
let indexHtml: string | null = null;

if (hasWebDist) {
  const { serveStatic } = await import("hono/bun");
  const indexPath = `${webDist}/index.html`;
  indexHtml = await Bun.file(indexPath).text();
  if (DEMO) {
    // The bootstrap precedes modules, so API windows and relative UI labels share
    // the fixed screenshot clock. Suppress remote font requests in the demo.
    indexHtml = indexHtml.replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g, "")
      .replace("</head>", `<script type="application/json" id="yald-demo">${JSON.stringify(DEMO).replace(/</g, "\\u003c")}</script></head>`);
    api.get("/", c => c.html(indexHtml!));
    api.get("/index.html", c => c.html(indexHtml!));
  }
  api.use("/*", serveStatic({ root: webDist }));
  // Client-side routes (for example /conversations/<id>) must return the shell, not 404.
  api.notFound(c => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ ok: false, error: "not found", path: c.req.path }, 404);
    }
    return c.html(indexHtml ?? "<!doctype html><title>yald</title>");
  });
} else {
  if (DEMO) throw new Error("Demo web assets are missing. Reinstall the built Yald package.");
  api.get("/", c => c.text("yald API is running. Build the web app with: bun run build"));
}

await loadPricing();
const boot = await getDataset();

if (!DEMO) console.log(
  [
    `yald`,
    `  home      ${OCX_HOME}`,
    `  requests  ${boot.rows.length} parsed in ${boot.parse.durationMs}ms`,
    `  pricing   ${pricingStatus().available ? pricingStatus().detail : `unavailable — ${pricingStatus().detail}`}`,
    `  listening http://${HOSTNAME}:${PORT}`,
  ].join("\n"),
);

export default { port: PORT, hostname: HOSTNAME, fetch: api.fetch, idleTimeout: 120 };
