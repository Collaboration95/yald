# Architecture

```text
opencodex JSONL and quota cache ----------> server/src/ocx/store.ts -> server/src/analytics.ts
Claude Code transcripts -> claude/transcripts.ts -^
                                             -> server/src/api.ts -> React views
```

The store parses `usage.jsonl`, `spend-ledger.jsonl`, and `codex-quota-cache.json`; pricing is delegated to opencodex's cost engine when available. `routing-history.sqlite` is currently unused because the JSONL ledger is the freshest supported source and avoids depending on an upstream SQLite schema. Analytics functions filter and aggregate normalized rows, Hono exposes those results, and the React client renders charts and tables.

Claude Code subscription traffic never passes through opencodex, so `server/src/claude/transcripts.ts` reads `~/.claude/projects/**/*.jsonl` (`CLAUDE_PROJECTS_DIR`), maps each assistant response onto the `usage.jsonl` entry shape, and feeds it through the same `normalizeRow` and pricing engine; those rows carry `provider: "anthropic"` and `protocol: "claude-code"`. Anthropic's `input_tokens` excludes cache reads and writes, so the adapter adds them back to match ocx's cache-inclusive `inputTokens`. Claude Code repeats usage on every content-block line and resumed sessions copy history into new files, so entries are deduped by `requestId`. Transcripts carry no latency, TTFT, effort, quota, or retry data. Each transcript's parse is cached by size and mtime, so only new or appended sessions are re-read.

On each API read, the store checks the three input files' byte size and modification time. A changed signature triggers a full parse, normalization, and pricing pass; otherwise the in-memory dataset is reused. This catches appends, truncation, and file replacement while keeping unchanged reads cheap. API ETags combine that dataset revision with the query URL, so idle polls can return `304 Not Modified` without recomputing aggregates. Browser data queries refresh every 30 seconds only while the document is visible. A manual Refresh requests a forced rebuild.

The web app is built to `web/dist` and served by the same Bun/Hono process as the API. The npm CLI launches that process with its packaged Bun runtime and ships the prebuilt web assets, so users do not need a source checkout or runtime build.
