/**
 * The one place yald reads times. Turns what a person types ("2026-10-11 09:00",
 * "-8h", "yesterday+18h30m", "last 2d") into an exact half-open window in an IANA
 * zone. Pure: zone offsets come from Intl.DateTimeFormat, never from the process
 * timezone, so results are identical whatever TZ the server runs under.
 */

export type Instant = number;

export interface TimeWindow {
  from: Instant;                 // inclusive
  to: Instant;                   // exclusive
  tz: string;                    // IANA zone
  label: string;                 // "Sun 11 Oct 2026, 09:00–17:00 GMT+8"
  input: { from?: string; to?: string; last?: string; range?: string };
}

export interface Phase { name: string; from: Instant; to: Instant }

export type WindowErrorCode =
  | "invalid_time" | "nonexistent_time" | "invalid_duration" | "invalid_zone"
  | "empty_window" | "conflicting_params" | "invalid_phase" | "phase_outside_window" | "phase_overlap";

/** Every parse failure: `param` names the input it came from (`from`, `to`, `last`, `tz`, `range`, `phase[2]`). */
export class WindowError extends Error {
  code: WindowErrorCode;
  param: string;
  constructor(code: WindowErrorCode, param: string, message: string) {
    super(message);
    this.name = "WindowError";
    this.code = code;
    this.param = param;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS: Record<string, number> = { h: HOUR, m: MINUTE, s: SECOND };
const PRESETS: Record<string, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const EPOCH_MS = /^\d{12,13}$/;
const CALENDAR = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const ANCHORED = /^(now|today|yesterday)(?:\s*([+-])\s*(.+))?$/i;
const OFFSET_ONLY = /^([+-])\s*(.+)$/;
// An unencoded `+` in a query string decodes to a space: "…T09:00:00+08:00" arrives as "…T09:00:00 08:00".
const DECODED_PLUS_OFFSET = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)? \d{2}:?\d{2}$/;

interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Calendar days apply as wall-clock days in the zone (23h or 25h across DST); h/m/s are exact. */
interface Duration { days: number; ms: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let cached = formatters.get(tz);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, cached);
  }
  return cached;
}

function wallAt(ts: Instant, tz: string): Wall & { weekday: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(ts)) parts[part.type] = part.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

