// Which reader a request came from (#31, "Shared definitions → Source"). Keyed on
// the protocol the row was read with, never on `provider`: Anthropic traffic routed
// through opencodex is `ocx`, not `claude-code`.
import type { RequestRow } from "../ocx/store";
import type { Source } from "./types";

/** Both sources, in the order every report lists them. */
export const ALL_SOURCES: readonly Source[] = ["claude-code", "ocx"];

/** `"claude-code"` for rows read from Claude Code transcripts, otherwise `"ocx"`. */
export function sourceOf(row: Pick<RequestRow, "protocol">): Source {
  return row.protocol === "claude-code" ? "claude-code" : "ocx";
}

const ALIASES: Record<string, Source> = { "claude-code": "claude-code", claude: "claude-code", ocx: "ocx", codex: "ocx" };

/** A source name or CLI alias (`claude`, `codex`), case-insensitive; null when unknown. */
export function parseSource(name: string): Source | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}
