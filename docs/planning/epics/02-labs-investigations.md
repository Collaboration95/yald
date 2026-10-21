# E2 — Labs investigations

Parent key: `agent-orchestration:issue-key=yaldi-epic-labs`.
Priority: P1. Outcome: a user can investigate project cost, net cache economics
and context growth, then inspect the exact requests supporting a finding.

Epic acceptance: L01–L08 are integrated; the three investigations share resolved
time/source/project scope, disclose coverage, and work with empty and partial
data. Descriptive observations do not claim causality, task quality or productivity.

## Shared investigation contract

Resolve rolling filters once per analysis into explicit half-open `[from, to)`
boundaries and a timezone. Return that window, source/project scope, eligible and
total sample counts, missing-price/attribution notes, and the evidence selector.
Use the same selector for the chart and evidence. Reuse existing source, window,
project and pricing helpers; do not add a second parallel interpretation.

Evidence must be source-qualified. The current `/api/conversations/:id` handler
reads the whole ID without applying the request's source/window filters. Passing
new query parameters to that handler alone is not a scoped drill-down. L08 must
supply a real scoped evidence boundary or extend the existing one compatibly.

Individual views can integrate behind Labs while L08 is unfinished; the public
release gate requires the complete evidence flow.

## L01 — Optional Labs route and shared states

Key: `agent-orchestration:issue-key=yaldi-labs-shell`.
Initial status: **Blocked** by F02. Priority: P1. Size: S. Risk: Low.

**Objective:** give experiments a clear, optional home within the existing app.
**Scope:** a Labs navigation entry and route, an enable/disable preference,
shared loading/error/empty/insufficient-data states, and the investigation scope
presentation. Keep existing desktop themes and URL-backed filters.
**Out of scope:** implementing chart calculations or replacing existing navigation.

**Acceptance:**

- Users can enable Labs, navigate to it, disable it, and recover from a disabled
  deep link without an error. The preference has one documented local location.
- Existing filters survive entry/exit, refresh, and direct links.
- Shared states are keyboard accessible and legible in both themes; missing data
  is explained in text without depending on mascot art.
- Empty Labs does not issue polling requests for disabled experiments.

**Boundaries:** `web/src/main.tsx`, `components/Layout.tsx`, shared UI/preferences,
new Labs page components, and `web/src/types.ts`.
**Verification:** `make typecheck`, `make smoke`, and fixture-browser checks for
preference persistence, direct links and empty/error states.
**Stop conditions:** if enabling Labs would require a server-side account or a
new remote configuration service, keep the preference local and revise that approach.

## L02 — Project Radar data and comparisons

Key: `agent-orchestration:issue-key=yaldi-project-radar-data`.
Initial status: **Blocked** by F01, F03. Priority: P1. Size: M. Risk: Medium.

**Objective:** identify which projects account for estimated cost and activity changes.
**Scope:** reuse git-root aggregation; add daily trends, active days, model mix,
current/prior equal-window comparisons, coverage and evidence selectors.
**Out of scope:** project completion scores, repository productivity, inferred attribution.

**Acceptance:**

- Named projects and the unattributed population reconcile with scoped request,
  token and priced-cost totals; attribution and price coverage remain separate.
- The preceding equal-length window uses the same source/project filters,
  timezone and currently loaded pricing assumptions. No historical-price claim is made.
- Zero or missing baselines produce an explicit new/insufficient state, not
  infinity or an invented percentage. Partial history is disclosed.
- Synthetic cases include nested folders, a missing folder, a price gap, a
  newly active project and a project with lower usage.
- Response additions are typed and document their units, sorting and evidence scope.

**Boundaries:** `server/src/projects.ts`, `analytics.ts`, `api.ts`, shared window
helpers, `web/src/types.ts`, and `docs/api.md`/`docs/metrics.md`.
**Verification:** focused aggregation/API fixtures, `make check-fast`, `make typecheck`.
**Stop conditions:** do not derive completion or delivered value from request volume.
Keep absent attribution visible instead of assigning it by temporal proximity.

## L03 — Project Radar view

Key: `agent-orchestration:issue-key=yaldi-project-radar-view`.
Initial status: **Blocked** by L01, L02. Priority: P1. Size: M. Risk: Medium.

**Objective:** make project usage changes easy to compare and investigate.
**Scope:** a ranked comparison, daily trends, source/model detail, coverage notes
and an evidence action wired to the shared selector for L08.
**Out of scope:** a new project-management system or profitability labels.

