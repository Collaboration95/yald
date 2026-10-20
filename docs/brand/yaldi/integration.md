# Yaldi application integration

Yald remains the product; Yaldi is its detective companion. The live `Yald.`
wordmark stays beside the 32 px mark in the existing sidebar. Product descriptions
cover opencodex **and** Claude Code; source capability and pricing limitations
remain in the data views. No brand font, external image, animation or service is added.

`web/src/components/YaldiArtwork.tsx` exports:

- `YaldiArtwork({ state, size = 80, className? })`: `investigating`, `analysing`,
  `empty`, `insufficient`, `error` or `resting`.
- `YaldiFindingArtwork({ evidenceSufficient, size = 80, className? })`: shows
  `clue-found` only when the required boolean is true; otherwise renders nothing.
- `YaldiMark()`: the small wordmark-adjacent companion mark.

State sizes are 80, 120 or 160 px, with intrinsic `width=160 height=160`; the mark
has intrinsic `width=32 height=32` and 4 px clear space. Each image loads its own
local SVG via `img`, retaining internal title IDs inside that resource. The app's
`useTheme()` selects the plain or `-dark` file, including when the app differs
from OS appearance. SVGs are never recoloured or inlined. Images have empty alt
text and decorative semantics; adjacent text states every meaning and limitation.

`InvestigationState` preserves status/alert, detail, children and error retry
controls with artwork hidden. `loading` maps to investigating; `analysing`,
`empty`, `insufficient`, `error` and `resting` use the matching static pose.
The Labs gate and index use resting. The gate never mounts disabled investigations.

The sidebar's keyboard-operable **Hide artwork** switch uses the existing
`usePreferences().hideArtwork` and version-1 `yald.preferences` storage. It hides
the mark, state art and finding art together, persists on reload, and leaves
complete text and controls available. No extra storage key or overlay is added.
The wordmark is static; existing reduced-motion rules still cover incidental UI
transitions. Sidebar width, charts, filters and server calculations are unchanged.

## Integrated finding guards

Each actual investigation contains one `YaldiFindingArtwork` inside its
`section[data-finding-summary]`, beside complete text. The helper renders no
finding of its own. All values and evidence still come from the same response
and displayed selection; no calculation, selector, registry or chart helper changes.

- **Project Radar:** `ProjectRadar` returns loading/error before mounting its
  result. The selected project must have priced observations in either original
  period and `comparison.pricedCostUsd.state` must be `compared` or `new`.
  Missing price, insufficient comparison and missing loaded baseline get no clue.
  A priced current zero against a supported positive prior remains valid, as does
  a server-supported prior-only comparison. Both exact current/prior evidence
  selectors and period actions remain unchanged.
- **Cache Detective:** the scope summary uses `cacheFinding(data.totals)` and
  `available(data.totals)` (`eligibleRequests > 0 && direction !== "insufficient"`),
  with the displayed `totals.evidence`. The outer query passes
  `findingFresh={!query.isError}` into `CacheResults`: retained eligible data on
  a failed refresh keeps its values, limitations and evidence but loses clue-found.
  Engine-loading metadata and dollar sign/amount never establish support. Even,
  explicit free and negative net comparisons can all be supported.
- **Context Replay:** loading/error branches precede the result. The selected
  source-qualified session must have `growth.ranked` and non-null `baseline` and
  `latest`. Its semantic summary immediately before the chart displays the
  existing first-three/last-three medians, signed server change and server ratio,
  with the same `session.evidence` action. Non-null zero is observed data; null
  ratio stays unavailable, including the explicit zero-baseline explanation.
  Short, excluded and unranked sessions retain their insufficient state and
  inspectable requests without clue-found.

Error/empty/insufficient states use `InvestigationState`. Finding support is never
constant, inferred from money, or established merely by existing response rows.
Artwork adds no claim about savings, quality, compaction or cache-miss cause.

## Verification and local assets

`make typecheck`, `make build`, `make smoke` and `make check-fast` pass on the
integrated tree. Normal smoke retains all existing view fixtures/checks and runs
the isolated Radar and Cache harnesses in separate processes: 996 Radar assertions,
45 Cache groups, nine Context API/render/chart groups and 30 shared brand checks.
Actual server responses cover supported/insufficient/empty findings, priced zero,
negative/even cache net, zero-baseline Context, missing baseline and refresh error
with retained data. In both app themes, removing images leaves identical text,
values and evidence URLs. No fixture is imported by a production entry.

The original B02 shared-state fixture remains useful for loading/analysing/error/
empty/resting semantics; it is separate from the actual three-view acceptance.

For a native T3 browser check, start `scripts/preview-fixture.ts --scope` on an
unused `YALD_PREVIEW_PORT`, then Vite with `OCX_API=http://127.0.0.1:<that-port>`.
Open `/scripts/yaldi-fixture.html` on Vite in an agent-owned private tab. Enable
Labs, select all seven synthetic states, toggle evidence sufficiency, use Hide
artwork with the keyboard, reload and toggle both app themes against the opposite
OS appearance. The fixture is a dev entry under `web/scripts/`; the production
build does not expose it or add a route/registry entry.

For the actual views, build first, then run the existing isolated fixtures:
`web/scripts/project-radar-fixture.ts`, `web/scripts/cache-detective-fixture.ts`
and `scripts/preview-context-replay.ts` with `scripts/bun`. Each prints its URL;
all source homes and pricing are synthetic and initialized before server imports.
Restart fixture servers after rebuilding because the production server caches
its HTML shell at startup. In an own native T3 tab, enable Labs, select a case,
then evaluate `web/scripts/yaldi-findings-browser-check.js` without `export` and
call `checkYaldiFindingsBrowser(expectedSupported)` with the known case expectation.

Native desktop verification covers all three actual summaries with supported and
insufficient selections × light/dark × shown/hidden, app theme opposite OS,
exact original evidence parameters, local image decode/decorative semantics,
unchanged text/links, keyboard selection/retry/hide, persisted hide on reload,
source/project/search filters and refresh failure/recovery. Sidebar stays 190 px;
Radar/Context canvases remain legible with no document or finding overflow.
Evidence navigation preserves the original intent; L08 replay and independent
Radar/Context acceptance remain their own integration gates.

Vite copies `web/public/` into `web/dist/`; npm packages that dist directory.
The local metadata icons use `/favicon.svg`, `/favicon.ico` and
`/apple-touch-icon.png`. No generated-image home paths or remote brand images
are used. With a built or installed server running against isolated synthetic
data paths, run:

```sh
scripts/bun run scripts/check-yaldi-assets.ts http://127.0.0.1:<port>
```

This fetches every shipped manifest asset and verifies HTTP status, image MIME
and exact source bytes, catching accidental HTML fallbacks as well as missing
files. It also checks the built page metadata and icon references. Run it once
against the build and once against a fresh local npm-tarball installation.

Rechecked after finding integration: build and fresh installed package each serve
23/23 exact manifest assets over HTTP, with correct MIME and metadata. All 40
built runtime files match the installation byte-for-byte. The 77-file tarball
contains all 20 Yaldi SVGs and no development browser/smoke entries. Original B02
asset/state evidence is recorded separately from these new actual-view checks.