function wallAsUtc(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function millis(ts: Instant): number {
  return ((ts % SECOND) + SECOND) % SECOND;
}

/** Zone offset (local minus UTC) in force at `ts`. */
function offsetAt(ts: Instant, tz: string): number {
  return wallAsUtc(wallAt(ts, tz)) - (ts - millis(ts));
}

/**
 * The instant a wall-clock time names in `tz`. An ambiguous (fall-back) time is the
 * earlier instant. A time inside a spring-forward gap returns null, or with `gap:
 * "shift"` is read with the offset before the gap, which lands just after it.
 */
function resolveWall(wall: Wall, ms: number, tz: string, gap: "reject" | "shift" = "reject"): Instant | null {
  const guess = wallAsUtc(wall);
  const offsets = new Set([offsetAt(guess - DAY, tz), offsetAt(guess, tz), offsetAt(guess + DAY, tz)]);
  const valid = [...offsets].map(offset => guess - offset).filter(ts => offsetAt(ts, tz) === guess - ts).sort((a, b) => a - b);
  if (valid.length) return valid[0]! + ms;
  return gap === "shift" ? guess - offsetAt(guess - DAY, tz) + ms : null;
}

function addDays(wall: Wall, days: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function midnight(wall: Wall, tz: string): Instant {
  return resolveWall({ ...wall, hour: 0, minute: 0, second: 0 }, 0, tz, "shift")!;
}

function shift(ts: Instant, duration: Duration, sign: 1 | -1, tz: string): Instant {
  let shifted = ts;
  if (duration.days) shifted = resolveWall(addDays(wallAt(ts, tz), sign * duration.days), millis(ts), tz, "shift")!;
  return shifted + sign * duration.ms;
}

function zone(tz: string): string {
  try {
    return formatter(tz).resolvedOptions().timeZone;
  } catch {
    throw new WindowError("invalid_zone", "tz", `Unknown time zone "${tz}". Use an IANA zone like Asia/Singapore, America/New_York or UTC.`);
  }
}

function readDuration(text: string, param: string): Duration {
  const compact = text.trim().toLowerCase();
  if (!/^(\d+[wdhms])+$/.test(compact)) {
    throw new WindowError("invalid_duration", param, `Could not read "${text}" as a duration. Use whole numbers with units w, d, h, m or s, like 90m, 8h, 2d or 1h30m.`);
  }
  const duration: Duration = { days: 0, ms: 0 };
  for (const [, amount, unit] of compact.matchAll(/(\d+)([wdhms])/g)) {
    if (unit === "w") duration.days += 7 * Number(amount);
    else if (unit === "d") duration.days += Number(amount);
    else duration.ms += Number(amount) * UNIT_MS[unit!]!;
  }
  if (duration.days === 0 && duration.ms === 0) {
    throw new WindowError("invalid_duration", param, `"${text}" is an empty duration. Use a length greater than zero, like 8h.`);
  }
  return duration;
}

/** Nominal length in milliseconds (`d` = 24h, `w` = 7d). Windows apply days on the zone's calendar instead. */
export function parseDuration(text: string): number {
  const duration = readDuration(text, "last");
  return duration.days * DAY + duration.ms;
}

function invalidTime(text: string, param: string): WindowError {
  const hint = DECODED_PLUS_OFFSET.test(text.trim())
    ? "If it has a +HH:MM offset, URL-encode the + as %2B."
    : "Use 2026-10-11 09:00, an ISO time with an offset, or a relative time like -8h.";
  return new WindowError("invalid_time", param, `Could not read "${text}" as a time. ${hint}`);
}

function readCalendar(match: RegExpExecArray, text: string, tz: string, param: string): Instant {
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const wall: Wall = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour ?? 0), minute: Number(minute ?? 0), second: Number(second ?? 0) };
  const daysInMonth = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate();
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > daysInMonth || wall.hour > 23 || wall.minute > 59 || wall.second > 59) {
    throw invalidTime(text, param);
  }
  const ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
  if (offset) {
    if (offset.toUpperCase() === "Z") return wallAsUtc(wall) + ms;
    const digits = offset.slice(1).replace(":", "");
    const [hours, minutes] = [Number(digits.slice(0, 2)), Number(digits.slice(2) || 0)];
    if (hours > 23 || minutes > 59) throw invalidTime(text, param);
    return wallAsUtc(wall) - (offset[0] === "-" ? -1 : 1) * (hours * HOUR + minutes * MINUTE) + ms;
  }
  // A bare date means the start of that local day, even when midnight itself is skipped.
  const resolved = resolveWall(wall, ms, tz, hour === undefined ? "shift" : "reject");
  if (resolved === null) {
    throw new WindowError("nonexistent_time", param, `"${text}" does not exist in ${tz}: the clocks skip it when daylight saving starts. Use a time before or after the gap.`);
  }
  return resolved;
}

function readInstant(text: string, ctx: { tz: string; now: Instant; anchor?: Instant }, param: string): Instant {
  const trimmed = text.trim();
  if (EPOCH_MS.test(trimmed)) return Number(trimmed);
  const calendar = CALENDAR.exec(trimmed);
  if (calendar) return readCalendar(calendar, text, ctx.tz, param);

  const anchored = ANCHORED.exec(trimmed);
  if (anchored) {
    const [, word, sign, duration] = anchored;
    const keyword = word!.toLowerCase();
    let base = ctx.now;
    if (keyword !== "now") base = midnight(addDays(wallAt(ctx.now, ctx.tz), keyword === "yesterday" ? -1 : 0), ctx.tz);
    return sign ? shift(base, readDuration(duration!, param), sign === "-" ? -1 : 1, ctx.tz) : base;
  }

  const relative = OFFSET_ONLY.exec(trimmed);
  if (relative) {
    const [, sign, duration] = relative;
    if (sign === "-") return shift(ctx.now, readDuration(duration!, param), -1, ctx.tz);
    if (ctx.anchor === undefined) {
      throw new WindowError("invalid_time", param, `"${text}" counts from the start, so it only works as an end time. Use now${trimmed} or an exact time here.`);
    }
    return shift(ctx.anchor, readDuration(duration!, param), 1, ctx.tz);
  }
  throw invalidTime(text, param);
}

/** One instant. `anchor` is the start an end-only `+duration` counts from. */
export function parseInstant(text: string, ctx: { tz: string; now: Instant; anchor?: Instant }): Instant {
  return readInstant(text, { ...ctx, tz: zone(ctx.tz) }, ctx.anchor === undefined ? "from" : "to");
}

/**
 * TIME_ZONE in env.ts, read at call time. Importing env.ts here would freeze OCX_HOME
 * and friends for anything that imports analytics, before tests can point them elsewhere.
 */