**Acceptance:**

- Ranking, selected project and displayed comparison use L02's values and units;
  switching filters updates them together.
- Current/prior periods and estimated cost semantics are visible; unpriced and
  unattributed requests cannot be mistaken for free or inactive projects.
- Empty, insufficient and no-price cases work without broken charts.
- Selection and evidence intent are keyboard accessible; light/dark visuals
  remain consistent with the current chart palette and layout.

**Boundaries:** Labs page components, shared chart options, `web/src/api.ts` and types.
**Verification:** `make typecheck`, `make smoke`, and fixture-browser comparisons
against the L02 payload. Final evidence acceptance is part of L08.
**Stop conditions:** if the view needs data not in L02, extend that contract with
fixtures before adding a client-only estimate.

## L04 — Net cache economics data

Key: `agent-orchestration:issue-key=yaldi-net-cache-data`.
Initial status: **Blocked** by F01. Priority: P1. Size: M. Risk: High.

**Objective:** show whether observed read discounts outweigh write premiums.
**Scope:** per-session and selected-scope comparisons against the identical
recorded input priced as uncached input, with pricing/provenance coverage.
**Out of scope:** cache-prefix survival, TTL reconstruction, alternate-turn-cadence
savings, or claims about subscription bills.

For eligible fixed-rate rows, the definition is:

`netBenefit = [read × (inputRate − readRate) − write × (writeRate − inputRate)] / 1e6`.

Validate the result with the existing pricing engine and its tier/service rules;
do not assume this expression replaces tier-dependent pricing.

**Acceptance:**

- Known fixtures exercise positive, negative and zero net benefit; read discounts
  and write premiums reconcile to the net value at the declared precision.
- Only observed, adequately priced cache accounting supports money comparisons;
  excluded/synthesized/missing-rate rows and their coverage are explicit.
- Long-context/service-tier fixtures use the same workload and tier assumptions
  for the baseline and actual pricing. No guessed fallback rate is used.
- Sessions use `(source, conversationId)` and unnamed-session rows remain accounted
  for at scope level without being merged into a fabricated conversation.
- Time windows and evidence selectors obey the shared investigation contract.

**Boundaries:** `ocx/pricing.ts`, `analytics.ts`, `api.ts`, typed responses and metric docs.
**Verification:** focused pricing/aggregation fixtures, `make check-fast`, `make typecheck`.
**Stop conditions:** if normalization loses a rate/tier needed for a valid baseline,
expose that case as unavailable and document the upstream contract gap.

## L05 — Cache Detective view

Key: `agent-orchestration:issue-key=yaldi-cache-detective-view`.
Initial status: **Blocked** by L01, L04. Priority: P1. Size: M. Risk: Medium.

**Objective:** make net cache economics understandable at session level.
**Scope:** read-discount/write-premium/net comparison, session ranking, coverage
notes, and a selected-session breakdown with the L08 evidence action.
**Out of scope:** diagnosing a cache miss's cause from token counts alone.

**Acceptance:**

- Users can distinguish the current gross read-discount metric from this net
  comparison, including sessions where writes exceed read discounts.
- Monetary labels identify the fixed-workload API-equivalent baseline.
- No-price, no-observed-cache and partial-coverage states display accurately.
- A selected session preserves source identity and the analysis window.
- The result is legible without color alone and usable by keyboard in both themes.

**Boundaries:** Labs components, chart options, API hook and response types.
**Verification:** `make typecheck`, `make smoke`, and browser checks against L04 fixtures.
**Stop conditions:** omit cadence/TTL explanations unless the source records the
needed evidence. Use descriptive observations instead of unsupported diagnoses.

## L06 — Context sequence and growth data

Key: `agent-orchestration:issue-key=yaldi-context-sequence-data`.
Initial status: **Blocked** by F01. Priority: P1. Size: M. Risk: Medium.

**Objective:** find sessions whose submitted input grows across eligible requests.
**Scope:** source-qualified, time-ordered request sequences; input/cache/output,
model markers and priced cost; transparent growth ranking and truncation/coverage notes.
**Out of scope:** compaction detection, task-turn reconstruction, or a waste score.

**Acceptance:**

- Sequences never merge equal conversation IDs from different sources and use
  deterministic ordering for equal timestamps.
- Per-row input eligibility requires observed input accounting. Preserve source
  field presence/provenance before numeric defaults so absent input is not
  interpreted as an observed zero; aggregate `usageStatus` alone is not enough.
