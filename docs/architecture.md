# Architecture

```text
opencodex JSONL and quota cache -> server/src/ocx/store.ts -> server/src/analytics.ts
                                             -> server/src/api.ts -> React views
```

The store parses `usage.jsonl`, `spend-ledger.jsonl`, and `codex-quota-cache.json`; pricing is delegated to opencodex's cost engine when available. `routing-history.sqlite` is currently unused because the JSONL ledger is the freshest supported source and avoids depending on an upstream SQLite schema. Analytics functions filter and aggregate normalized rows, Hono exposes those results, and the React client renders charts and tables.

On each API read, the store checks device, inode, byte size, and nanosecond modification/change times for all three files.
An unchanged signature reuses the composed dataset. On a change, automatic rebuilds replace only changed components.
Unchanged usage rows are reused only when the loaded pricing engine matches the inspected source fingerprint and its
overlay/provider/account registry generation is unchanged. Unknown or newer engines still price normally and reparse
usage on component rebuilds. Changed usage and manual Refresh always reread, normalize, price, and sort the complete file.

Before/after metadata and pricing-generation checks guard publication. A moving source retries the whole composition
up to three times; failed attempts preserve the previous dataset and component snapshots. Concurrent callers coalesce
into one build, including an explicit force request joining an active automatic build. This is process-local caching,
not a transaction across independently written files. The inspected catalog and identity tables are loaded ESM modules;
upgrading those files requires a process restart. Source audits must be renewed to enable reuse with a new pricing revision.

API ETags combine the composed dataset's file revision with the query URL, so quota/spend changes invalidate conditional
requests and idle polls return `304 Not Modified` without route aggregation. The existing file-driven fast path means
pricing-only registry changes require force. An unchanged-file force rebuild retains its revision and therefore its ETag;
that pre-existing limitation is tested and remains outside this change. Browser queries poll every 30 seconds only while
the document is visible. A manual Refresh forces the store rebuild and then invalidates active client queries.

The [refresh experiment](benchmarks/relay-refresh/README.md) compares this implementation with the frozen Relay UI commit,
using actual production HTTP routes, an isolated synthetic ledger, and identical web assets.

The web app is built to `web/dist` and served by the same Bun/Hono process as the API. The npm CLI launches that process with its packaged Bun runtime and ships the prebuilt web assets, so users do not need a source checkout or runtime build.
