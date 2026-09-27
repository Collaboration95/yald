import { existsSync } from "node:fs";
import { HOSTNAME, OCX_HOME, PORT } from "./env";
import { api } from "./api";
import { loadPricing, pricingStatus } from "./ocx/pricing";
import { getDataset } from "./ocx/store";

api.get("/api/dataset/refresh", async c => {
  const dataset = await getDataset({ force: true });
  return c.json({ ok: true, rows: dataset.rows.length, parseMs: dataset.parse.durationMs, builtAt: dataset.builtAt });
});

const webDist = new URL("../../web/dist", import.meta.url).pathname;
const hasWebDist = existsSync(webDist);
let indexHtml: string | null = null;

if (hasWebDist) {
  const { serveStatic } = await import("hono/bun");
  const indexPath = `${webDist}/index.html`;
  indexHtml = await Bun.file(indexPath).text();
  api.use("/*", serveStatic({ root: webDist }));
  // Client-side routes (for example /conversations/<id>) must return the shell, not 404.
  api.notFound(c => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ ok: false, error: "not found", path: c.req.path }, 404);
    }
    return c.html(indexHtml ?? "<!doctype html><title>OCX Observatory</title>");
  });
} else {
  api.get("/", c => c.text("ocx-observatory API is running. Build the web app with: bun run build"));
}

await loadPricing();
const boot = await getDataset();

console.log(
  [
    `ocx-observatory`,
    `  home      ${OCX_HOME}`,
    `  requests  ${boot.rows.length} parsed in ${boot.parse.durationMs}ms`,
    `  pricing   ${pricingStatus().available ? pricingStatus().detail : `unavailable — ${pricingStatus().detail}`}`,
    `  listening http://${HOSTNAME}:${PORT}`,
  ].join("\n"),
);

export default { port: PORT, hostname: HOSTNAME, fetch: api.fetch, idleTimeout: 120 };