function serverZone(): string {
  return process.env.YALD_TZ ?? process.env.OCX_OBSERVATORY_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Resolves a half-open window. `from`+`to`, `last` (optionally ending at `to`),
 * `from`+`last` and `from` alone (to now) are exact; otherwise a `range` preset
 * (default `ctx.defaultRange`, then 30d) ends at `to` or now. `ctx.first` is the
 * earliest data point, the start of `range=all`. `tz` defaults to the server zone
 * (YALD_TZ, then OCX_OBSERVATORY_TZ, then the system zone).
 */
export function parseWindow(
  input: { from?: string; to?: string; last?: string; range?: string; tz?: string },
  ctx: { now: Instant; first: Instant; defaultRange?: string },
): TimeWindow {
  const tz = zone(present(input.tz) ?? serverZone());
  const from = present(input.from);
  const to = present(input.to);
  const last = present(input.last);
  const range = present(input.range);
  const echo: TimeWindow["input"] = {};
  if (from !== undefined) echo.from = from;
  if (to !== undefined) echo.to = to;
  if (last !== undefined) echo.last = last;

  let start: Instant;
  let end: Instant;
  if (from !== undefined && to !== undefined && last !== undefined) {
    throw new WindowError("conflicting_params", "last", "from, to and last together over-specify the window. Give any two of them.");
  } else if (from !== undefined) {
    start = readInstant(from, { tz, now: ctx.now }, "from");
    if (to !== undefined) end = readInstant(to, { tz, now: ctx.now, anchor: start }, "to");
    else if (last !== undefined) end = shift(start, readDuration(last, "last"), 1, tz);
    else end = ctx.now;
  } else if (last !== undefined) {
    const duration = readDuration(last, "last");
    end = to === undefined ? ctx.now : readInstant(to, { tz, now: ctx.now }, "to");
    start = shift(end, duration, -1, tz);
  } else {
    // Read `to` first so an unreadable value is reported as such, not as a missing start.
    end = to === undefined ? ctx.now : readInstant(to, { tz, now: ctx.now }, "to");
    if (to !== undefined && range === undefined) {
      throw new WindowError("conflicting_params", "to", `"to" on its own does not say where the window starts. Add from, last or range.`);
    }
    const preset = range ?? ctx.defaultRange ?? "30d";
    if (preset !== "all" && PRESETS[preset] === undefined) {
      throw new WindowError("invalid_duration", "range", `Unknown range "${preset}". Use 24h, 7d, 30d, 90d or all, or from/to/last for any other window.`);
    }
    if (range !== undefined) echo.range = range;
    // Presets are exact spans (7d is always 168h) and may be empty, e.g. `all` before any data.
    start = preset === "all" ? Math.min(ctx.first, end) : end - PRESETS[preset]!;
    return { from: start, to: end, tz, label: windowLabel(start, end, tz), input: echo };
  }
  if (start >= end) {
    throw new WindowError("empty_window", to !== undefined ? "to" : "from", `The window ${formatInZone(start, tz)} to ${formatInZone(end, tz)} is empty: it must end after it starts.`);
  }
  return { from: start, to: end, tz, label: windowLabel(start, end, tz), input: echo };
}

/**
 * `name=start..end` specs, sorted by start. `end` may be `+duration` from `start`.
 * Relative bounds (`now`, `today`, `-2h`) are read against the window's end.
 * Phases must lie inside the window and may touch but not overlap.
 */
export function parsePhases(specs: string[], window: TimeWindow): Phase[] {
  const phases: (Phase & { param: string })[] = [];
  specs.forEach((spec, index) => {
    const param = `phase[${index}]`;
    const equals = spec.indexOf("=");
    const separator = spec.indexOf("..", equals + 1);
    if (equals < 0 || separator < 0) {
      throw new WindowError("invalid_phase", param, `Could not read phase "${spec}". Use name=start..end, like Build=2026-10-11 09:00..+6h.`);
    }
    const name = spec.slice(0, equals).trim();
    if (name.length < 1 || name.length > 40) {
      throw new WindowError("invalid_phase", param, `Phase name "${name}" must be 1 to 40 characters.`);
    }
    if (phases.some(phase => phase.name === name)) {
      throw new WindowError("invalid_phase", param, `Phase name "${name}" is used twice. Give each phase its own name.`);
    }
    const ctx = { tz: window.tz, now: window.to };
    const from = readInstant(spec.slice(equals + 1, separator), ctx, param);
    const to = readInstant(spec.slice(separator + 2), { ...ctx, anchor: from }, param);
    if (from >= to) {
      throw new WindowError("invalid_phase", param, `Phase "${name}" must end after it starts (${formatInZone(from, window.tz)} to ${formatInZone(to, window.tz)}).`);
    }
    if (from < window.from || to > window.to) {
      throw new WindowError("phase_outside_window", param, `Phase "${name}" (${windowLabel(from, to, window.tz)}) is not inside the window ${window.label}.`);
    }
    phases.push({ name, from, to, param });
  });
  phases.sort((a, b) => a.from - b.from);
  for (let i = 1; i < phases.length; i++) {
    const [before, after] = [phases[i - 1]!, phases[i]!];
    if (after.from < before.to) {
      throw new WindowError("phase_overlap", after.param, `Phases "${before.name}" and "${after.name}" overlap. Phases may touch (one ends when the next starts) but not overlap.`);
    }
  }
  return phases.map(({ name, from, to }) => ({ name, from, to }));
}

/** Start of the local hour, day or Monday-based week containing `ts` in `tz`. */
export function zonedBucketStart(ts: Instant, bucket: "hour" | "day" | "week", tz: string): Instant {
  const wall = wallAt(ts, tz);
  if (bucket === "hour") return ts - (wall.minute * MINUTE + wall.second * SECOND + millis(ts));
  return midnight(addDays(wall, bucket === "week" ? -wall.weekday : 0), tz);
}

/** The bucket after the one starting at `start`; local days and weeks may be 23h or 25h long. */
export function nextBucketStart(start: Instant, bucket: "hour" | "day" | "week", tz: string): Instant {
  const step = bucket === "hour" ? HOUR : bucket === "day" ? DAY : 7 * DAY;
  return zonedBucketStart(start + step * 1.5, bucket, tz);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function gmt(offset: number): string {
  if (offset === 0) return "GMT";
  const minutes = Math.abs(offset) / MINUTE;
  return `GMT${offset < 0 ? "-" : "+"}${Math.floor(minutes / 60)}${minutes % 60 ? `:${pad(minutes % 60)}` : ""}`;
}

function clock(wall: Wall): string {
  return `${pad(wall.hour)}:${pad(wall.minute)}${wall.second ? `:${pad(wall.second)}` : ""}`;
}

function date(wall: Wall & { weekday: number }): string {
  return `${WEEKDAYS[wall.weekday]} ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}`;
}

/** "Sun 11 Oct 2026, 09:00 GMT+8" (long) or "11 Oct 09:00 GMT+8" (short). Always states the offset. */
export function formatInZone(ts: Instant, tz: string, style: "short" | "long" = "long"): string {
  const wall = wallAt(ts, zone(tz));
  const offset = gmt(offsetAt(ts, tz));
  if (style === "short") return `${wall.day} ${MONTHS[wall.month - 1]} ${clock(wall)} ${offset}`;
  return `${date(wall)}, ${clock(wall)} ${offset}`;
}

/** "Sun 11 Oct 2026, 09:00–17:00 GMT+8"; both dates when the window spans dates, both offsets across a DST change. */
export function windowLabel(from: Instant, to: Instant, tz: string): string {
  const [start, end] = [wallAt(from, tz), wallAt(to, tz)];
  const [startOffset, endOffset] = [offsetAt(from, tz), offsetAt(to, tz)];
  const sameDate = start.year === end.year && start.month === end.month && start.day === end.day;
  if (startOffset !== endOffset) {
    return sameDate
      ? `${date(start)}, ${clock(start)} ${gmt(startOffset)} – ${clock(end)} ${gmt(endOffset)}`
      : `${formatInZone(from, tz)} – ${formatInZone(to, tz)}`;
  }
  return sameDate
    ? `${date(start)}, ${clock(start)}–${clock(end)} ${gmt(startOffset)}`
    : `${date(start)}, ${clock(start)} – ${date(end)}, ${clock(end)} ${gmt(startOffset)}`;
}

/** ISO-8601 with the zone's offset, e.g. "2026-10-11T09:00:00+08:00". */
export function isoInZone(ts: Instant, tz: string): string {
  const wall = wallAt(ts, tz);
  const offset = offsetAt(ts, tz);
  const minutes = Math.abs(offset) / MINUTE;
  const fraction = millis(ts) ? `.${pad(millis(ts), 3)}` : "";
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${fraction}`
    + `${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
