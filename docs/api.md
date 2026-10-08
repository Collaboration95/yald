# API reference

All endpoints return JSON except `/api/export`. Responses include an ETag derived from the dataset revision and full request URL. Analytics queries without an explicit `to` also include the current request time, so rolling windows continue advancing when source files are unchanged. Queries with a fixed `to`, metadata, health, and conversation detail can return `304 Not Modified` for an unchanged query and dataset. Each response uses one dataset snapshot and one time for its window boundaries. Analytics endpoints rebuild the dataset if a ledger file's size or modification time changed. The browser polls visible views every 30 seconds; hidden tabs pause polling. Refresh forces a dataset rebuild. Query parameters are URL encoded.

Shared analytics parameters: `range` (`24h`, `7d`, `30d`, `90d`, `all`), `from` and `to` (Unix milliseconds), comma-separated `providers`, `models`, `efforts`, and `statuses` (`ok`, `error`, `cancelled`), `search`, `groupBy` (`model`, `provider`, `effort`, `route`, `outcome`, `account`, `serviceTier`, `none`), `metric` (`tokens`, `cost`, `requests`, `outputTokens`, `inputTokens`, `cacheReadTokens`, `reasoningTokens`), and `bucket` (`hour`, `day`, `week`, or omitted/`auto` for automatic selection). `from`/`to` override the corresponding range boundary.

| Route | Additional query parameters | Response |
| --- | --- | --- |
| `GET /api/health` | — | `ok`, dataset `revision`, row count, parse timing, malformed-line count, pricing status |
| `GET /api/meta` | — | Paths, file stats, parse info, totals, providers/models/efforts, quota and ledger summaries |
| `GET /api/overview` | Shared parameters | Window, summary, prior-period comparison, deltas, sparkline, series, compositions, leaders, heatmap, context, quota, recent rows |
| `GET /api/timeseries` | Shared; `limit` | Window and grouped series |
| `GET /api/models` | Shared | Model/provider/effort breakdowns, scatter points, effort matrix |
| `GET /api/usage` | Shared | Summary, token composition, cache timeline, series, heatmap, context, breakdowns |
| `GET /api/cost` | Shared | Summary, cost composition, cost series/cumulative totals, cache savings, breakdowns |
| `GET /api/performance` | Shared | Latency timeline, histograms, percentiles, model breakdown, TTFT/output points, slowest rows |
| `GET /api/reliability` | Shared | Outcome report, recent failures, waste, metering, retry overhead |
| `GET /api/quota` | `range`, `from`, `to` | `quotaView`: current windows, selected-range burn estimates, coverage, and projections |
| `GET /api/ledger` | `range`, `from`, `to` | Spend-ledger counts and selected-range buckets, send/token totals |
| `GET /api/conversations` | Shared; `limit`, `sort` (`tokens`, `cost`, `requests`, `recent`, `errors`) | Ranked conversations and aggregate totals |
| `GET /api/conversations/:id` | — | Conversation summary, timeline, models, and requests; 404 when missing |
| `GET /api/export` | Shared; `dataset` (`requests`, `models`, `conversations`) | CSV attachment for the filtered rows |
| `GET /api/filters` | Shared | Available providers, models, efforts, and route kinds for the selected time/search filter |

`GET /api/dataset/refresh` is an operational endpoint used by local tooling. It rebuilds immediately and returns `{ok, rows, parseMs, builtAt}`. The application server serves the built web app at `/` and its client routes.
