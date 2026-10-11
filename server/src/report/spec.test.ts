import { describe, expect, test } from "bun:test";
import { WindowError } from "../time/window";
import { buildReportSpec, ReportSpecError, type ReportSpecInput } from "./spec";

const now = Date.parse("2026-10-11T18:00:00+08:00");
const ctx = { now, first: now - 30 * 86_400_000 };
const sgt = (wall: string) => Date.parse(`${wall}+08:00`);
const spec = (input: ReportSpecInput) => buildReportSpec({ tz: "Asia/Singapore", ...input }, ctx);

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected an error");
}

describe("buildReportSpec", () => {
  test("defaults: last 24 hours, both sources, no projects, top 10, redacted, no title", () => {
    expect(spec({})).toMatchObject({ window: { from: now - 86_400_000, to: now, tz: "Asia/Singapore" }, phases: [], sources: ["claude-code", "ocx"], projects: [], top: 10, redact: true });
    expect(spec({})).not.toHaveProperty("title");
    expect(buildReportSpec({ tz: "UTC" }, { ...ctx, defaultRange: "7d" }).window.from).toBe(now - 7 * 86_400_000);
  });

  test("reads the window and phases the way the time module does", () => {
    const result = spec({ from: "2026-10-10 23:30", to: "2026-10-11 18:00", phases: ["Build=2026-10-11 09:00..+6h", "Prep=2026-10-10 23:30..2026-10-11 09:00"] });
    expect(result.window).toMatchObject({ from: sgt("2026-10-10T23:30"), to: now });
    expect(result.phases).toEqual([
      { name: "Prep", from: sgt("2026-10-10T23:30"), to: sgt("2026-10-11T09:00") },
      { name: "Build", from: sgt("2026-10-11T09:00"), to: sgt("2026-10-11T15:00") },
    ]);
  });

  test("with phases and no window, the window spans first phase start to last phase end", () => {
    const result = spec({ phases: ["Demo=2026-10-11 15:00..2026-10-11 17:00", "Build=2026-10-11 09:00..+6h"] });
    expect(result.window).toMatchObject({ from: sgt("2026-10-11T09:00"), to: sgt("2026-10-11T17:00"), tz: "Asia/Singapore", label: "Sun 11 Oct 2026, 09:00–17:00 GMT+8" });
    expect(result.window.input).toEqual({ from: "2026-10-11T09:00:00+08:00", to: "2026-10-11T17:00:00+08:00" });
    expect(result.phases.map(p => p.name)).toEqual(["Build", "Demo"]);
    // Relative phase bounds count from now.
    expect(spec({ phases: ["Recent=-2h..now"] }).window).toMatchObject({ from: now - 7_200_000, to: now });
  });

  test("window and phase problems throw WindowError", () => {
    const cases: Array<[ReportSpecInput, string, string]> = [
      [{ from: "11 Oct" }, "invalid_time", "from"],
      [{ tz: "Mars/Olympus" }, "invalid_zone", "tz"],
      [{ from: "2026-10-11 09:00", to: "2026-10-11 10:00", phases: ["Late=2026-10-11 09:30..+1h"] }, "phase_outside_window", "phase[0]"],
      [{ phases: ["A=2026-10-11 09:00..+2h", "B=2026-10-11 10:00..+2h"] }, "phase_overlap", "phase[1]"],
      [{ phases: ["Future=now..+1h"] }, "phase_outside_window", "phase[0]"],
      [{ phases: ["no separator"] }, "invalid_phase", "phase[0]"],
      [{ phases: [""] }, "invalid_phase", "phase[0]"],
      [{ phases: ["Build=2026-10-11 09:00..+2h", "   "] }, "invalid_phase", "phase[1]"],
      [{ from: "", phases: ["Build=2026-10-11 09:00..+2h"] }, "invalid_time", "from"],
    ];
    for (const [input, code, param] of cases) {
      const error = thrown(() => spec(input));
      expect(error).toBeInstanceOf(WindowError);
      expect(error).toMatchObject({ code, param });
    }
  });

  test("sources accept aliases, commas and any order, and list canonically", () => {
    expect(spec({ sources: "codex" }).sources).toEqual(["ocx"]);
    expect(spec({ sources: "Claude" }).sources).toEqual(["claude-code"]);
    expect(spec({ sources: "ocx, claude-code" }).sources).toEqual(["claude-code", "ocx"]);
    expect(spec({ sources: ["codex", "ocx"] }).sources).toEqual(["ocx"]);
    expect(spec({ sources: "" }).sources).toEqual(["claude-code", "ocx"]);
    const error = thrown(() => spec({ sources: ["claude", "gemini"] }));
    expect(error).toBeInstanceOf(ReportSpecError);
    expect(error).toMatchObject({ code: "invalid_source", param: "sources" });
    expect((error as Error).message).toContain('"gemini"');
  });

  test("projects: a string splits on commas, an array is taken as is", () => {
    expect(spec({ projects: "~/work/app-a*, /tmp/commons-*" }).projects).toEqual(["~/work/app-a*", "/tmp/commons-*"]);
    expect(spec({ projects: ["~/work/{app-a,app-b}"] }).projects).toEqual(["~/work/{app-a,app-b}"]);
  });

  test("top defaults to 10, caps at 100 and rejects anything but a positive whole number", () => {
    expect(spec({ top: "25" }).top).toBe(25);
    expect(spec({ top: 500 }).top).toBe(100);
    expect(spec({ top: "" }).top).toBe(10);
    for (const top of [0, -1, 2.5, "ten"]) {
      expect(thrown(() => spec({ top }))).toMatchObject({ name: "ReportSpecError", code: "invalid_top", param: "top" });
    }
  });

  test("redact defaults to true; false or a false-ish string turns it off", () => {
    expect(spec({ redact: false }).redact).toBe(false);
    for (const value of ["false", "0", "no", "OFF"]) expect(spec({ redact: value }).redact).toBe(false);
    expect(spec({ redact: "true" }).redact).toBe(true);
  });

  test("title is trimmed and dropped when blank", () => {
    expect(spec({ title: "  Makeathon  " }).title).toBe("Makeathon");
    expect(spec({ title: "  " })).not.toHaveProperty("title");
  });
});
