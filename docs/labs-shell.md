# Labs shell and local preferences

Labs is an optional workspace at `/labs`. Turn Labs on in the settings menu (the gear next to the theme toggle). Its navigation entry appears when enabled. Disabled links to `/labs` or any nested path show a Turn on Labs action. Enabling and disabling on a Labs page keep its exact path and query intact, so a disabled case link can be recovered after reload.

The shared local preference key is `yald.preferences`. It stores a JSON object:

```json
{
  "version": 1,
  "labsEnabled": false,
  "hideArtwork": false
}
```

Missing, malformed, unsupported-version, or incorrectly typed values use these defaults. Each field must be a boolean. Preferences are local to this browser origin, with no account or remote configuration. Storage reads and writes are best effort; when storage is unavailable, preferences work for the current page session. `hideArtwork` is reserved for B02; no artwork or asset wiring is included here. Theme continues to use its existing `yald-theme` key.

`PreferencesProvider` and `usePreferences()` expose the typed preferences and `setPreference(key, value)`. The setter merges fields, so changing Labs preserves the artwork choice. Add future preferences to `Preferences`, `DEFAULT_PREFERENCES`, and `decodePreferences` in `web/src/lib/preferences.tsx`. Another browser tab's changes to the same key (or clearing local storage) are reflected through the storage event.

SSR without a browser uses defaults and does not read or write browser globals. The browser app uses `createRoot`, not hydration; its first render reads the saved preference once and never writes defaults on mount. If SSR hydration is introduced later, supply a matching storage snapshot on server and client. Tests can inject a `PreferencesStorage` adapter; `storage={null}` gives deterministic memory-only defaults. The smoke harness wraps every page and standalone Layout with the provider, independently of `main.tsx`.

`LabsLayout` is the `/labs` parent route and renders its Outlet only while enabled. Place all experiment data hooks inside child components. Disabling unmounts these children and their polling observers. Global metadata, dashboard scope and project-choice requests remain normal dashboard requests. An empty shell has no `/api/labs/*` queries even when enabled. Layout always renders the Labs gate, including when global filters match zero requests.

Independent views live under `web/src/pages/labs`. Register each view's `Component` in `LABS_INVESTIGATIONS` in `investigations.ts`. The reserved paths are `/labs/project-radar`, `/labs/cache-detective`, and `/labs/context-replay`; until registered, they show a neutral availability message. Hooks remain inside those components. L03/L05/L07 own the real investigation views and calculations. Add the future `/labs/evidence` child route beside the index and `:investigation` routes in `main.tsx`; it will use the same gate. Unknown nested paths currently retain the URL and offer All investigations.

`InvestigationState` accepts `kind="loading" | "error" | "empty" | "insufficient"`, optional `title`, `detail`, `children`, and an error-only `onRetry` action. Its status/alert region has a text heading and explanation. Native buttons and visible focus styling support keyboard use. Artwork is never required to understand a state.

Route links preserve `location.search`, including the complete authoritative `selector` and paired `priorSelector` JSON. Global filter edits preserve unrelated query keys; Reset filters removes only dashboard filter keys. Neither can replace the case's embedded fixed bounds or split comma-bearing arrays. The sibling `/labs/evidence` route validates case intent inside the same gate, before the generic investigation route. See [case evidence](labs-evidence.md) for the fixed selector/API contract.

The board and four investigations normalize their shared filter context to window,
timezone, source, project and model. Inherited provider, effort, outcome, route,
search, conversation and chart settings do not enter their requests or filter chips.
They remain in the URL for return navigation; Reset removes dashboard filters as
usual. The evidence route does not normalize its explicit case selectors. Changing
a window or timezone clears the investigation's selected `day`, preserving case
and session identity parameters.

Verify with `make typecheck`, `make smoke` (synthetic fixtures), and the native T3 preview against the isolated fixture server. Browser coverage must exercise both themes, keyboard enable/disable, reload, empty/error text states, full-cohort navigation, selector retention after toolbar changes/reset, blocked storage, and a disabled interval longer than the normal 30-second polling period.

For production browser checks, run `make build`, then `YALD_PREVIEW_PORT=5498 scripts/bun run scripts/preview-fixture.ts --scope`. Open your own private preview tab on port 5498. This server creates isolated synthetic opencodex, Claude and Codex homes and synthetic pricing, and removes them on shutdown. Do not run the normal server against a personal home for these checks.

For the UX regressions, add `--ux-regressions` to that fixture command. It adds
21 days of synthetic history relative to the fixture clock set in
`scripts/preview-fixture.ts`, which also supplies the demo display clock. The spike
timestamp is ten days and one hour before that clock
(`Date.now() - 10 * 86_400_000 - 3_600_000` in
`web/scripts/ux-regressions-fixture.ts`). Use that timestamp's `YYYY-MM-DD` date in
the selected timezone (`Asia/Singapore` by default) as the expected spike day.
Open `/usage?range=30d&projects=**/ux-regression&sources=ocx&models=gpt-6-luna&providers=wrong-provider&efforts=high&statuses=error&routeKinds=explicit-provider&search=no-match&conversationId=wrong-session`.
Click Labs: its controls/chip must show only source, project and model, and the
board must have data. Open Spikes: `day` must automatically select the expected spike day.
Click 24h: `day` must disappear and the daily-cost chart must load without an
error. Return to 30d, open See the requests, and verify the one row on that spike day
and the allowed cohort in both selectors. Check the other three investigations'
evidence too. Reset on the board must remove the filter chip while keeping the
window. On `/`, the fixture's fresh Plan usage readings must not say Stale merely
because the wall clock is later than the fixed demo clock. These are browser
interaction checks; `make smoke` alone provides API/SSR evidence.

To inspect shared states and prove that a future polling child is gated, also run `OCX_API=http://127.0.0.1:5498 scripts/bun run --cwd web vite --host 127.0.0.1 --port 5499 --strictPort`. In a native preview tab on port 5499, evaluate:

```js
const { mountLabsFixture } = await import('/scripts/labs-browser-fixture.tsx');
window.labsFixture = mountLabsFixture();
```

The fixture is not imported into the product build. `labsFixture.snapshot()` reports child mounts/unmounts, query calls, retries, and saved preferences. Initially it must report zero mounts and calls. Enable the fixture's Labs control, confirm multiple calls, then disable it and confirm calls stop and the child unmounts. Its test polling interval is 200 ms. The Set artwork preference and disable action must preserve both updates. Retry is keyboard usable; all four states are visible without images. Call `labsFixture.unmount()` when done. Repeat with `mountLabsFixture({ blockedStorage: true })` to verify in-memory changes when both reads and writes fail. Use native preview keyboard/click tools for interactions.
