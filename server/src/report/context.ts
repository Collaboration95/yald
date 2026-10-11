// The one ReportContext for live callers (`yald report` and `GET /api/report`), so
// the same inputs give byte-identical JSON from both (apart from meta.generatedAt).
// Imports env.ts, so callers that redirect data paths set process.env first.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CLAUDE_PROJECTS } from "../env";
import { pricingStatus } from "../ocx/pricing";
import { gitRoot } from "../projects";
import type { ReportContext } from "./build";

/** Version from the root package.json, which ships in the npm package. */
export const YALD_VERSION: string = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

export function liveReportContext(now: number): ReportContext {
  return {
    now,
    yaldVersion: YALD_VERSION,
    pricing: pricingStatus().available ? "ok" : "unavailable",
    home: process.env.HOME || homedir(),
    projectOf: cwd => gitRoot(cwd) ?? cwd,
    claudeProjectsDir: CLAUDE_PROJECTS,
  };
}
