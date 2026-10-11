// Regenerates __fixtures__/report.sample.json from the synthetic fixture home:
//
//   bun run server/src/report/sample.ts
//
// The fixture home (web/scripts/fixtureHome.ts, with its report day) is built at a
// frozen clock and priced by the fixture cost engine, so the output is byte-identical
// on every run and machine. build.test.ts rebuilds the same payload and fails when
// the committed file is stale. This is a development script: it imports the fixture
// home from web/scripts, which the published package does not ship.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitRoot } from "../projects";
import { buildReport, type ReportDataset } from "./build";
import { buildReportSpec, type ReportSpecInput } from "./spec";
import type { ReportData } from "./types";

/** The fixture clock: the end of the sample window, 18:00 in Singapore. */
export const SAMPLE_NOW = Date.parse("2026-10-11T18:00:00+08:00");
export const SAMPLE_VERSION = "0.1.0";

/** Two sources, three phases with a gap before the first, a 24-hour window. */
export const SAMPLE_INPUT: ReportSpecInput = {
  tz: "Asia/Singapore",
  from: "2026-10-10 18:00",
  to: "2026-10-11 18:00",
  phases: ["Prep=2026-10-10 23:30..2026-10-11 09:00", "Build=2026-10-11 09:00..+6h", "Demo=2026-10-11 15:00..2026-10-11 18:00"],
  title: "Fixture makeathon",
};

/** The sample payload for a dataset read from the fixture home at `home`. */
export function sampleReport(dataset: ReportDataset, home: string): ReportData {
  const spec = buildReportSpec(SAMPLE_INPUT, { now: SAMPLE_NOW, first: dataset.rows[0]?.ts ?? SAMPLE_NOW });
  return buildReport(dataset, spec, {
    now: SAMPLE_NOW,
    yaldVersion: SAMPLE_VERSION,
    pricing: "ok",
    home,
    projectOf: cwd => gitRoot(cwd) ?? cwd,
    claudeProjectsDir: join(home, "claude-projects"),
  });
}

export function sampleJson(report: ReportData): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

if (import.meta.main) {
  // Paths in env.ts are fixed at import, so the fixture home is set up before the store loads.
  const { materializeFixtureHome, materializeFixturePricing } = await import("../../../web/scripts/fixtureHome");
  Date.now = () => SAMPLE_NOW;
  const home = await materializeFixtureHome({ reportDay: true });
  const pricing = await materializeFixturePricing();
  Object.assign(process.env, {
    OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), CODEX_HOME: join(home, "codex"), OCX_PACKAGE_DIR: pricing,
  });
  try {
    const { getDataset } = await import("../ocx/store");
    const report = sampleReport(await getDataset(), home);
    const json = sampleJson(report);
    const out = new URL("./__fixtures__/report.sample.json", import.meta.url);
    await writeFile(out, json);
    console.log(`wrote ${out.pathname} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
  } finally {
    await Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
  }
}