- Rows with missing input, or whose top-level usage was recovered by summing
  attempts, are excluded from request-context comparisons; exclusions are counted
  and explained. A genuine provider-reported zero remains an eligible zero.
- Growth ranking compares median input of the first three versus last three
  eligible requests, with at least six eligible requests. Show absolute change;
  a zero baseline yields no ratio. Smaller samples retain a viewable sequence
  but no ranked growth claim.
- Range-limited history is labelled as such. A token drop is an observed drop,
  not proof of compaction; concurrent calls are described as requests, not turns.
- Model changes and costs are observations; their proximity to growth or a drop
  does not establish cause. Unpriced request cost stays unavailable.

**Boundaries:** `analytics.ts`, `api.ts`, request normalization metadata, types and metric docs.
**Verification:** focused cross-source collision, timestamp-tie, attempt-summed,
unmetered-failure, missing-input, observed-zero, short-session, truncated-window
and zero-baseline fixtures; `make check-fast`, `make typecheck`. An unmetered call
between two metered requests must not create a false context drop or change ranking.
**Stop conditions:** if agent interleaving cannot be disentangled, retain a
time-ordered request view and its limitation instead of inventing a single-agent turn history.

## L07 — Context Replay view

Key: `agent-orchestration:issue-key=yaldi-context-replay-view`.
Initial status: **Blocked** by L01, L06. Priority: P1. Size: M. Risk: Medium.

**Objective:** make context growth inspectable instead of hiding it in cumulative totals.
**Scope:** session ranking, submitted/cached-input timeline, request-level model,
token and cost detail, visible input drops, and the L08 evidence action.
**Out of scope:** a new transcript editor or displaying prompt/response bodies.

**Acceptance:**

- Selecting a session and request shows the corresponding L06 values, source
  and window, including absent price/timing and excluded-row notes.
- Axes distinguish input tokens, request index/time and money; reasoning is not
  added again to total output. Model markers retain stable identity colors.
- A short session remains inspectable while its growth ranking says insufficient data.
- Missing-input requests render as unavailable/gaps, while observed zero input is
  shown at zero; neither the line nor labels invent an observed drop at an unmetered call.
- Observed drops and model switches use neutral wording. No compaction or quality
  conclusion is implied by the graphic.
- Keyboard selection and both themes work with deterministic synthetic fixtures.

**Boundaries:** Labs components, shared charts, request detail presentation and types.
**Verification:** `make typecheck`, `make smoke`, and browser comparison with L06 fixtures.
**Stop conditions:** do not expose transcript content merely to make the replay
look richer; use the existing normalized usage boundary.

## L08 — Evidence case files

Key: `agent-orchestration:issue-key=yaldi-evidence-case-files`.
Initial status: **Blocked** by L03, L05, L07. Priority: P1. Size: M. Risk: High.

**Objective:** let users inspect why a finding appeared and reproduce its cohort.
**Scope:** deterministic observation templates for the three investigations,
explicit resolved parameters/coverage, and a bounded source-qualified request
evidence view/API. Reuse an existing route compatibly when it can honor the scope;
otherwise introduce a small typed evidence boundary rather than an unfiltered link.
**Out of scope:** LLM summaries, alert delivery, saved-view sync or a new report schema.

**Acceptance:**

- Each case file states the observed values, exact current/prior window when
  applicable, cohort, eligible sample count and missing-data limitations.
- “Open requests” returns the same selected population used by the finding,
  including stable ordering and pagination where needed. Totals reconcile.
- Cross-source ID collisions, unnamed sessions and range boundaries do not leak
  unrelated requests into the result. Changing a rolling time preset does not
  silently move an already opened case file's evidence window.
- Evidence can be opened via a URL carrying the necessary parameters, independent
  of component-local selection. Unsupported or invalid scope fails clearly.
- Templates make descriptive claims only; no rule invents a productivity, quality,
  compaction, cache-miss cause or subscription-savings conclusion.
- Empty/insufficient cases produce an explanatory state rather than a dramatic clue.

**Boundaries:** Labs components, source/window/filter helpers, existing conversation
detail or a bounded evidence endpoint, public row types and API docs.
**Verification:** evidence-set reconciliation/API fixtures, `make check-fast`,
`make typecheck`, `make smoke`, and a browser URL round trip for all three investigations.
**Stop conditions:** if a request cannot be identified safely by the available
selector, leave the observation unavailable until the identity contract is fixed.
