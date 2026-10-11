import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  formatInZone, isoInZone, nextBucketStart, parseDuration, parseInstant, parsePhases, parseWindow, windowLabel, zonedBucketStart,
  WindowError, type TimeWindow, type WindowErrorCode,
} from "./window";

// Every table runs in three reading zones, and the whole file runs under three process
// zones: results must never depend on the TZ the server happens to run under. CI also
// runs this directory once per process TZ (`TZ=... bun test server/src/time`).
const ZONES = [
  { tz: "Asia/Singapore", offset: "+08:00" },
  { tz: "UTC", offset: "+00:00" },
  { tz: "America/New_York", offset: "-04:00" }, // EDT throughout October 2026
];
const PROCESS_ZONES = ["UTC", "Asia/Singapore", "America/Los_Angeles"];
const originalTz = process.env.TZ;
afterAll(() => { process.env.TZ = originalTz; });

const H = 3_600_000;
const D = 24 * H;
// 2026-10-11 20:00 SGT, 12:00 UTC, 08:00 EDT: the same local date in all three zones.
const now = Date.parse("2026-10-11T12:00:00Z");
const first = Date.parse("2026-09-01T00:00:00Z");

function local(wall: string, offset: string): number {
  return Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}${offset}`);
}

function failure(run: () => unknown): { code: WindowErrorCode; param: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowError);
    const { code, param, message } = error as WindowError;
    return { code, param, message };
  }
  throw new Error("expected a WindowError");
}

describe.each(PROCESS_ZONES)("process TZ=%s", processTz => {
  beforeAll(() => { process.env.TZ = processTz; });
  test("the process zone is in effect", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(processTz);
  });

  describe.each(ZONES)("reading in $tz", ({ tz, offset }) => {
    const ctx = { tz, now };

    test.each([
      ["2026-10-11T09:00:00+08:00", () => Date.parse("2026-10-11T01:00:00Z")],
      ["2026-10-11T01:00Z", () => Date.parse("2026-10-11T01:00:00Z")],
      ["2026-10-11T01:00:00.250z", () => Date.parse("2026-10-11T01:00:00.250Z")],
      ["2026-10-11T09:00-0500", () => Date.parse("2026-10-11T14:00:00Z")],
      ["2026-10-11T09:00", () => local("2026-10-11T09:00", offset)],
      ["2026-10-11 09:00", () => local("2026-10-11T09:00", offset)],
      ["2026-10-11 09:00:30", () => local("2026-10-11T09:00:30", offset)],
      ["2026-10-11", () => local("2026-10-11T00:00", offset)],
      ["1791680400000", () => 1_791_680_400_000],
      ["now", () => now],
      ["today", () => local("2026-10-11T00:00", offset)],
      ["yesterday", () => local("2026-10-10T00:00", offset)],
      ["now-8h", () => now - 8 * H],
      ["today+9h", () => local("2026-10-11T09:00", offset)],
      ["yesterday+18h30m", () => local("2026-10-10T18:30", offset)],
      ["Now - 90m", () => now - 90 * 60_000],
      ["-8h", () => now - 8 * H],
      ["-1d", () => local(isoWall(now - D, offset), offset)],
    ])("instant %p", (text, expected) => {
      expect(parseInstant(text, ctx)).toBe(expected());
    });

    test("+duration counts from the anchor and is only valid as an end", () => {
      const start = local("2026-10-11T09:00", offset);
      expect(parseInstant("+6h", { ...ctx, anchor: start })).toBe(start + 6 * H);
      expect(parseInstant("+1h30m", { ...ctx, anchor: start })).toBe(start + 90 * 60_000);
      expect(failure(() => parseInstant("+6h", ctx))).toMatchObject({ code: "invalid_time", param: "from" });
    });

    test.each([
      "11/10 9am", "2026-10-11T09:00:00 08:00", "2026-13-01", "2026-02-30", "2026-10-11 24:00", "2026-10-11T09:60",
      "2026-10-11T09:00+25:00", "2026-10-11+08:00", "179168040000000", "tomorrow", "today+", "",
    ])("unreadable instant %p is invalid_time quoting the input", text => {
      const error = failure(() => parseInstant(text, ctx));
      expect(error).toMatchObject({ code: "invalid_time", param: "from" });
      expect(error.message).toContain(`"${text}"`);
    });

    test.each([
      ["now-8x"], ["-0h"], ["today+x"],
    ])("bad relative offset %p is invalid_duration", text => {
      expect(failure(() => parseInstant(text, ctx)).code).toBe("invalid_duration");
    });

    test.each([
      ["from + to", { from: "2026-10-11 09:00", to: "2026-10-11 17:00" }, ["2026-10-11T09:00", "2026-10-11T17:00"]],
      ["from + relative to", { from: "2026-10-11 09:00", to: "+8h" }, ["2026-10-11T09:00", "2026-10-11T17:00"]],
      ["date-only from + to is one local day", { from: "2026-10-10", to: "2026-10-11" }, ["2026-10-10T00:00", "2026-10-11T00:00"]],
      ["last", { last: "8h" }, [now - 8 * H, now]],
      ["last + to", { last: "2h", to: "2026-10-11 17:00" }, ["2026-10-11T15:00", "2026-10-11T17:00"]],
      ["from + last", { from: "2026-10-11 09:00", last: "1h30m" }, ["2026-10-11T09:00", "2026-10-11T10:30"]],
      ["from only runs to now", { from: "today" }, ["2026-10-11T00:00", now]],
      ["range 24h", { range: "24h" }, [now - D, now]],
      ["range 7d", { range: "7d" }, [now - 7 * D, now]],
      ["range 30d", { range: "30d" }, [now - 30 * D, now]],
      ["range 90d", { range: "90d" }, [now - 90 * D, now]],
      ["range all", { range: "all" }, [first, now]],
      ["range + to", { range: "24h", to: "2026-10-11 09:00" }, ["2026-10-10T09:00", "2026-10-11T09:00"]],
      ["nothing uses the default range", {}, [now - 30 * D, now]],
      ["range is ignored when from is given", { range: "7d", from: "-1h" }, [now - H, now]],
      ["range is ignored when last is given", { range: "90d", last: "1w" }, [now - 7 * D, now]],
    ] as const)("window: %s", (_name, input, [from, to]) => {
      const window = parseWindow({ ...input, tz }, { now, first });
      const instant = (value: string | number) => typeof value === "number" ? value : local(value, offset);
      expect([window.from, window.to]).toEqual([instant(from), instant(to)]);
      expect(window.tz).toBe(tz);
      expect(window.input).toEqual(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "range" || !("from" in input || "last" in input))));
    });

    test.each([
      ["to only", { to: "2026-10-11 17:00" }, "conflicting_params", "to"],
      ["from, to and last", { from: "-8h", to: "now", last: "8h" }, "conflicting_params", "last"],
      ["from after to", { from: "2026-10-11 17:00", to: "2026-10-11 09:00" }, "empty_window", "to"],
      ["from equal to to", { from: "2026-10-11 09:00", to: "2026-10-11T09:00" }, "empty_window", "to"],
      ["from in the future", { from: "now+1h" }, "empty_window", "from"],
      ["unknown range", { range: "1y" }, "invalid_duration", "range"],
      ["zero last", { last: "0m" }, "invalid_duration", "last"],
      ["negative last", { last: "-8h" }, "invalid_duration", "last"],
      ["bad from", { from: "soon" }, "invalid_time", "from"],
      ["bad to", { from: "-8h", to: "later" }, "invalid_time", "to"],
      ["+duration as from", { from: "+6h" }, "invalid_time", "from"],
      ["+duration as to without from", { last: "1h", to: "+6h" }, "invalid_time", "to"],
    ] as const)("window error: %s", (_name, input, code, param) => {
      expect(failure(() => parseWindow({ ...input, tz }, { now, first }))).toMatchObject({ code, param });
    });

    test("labels state the zone offset and show both dates when the window spans dates", () => {
      const sameDay = parseWindow({ from: "2026-10-11 09:00", to: "2026-10-11 17:00", tz }, { now, first });
      const gmt = offset === "+00:00" ? "GMT" : `GMT${offset[0]}${Number(offset.slice(1, 3))}`;
      expect(sameDay.label).toBe(`Sun 11 Oct 2026, 09:00–17:00 ${gmt}`);
      const overnight = parseWindow({ from: "2026-10-10 23:30", to: "+18h30m", tz }, { now, first });
      expect(overnight.label).toBe(`Sat 10 Oct 2026, 23:30 – Sun 11 Oct 2026, 18:00 ${gmt}`);
      expect(formatInZone(local("2026-10-11T09:00:30", offset), tz)).toBe(`Sun 11 Oct 2026, 09:00:30 ${gmt}`);
      expect(formatInZone(local("2026-10-11T09:00", offset), tz, "short")).toBe(`11 Oct 09:00 ${gmt}`);
      expect(isoInZone(local("2026-10-11T09:00", offset), tz)).toBe(`2026-10-11T09:00:00${offset}`);
    });

    test("zonedBucketStart returns local hour, midnight and Monday boundaries", () => {
      const ts = local("2026-10-11T09:47:13.5", offset);
      expect(zonedBucketStart(ts, "hour", tz)).toBe(local("2026-10-11T09:00", offset));
      expect(zonedBucketStart(ts, "day", tz)).toBe(local("2026-10-11T00:00", offset));
      expect(zonedBucketStart(ts, "week", tz)).toBe(local("2026-10-05T00:00", offset));
      expect(zonedBucketStart(local("2026-10-11T00:00", offset), "day", tz)).toBe(local("2026-10-11T00:00", offset));
      expect(nextBucketStart(local("2026-10-11T00:00", offset), "day", tz)).toBe(local("2026-10-12T00:00", offset));
      expect(nextBucketStart(local("2026-10-05T00:00", offset), "week", tz)).toBe(local("2026-10-12T00:00", offset));
    });

    test("phases are sorted, may touch, and accept +duration ends", () => {
      const window = parseWindow({ from: "2026-10-10 23:30", to: "2026-10-11 18:00", tz }, { now, first });
      const phases = parsePhases([
        "Demo=2026-10-11 15:00..2026-10-11 18:00",
        "Prep=2026-10-10 23:30..2026-10-11 09:00",
        "Build=2026-10-11 09:00..+6h",
      ], window);
      expect(phases).toEqual([
        { name: "Prep", from: local("2026-10-10T23:30", offset), to: local("2026-10-11T09:00", offset) },
        { name: "Build", from: local("2026-10-11T09:00", offset), to: local("2026-10-11T15:00", offset) },
        { name: "Demo", from: local("2026-10-11T15:00", offset), to: local("2026-10-11T18:00", offset) },
      ]);
    });

    test.each([
      ["overlap", ["A=2026-10-11 09:00..+2h", "B=2026-10-11 10:59..+1h"], "phase_overlap", "phase[1]"],
      ["outside the window", ["A=2026-10-11 09:00..+2h", "B=2026-10-11 17:00..+2h"], "phase_outside_window", "phase[1]"],
      ["starting before the window", ["A=2026-10-10 23:00..2026-10-11 01:00"], "phase_outside_window", "phase[0]"],
      ["duplicate names", ["A=2026-10-11 09:00..+1h", "A=2026-10-11 11:00..+1h"], "invalid_phase", "phase[1]"],
      ["no name", ["=2026-10-11 09:00..+1h"], "invalid_phase", "phase[0]"],
      ["a 41-character name", [`${"x".repeat(41)}=2026-10-11 09:00..+1h`], "invalid_phase", "phase[0]"],
      ["no range", ["A=2026-10-11 09:00"], "invalid_phase", "phase[0]"],
      ["no equals", ["2026-10-11 09:00..+1h"], "invalid_phase", "phase[0]"],
      ["ending before it starts", ["A=2026-10-11 10:00..2026-10-11 09:00"], "invalid_phase", "phase[0]"],
      ["+duration start", ["A=+1h..+2h"], "invalid_time", "phase[0]"],
      ["unreadable bound", ["A=2026-10-11 09:00..later"], "invalid_time", "phase[0]"],
    ] as const)("phase error: %s", (_name, specs, code, param) => {
      const window = parseWindow({ from: "2026-10-10 23:30", to: "2026-10-11 18:00", tz }, { now, first });
      expect(failure(() => parsePhases([...specs], window))).toMatchObject({ code, param });
    });
  });

  test("durations: w d h m s, repeated; zero and negative are errors", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("8h")).toBe(8 * H);
    expect(parseDuration("2d")).toBe(2 * D);
    expect(parseDuration("1w")).toBe(7 * D);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("1d2h3m4s")).toBe(D + 2 * H + 3 * 60_000 + 4000);
    expect(parseDuration("45S")).toBe(45_000);
    for (const text of ["0h", "0d0m", "-8h", "8", "h", "1.5h", "8 hours", ""]) {
      const error = failure(() => parseDuration(text));
      expect(error.code).toBe("invalid_duration");
      expect(error.message).toContain(`"${text}"`);
    }
  });

  test("daylight saving in America/New_York", () => {
    const tz = "America/New_York";
    const gap = failure(() => parseInstant("2026-03-08 02:30", { tz, now }));
    expect(gap.code).toBe("nonexistent_time");
    expect(gap.message).toContain("America/New_York");
    expect(failure(() => parseWindow({ from: "2026-03-08 02:30", to: "2026-03-08 04:00", tz }, { now, first }))).toMatchObject({ code: "nonexistent_time", param: "from" });
    // Fall-back 01:30 happens twice; the earlier (EDT) instant wins.
    expect(parseInstant("2026-11-01 01:30", { tz, now })).toBe(Date.parse("2026-11-01T01:30:00-04:00"));
    // A calendar day across the change is 23h or 25h; an hour count stays exact.
    const spring = parseWindow({ last: "1d", tz }, { now: Date.parse("2026-03-08T12:00:00-04:00"), first });
    expect(spring.to - spring.from).toBe(23 * H);
    const fall = parseWindow({ last: "1d", tz }, { now: Date.parse("2026-11-01T12:00:00-05:00"), first });
    expect(fall.to - fall.from).toBe(25 * H);
    expect(parseWindow({ last: "24h", tz }, { now: Date.parse("2026-11-01T12:00:00-05:00"), first }).from).toBe(Date.parse("2026-10-31T12:00:00-04:00") + H);
    const week = parseWindow({ from: "2026-03-02", last: "1w", tz }, { now, first });
    expect(week.to - week.from).toBe(7 * D - H);
    const day = parseWindow({ from: "2026-11-01", to: "2026-11-02", tz }, { now, first });
    expect(day.to - day.from).toBe(25 * H);
    expect(day.label).toBe("Sun 1 Nov 2026, 00:00 GMT-4 – Mon 2 Nov 2026, 00:00 GMT-5");
    expect(windowLabel(Date.parse("2026-11-01T00:00:00-04:00"), Date.parse("2026-11-01T03:00:00-05:00"), tz)).toBe("Sun 1 Nov 2026, 00:00 GMT-4 – 03:00 GMT-5");
    // Local buckets on change days: midnight-to-midnight is 23h/25h, the repeated hour is two buckets.
    expect(zonedBucketStart(Date.parse("2026-03-08T12:00:00-04:00"), "day", tz)).toBe(Date.parse("2026-03-08T00:00:00-05:00"));
    expect(nextBucketStart(Date.parse("2026-03-08T00:00:00-05:00"), "day", tz)).toBe(Date.parse("2026-03-09T00:00:00-04:00"));
    expect(nextBucketStart(Date.parse("2026-03-08T01:00:00-05:00"), "hour", tz)).toBe(Date.parse("2026-03-08T03:00:00-04:00"));
    expect(zonedBucketStart(Date.parse("2026-11-01T01:30:00-05:00"), "hour", tz)).toBe(Date.parse("2026-11-01T01:00:00-05:00"));
    expect(nextBucketStart(Date.parse("2026-11-01T01:00:00-04:00"), "hour", tz)).toBe(Date.parse("2026-11-01T01:00:00-05:00"));
    expect(nextBucketStart(Date.parse("2026-03-02T00:00:00-05:00"), "week", tz)).toBe(Date.parse("2026-03-09T00:00:00-04:00"));
  });

  test("buckets follow non-whole-hour zones and midnight gaps", () => {
    const ts = Date.parse("2026-10-11T04:10:00Z");
    expect(zonedBucketStart(ts, "hour", "Asia/Kolkata")).toBe(Date.parse("2026-10-11T09:00:00+05:30"));
    expect(zonedBucketStart(ts, "day", "Asia/Kathmandu")).toBe(Date.parse("2026-10-11T00:00:00+05:45"));
    // Santiago skips 00:00-01:00 on 2026-09-06; the day starts at 01:00 local.
    expect(parseInstant("2026-09-06", { tz: "America/Santiago", now })).toBe(Date.parse("2026-09-06T01:00:00-03:00"));
    expect(failure(() => parseInstant("2026-09-06 00:30", { tz: "America/Santiago", now })).code).toBe("nonexistent_time");
  });

  test("zones are validated and canonicalised; the default is the server zone", () => {
    expect(failure(() => parseWindow({ range: "7d", tz: "Mars/Olympus" }, { now, first }))).toMatchObject({ code: "invalid_zone", param: "tz" });
    expect(failure(() => parseInstant("now", { tz: "Nowhere", now })).code).toBe("invalid_zone");
    expect(parseWindow({ range: "7d", tz: "asia/singapore" }, { now, first }).tz).toBe("Asia/Singapore");
    const serverZone = process.env.YALD_TZ;
    process.env.YALD_TZ = "Asia/Singapore";
    try {
      expect(parseWindow({ range: "7d" }, { now, first }).tz).toBe("Asia/Singapore");
    } finally {
      if (serverZone === undefined) delete process.env.YALD_TZ; else process.env.YALD_TZ = serverZone;
    }
    expect(parseWindow({}, { now, first, defaultRange: "24h" }).from).toBe(now - D);
  });

  test("explicit blank window parameters never select a default", () => {
    for (const value of ["", " \t "]) {
      for (const [param, code] of [["from", "invalid_time"], ["to", "invalid_time"], ["last", "invalid_duration"], ["tz", "invalid_zone"], ["range", "invalid_duration"]] as const) {
        const error = failure(() => parseWindow({ [param]: value }, { now, first }));
        expect(error).toMatchObject({ code, param });
        expect(error.message).toContain(`"${value}"`);
      }
    }
    expect(failure(() => parseWindow({ from: "", last: "8h" }, { now, first }))).toMatchObject({ code: "invalid_time", param: "from" });
  });

  test("overflowing durations and shifted instants return structured errors", () => {
    for (const text of ["9".repeat(310) + "d", "1000000000000h", "1000000000000d", "1000000000000w", "2400000000h1s"]) {
      expect(failure(() => parseDuration(text))).toMatchObject({ code: "invalid_duration", param: "last" });
      expect(failure(() => parseWindow({ last: text, tz: "UTC" }, { now, first }))).toMatchObject({ code: "invalid_duration", param: "last" });
      expect(failure(() => parseInstant(`now+${text}`, { now, tz: "UTC" }))).toMatchObject({ code: "invalid_duration", param: "from" });
    }
    // A representable duration can still put its target outside the Date range.
    expect(parseDuration("100000000d")).toBe(8_640_000_000_000_000);
    for (const last of ["100000000d", "2400000000h"]) {
      expect(failure(() => parseWindow({ from: "now", last, tz: "UTC" }, { now, first }))).toMatchObject({ code: "invalid_duration", param: "last" });
      expect(failure(() => parseInstant(`+${last}`, { now, anchor: now, tz: "UTC" }))).toMatchObject({ code: "invalid_duration", param: "to" });
    }
    const window = parseWindow({ from: "today", to: "now", tz: "UTC" }, { now, first });
    expect(failure(() => parsePhases(["Overflow=today..+100000000d"], window))).toMatchObject({ code: "invalid_duration", param: "phase[0]" });
  });

  test("four-digit calendar years retain their year and Gregorian leap rules", () => {
    for (const text of ["0000-02-29T00:00Z", "0001-01-01T00:00Z", "0099-12-31T23:59Z", "0100-01-01T00:00Z", "2000-02-29T00:00Z"]) {
      expect(parseInstant(text, { now, tz: "UTC" })).toBe(Date.parse(text));
      expect(parseInstant(text.replace("Z", ""), { now, tz: "UTC" })).toBe(Date.parse(text));
    }
    for (const text of ["0001-02-29", "0100-02-29", "1900-02-29", "2026-04-31"]) {
      expect(failure(() => parseInstant(text, { now, tz: "UTC" })).code).toBe("invalid_time");
    }
    expect(parseInstant("+1d", { now, anchor: Date.parse("0099-12-31T12:00Z"), tz: "UTC" })).toBe(Date.parse("0100-01-01T12:00Z"));
  });

  test("hour buckets include the partial hours of Lord Howe's half-hour DST changes", () => {
    const tz = "Australia/Lord_Howe";
    for (const [text, start, next] of [
      ["2026-10-04T01:45:00+10:30", "2026-10-04T01:00:00+10:30", "2026-10-04T02:30:00+11:00"],
      ["2026-10-04T02:45:00+11:00", "2026-10-04T02:30:00+11:00", "2026-10-04T03:00:00+11:00"],
      ["2026-04-05T01:45:00+11:00", "2026-04-05T01:00:00+11:00", "2026-04-05T01:30:00+10:30"],
      ["2026-04-05T01:45:00+10:30", "2026-04-05T01:30:00+10:30", "2026-04-05T02:00:00+10:30"],
    ]) {
      expect(zonedBucketStart(Date.parse(text!), "hour", tz)).toBe(Date.parse(start!));
      expect(nextBucketStart(Date.parse(start!), "hour", tz)).toBe(Date.parse(next!));
      expect(zonedBucketStart(Date.parse(next!) - 1, "hour", tz)).toBe(Date.parse(start!));
    }
  });

  test("calendar buckets progress across skipped and repeated date-line days", () => {
    const skipped = Date.parse("2011-12-29T00:00:00-10:00");
    expect(nextBucketStart(skipped, "day", "Pacific/Apia")).toBe(Date.parse("2011-12-31T00:00:00+14:00"));
    const repeated = Date.parse("1969-09-30T00:00:00+11:00");
    expect(nextBucketStart(repeated, "day", "Pacific/Kwajalein")).toBe(Date.parse("1969-10-01T00:00:00-12:00"));
    const monday = Date.parse("1969-09-29T00:00:00+11:00");
    expect(nextBucketStart(monday, "week", "Pacific/Kwajalein")).toBe(Date.parse("1969-10-06T00:00:00-12:00"));
  });

  test("bucket and phase helpers reject invalid zones with WindowError", () => {
    for (const run of [
      () => zonedBucketStart(now, "hour", "Nowhere"),
      () => nextBucketStart(now, "day", "Nowhere"),
      () => parsePhases(["A=-1h..now"], { from: now - D, to: now, tz: "Nowhere", label: "", input: {} }),
    ]) {
      expect(failure(run)).toMatchObject({ code: "invalid_zone", param: "tz" });
    }
  });

  test("range=all with no data before now is an empty window, not an error", () => {
    const window: TimeWindow = parseWindow({ range: "all", tz: "UTC" }, { now, first: now });
    expect([window.from, window.to]).toEqual([now, now]);
  });

  test("error messages quote the input and say what would have worked", () => {
    expect(failure(() => parseInstant("11/10 9am", { tz: "UTC", now })).message)
      .toBe('Could not read "11/10 9am" as a time. Use 2026-10-11 09:00, an ISO time with an offset, or a relative time like -8h.');
    expect(failure(() => parseInstant("2026-10-11T09:00:00 08:00", { tz: "UTC", now })).message)
      .toBe('Could not read "2026-10-11T09:00:00 08:00" as a time. If it has a +HH:MM offset, URL-encode the + as %2B.');
  });
});

function isoWall(ts: number, offset: string): string {
  const shifted = new Date(ts + (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * H + Number(offset.slice(4)) * 60_000));
  return shifted.toISOString().slice(0, 16);
}
