# Labs case evidence

Enable Labs, open Project Radar, Cache Detective or Context Replay, and select a
finding's request evidence. The case shows its observations, fixed bounds,
source-qualified selection, eligible sample and limitations above the request list.
Expand Complete fixed cohort and coverage to inspect every cohort dimension.
Artwork can be hidden without losing any explanation.

The case URL carries its complete selection. Opening it directly, refreshing,
reloading or changing/resetting the global toolbar keeps that fixed case. Toolbar
filters describe your next investigation. In Radar, Current requests and Prior
requests choose between the two original windows while retaining the full
comparison. Both windows remain visible; inspecting prior requests does not
create an earlier baseline.

Cache evidence lists the exact cache-accounting eligible population used for
fixed-workload read discount, write premium and net. Original request totals and
exclusions are separately disclosed. The eligible priced subtotal equals the
case's actual fixed-workload price; both use the accepted server aggregation,
rounded once to six decimal USD places with ties away from zero. The original
priced subtotal independently includes priced comparison exclusions and follows
the same rounding rule. Individual request costs remain unrounded; displayed
request prices need not sum to the full subtotal. These are API equivalents,
not subscription bills or realized savings. Eligible zero is valid;
unavailable accounting has no monetary comparison. Context evidence retains all
selected requests, including missing input and attempt sums. These are gaps for
context comparisons; observed input zero is valid. Cache is within input and
reasoning is within output. No transcripts or request/response bodies are shown.

The bounded list is ordered by timestamp, source, request ID and original order.
Each expandable request shows source, session or unnamed identity, request ID,
millisecond timestamp and ordinals. The page controls and request details support
keyboard operation with visible focus in both themes. Totals always describe the
whole selected population. Empty, short or unavailable observations stay plain
and inspectable; they do not infer compaction, productivity, quality or cache causes.

An invalid link displays an explanation. Open the finding again to recover the
complete selector. A failed request offers Try again. With Labs disabled, no
enabled investigation or evidence query mounts or polls.

For the typed selector, validation bounds, response, pagination and ETag semantics,
see the [API contract](api.md#get-apilabsevidence--fixed-case-evidence). The shared
browser/API validator is `server/src/labs/evidence-intent.ts`; the accepted
`filterRows`, project identity, source, cache and context predicates are reused.
The case uses the existing builders for server-owned metrics and history limits.
It adds no LLM call, collector, report schema or client-side pricing/median logic.

## Synthetic verification

`make smoke` runs the isolated evidence API/render harness in its own process,
alongside all existing dashboard and three-view smoke fixtures. Unit/API tests
exercise exact finding populations, exclusions, duplicates, boundaries, literal
commas/globs, presence semantics, pagination, conditional validation and git-root
mutation. Every synthetic home is configured before importing the real server.

To inspect the production build in a native T3 tab:

```sh
make build
YALD_PREVIEW_PORT=5518 scripts/bun run scripts/preview-evidence.ts
```

The listener binds loopback only and prints its fixed Radar URL. Use the same
window with `search=l08-` for Cache Detective, or `search=l07-&efforts=high` for
Context Replay. Follow actual finding links, reload and change/reset the toolbar;
the authoritative selector, paired prior selector and period must remain exact.
`web/scripts/evidence-browser-check.js` can be evaluated in the owned native tab
to compare the rendered case and every page identity with the real API. The
fixture-only `/__l08/control?failure=on|off&delay=0..5000` controls error/loading
states; `/__l08/requests` records only synthetic investigation requests. Shutdown
stops only that listener and removes its synthetic homes/pricing.
