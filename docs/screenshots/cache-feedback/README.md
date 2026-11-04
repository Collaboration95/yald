# Cache comparison: local synthetic evidence

Post-v0.5.0 change, based on published source `2ca59e1d3c7892f16b3102428c1e0e9feb819975`. Recorded on macOS with Bun 1.4.2 and headless Chrome, 4 November 2026. No release version has been assigned to this change.

Run `make build`, then `scripts/bun run scripts/cache-feedback-evidence.ts [output-dir]` to reproduce the complete screenshot set and `checks.json`. Use `CHROME_BIN` to override the Chrome executable. The script uses ephemeral loopback ports, an isolated synthetic ledger and temporary browser profile. Cache response fields are overridden with known synthetic measurements; other page values remain the fixture's values and are not totals for that override.

The committed screenshots show the 97.1–98.0% trend with a disclosed 96.965–98.135% range, Both and isolated New, the horizontally scrollable exact measurements table, measured zero input with unavailable percentage, and all-null cache measurements. The full run also captures constant, single, 0%, 100%, Overview and Performance at 1440px and 390px. All were visually inspected. The receipt records keyboard isolation, real timed background refresh, manual refresh, filters, bounds, selection persistence and nonoverlapping Usage cards.

The recovered harness assumed that selecting 90d at both widths immediately fetched a new response. The second viewport can reuse the first viewport's freshly persisted response. Each width now selects a different uncached preset; the network-fetch and aria-pressed assertion remains. The override also removes fixture ETags to avoid trying to parse bodyless conditional responses. Every scenario waits for its expected rendered percentage range or empty/denominator state before capture.

Final `make check` passed: typecheck, lint, 1,474 tests across 53 files, production build and synthetic fixture smoke. Source and build checks confirm the removed Overview Success rate/Median TTFT cards and Performance outage episode timeline remain absent. The retained timeline caller displays project branch spans, not outage episodes.

These are local synthetic results, not installed-instance acceptance or published release evidence. No personal usage data was used.
