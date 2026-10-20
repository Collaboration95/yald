/** Own synthetic L08 production preview. No user homes; only this listener/data is cleaned up. */
import { EVIDENCE_PARAMS, EVIDENCE_TO, materializeEvidenceFixture } from "../web/scripts/evidence-fixtures";

const fixture = await materializeEvidenceFixture();
Object.assign(process.env, fixture.env, { YALD_HOST: "127.0.0.1", YALD_PORT: process.env.YALD_PREVIEW_PORT ?? "5508" });
Date.now = () => EVIDENCE_TO + 60_000;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: string[] = [];
let failEvidence = false, delay = 0, stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; server?.stop(true); await fixture.cleanup(); process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  const { default: app } = await import("../server/src/index");
  server = Bun.serve({ ...app, fetch: async request => {
    const url = new URL(request.url);
    if (url.pathname === "/__l08/requests") return Response.json(requests);
    if (url.pathname === "/__l08/control") {
      if (url.searchParams.has("failure")) failEvidence = url.searchParams.get("failure") === "on";
      if (url.searchParams.has("delay")) delay = Math.max(0, Math.min(5000, Number(url.searchParams.get("delay")) || 0));
      return Response.json({ failEvidence, delay });
    }
    if (url.pathname.startsWith("/api/labs/")) requests.push(url.pathname + url.search);
    if (url.pathname === "/api/labs/evidence") {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (failEvidence) return Response.json({ error: "Synthetic evidence failure" }, { status: 503 });
    }
    return app.fetch(request);
  } });
  console.log(`L08 synthetic preview: http://127.0.0.1:${server.port}/labs/project-radar?${EVIDENCE_PARAMS}`);
  console.log(`Fixture project: ${fixture.app}`);
} catch (error) { await fixture.cleanup(); throw error; }
