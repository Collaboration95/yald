# Relay production adoption

Relay is the production UI at the normal root routes. Bench, alternate design palettes, the comparison switcher, and the one-off design-lab entry/build are removed. The production API and data types are unchanged. The interface is designed for desktop; mobile/iPad/device-specific requirements are excluded.

The existing eight page modules and conversation detail provide every original widget, table, action, and data value. A shared Relay provider applies chart presentation without changing plotted values or formatter callbacks. Model colors remain consistent across charts, legends, and table tags. The normal production theme preference, legacy migration, and OS fallback remain.

Small correctness improvements accompany adoption: donut center graphics render; detail donut/HTML legends agree; Overview's supported metric/group and Cost's supported group use the same effective value for the query and selection; conversation links preserve filters for the back navigation. Detail still queries the full session independently of global filters.

## Verification

- GPT-6.1 Sol agents audited the original committed source and added chart contract tests. [Content audit](../relay-content-audit.md) records row caps, null/unpriced/sparse behavior, quota boundaries, and full-session semantics.
- Fresh production browser observations cover all eight tabs and valid detail at the same frozen synthetic window. [production-parity.json](production-parity.json) matches [reference-parity.json](reference-parity.json): **32 ECharts, 40 metric cards, 58 sections, and 14 default tables**. Usage date selection supplies the fifteenth table site. Body text and stat hints match after trimming outer whitespace and normalizing only browser-clock `… ago` ages. Sections, table headers, and row counts match exactly. Every observed desktop page has no page-wide overflow.
- Updated images in `docs/screenshots` show the production build, including a 49-row detail page. These use synthetic data only.
- Exercised the Usage Input/Account → Overview transition, supported Tokens/Model defaults, direct Cost reload, heatmap keyboard selection/date details/clear, and both themes. The selected Wednesday 00:00 detail is 2026-09-30, 22.4k tokens, one request, Asia/Singapore; [screenshot](heatmap-detail.png).
- Client/server typechecks, lint, production build, synthetic smoke, and local real-ledger smoke pass. Both smoke sources render all nine pages with no invalid-value markers; no private ledger contents are saved or published.
- **39 tests pass, 906 assertions**: real option builders in both themes preserve values, null/zero buckets, coordinates, scatter sizes, callback precision/identity, source immutability, threshold opacity, model identity, and outcome legend mapping; existing analytics/API/DST tests pass.

The original row caps remain: 25 recent requests, capped model/group rankings, 200 ranked conversations, and 150 request rows in detail with every timeline point retained. Saved evidence covers the canonical synthetic fixture and the exercised transitions; it does not assert exhaustive accessibility or every possible dataset size/combination.

## Reproduce

```sh
scripts/bun run preview:fixture
# http://127.0.0.1:5329
scripts/bun run smoke --fixtures
scripts/bun test
```

The preview starts the actual production server/build with a temporary synthetic `OCX_HOME`, frozen API clock (2026-10-02 10:00 UTC), and Asia/Singapore bucketing. `YALD_PREVIEW_PORT` overrides the port. Ctrl+C removes its temporary fixture. Browser-relative labels use the current browser clock.

Performance implementation and new speed claims belong to the separate stacked PR; [optimization-backlog.md](../optimization-backlog.md) retains the deferred measurement requirements.
