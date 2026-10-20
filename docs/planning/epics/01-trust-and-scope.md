# E1 — Trustworthy data and scope

Parent key: `agent-orchestration:issue-key=yaldi-epic-trust`.
Priority: P0. Outcome: a user can tell what a metric includes, what is unavailable,
and how project/source filters affect the result.

Epic acceptance: F01–F03 are integrated into `dev`; mixed-source, missing-price
and missing-attribution fixtures pass; the dashboard and report agree on definitions.
No source log is changed and no source capability is inferred from a provider name.

## F01 — Source capabilities and metric coverage

Key: `agent-orchestration:issue-key=yaldi-source-coverage`.
Initial status: **Ready**. Priority: P0. Size: M. Risk: High.
Dependencies: none. This is the recommended first implementation PR.

**Objective:** make missing observations visible before Labs derives new findings.

**Scope:** reuse `sourceOf()` for source identity; define shared source capabilities
and additive API/web coverage fields; preserve per-row measurement presence before
normalization supplies numeric defaults; apply eligible-row denominators to success,
timing and cache metrics; update outcome badges/filters and metric definitions. Keep request/token volume
and priced-cost totals inclusive of the same otherwise-matching source rows.
Reports already restrict success rate to proxy rows: preserve that intent and
align dashboard consumers with it.

**Out of scope:** new collectors, native usage adapters, quota estimates,
rewriting ledger rows, or treating missing measurements as zero.

**Acceptance:**

- A Claude-only fixture shows reliability, retry history, timing and quota as
  unavailable where those observations do not exist; synthetic HTTP 200 is not
  reported as measured 100% success.
- A mixed fixture with an opencodex failure reports success over observed eligible
  logical requests, with the eligible and total sample counts visible.
- Outcome presentation distinguishes `unobserved` from `ok`, `error` and `cancelled`.
  Unfiltered request lists and volume totals retain transcript rows; selecting an
  observed success/error/cancelled cohort excludes unobserved outcomes. Provide
  an explicit unobserved cohort in the shared outcome control. Outcome breakdowns
  reconcile with total requests without putting synthetic responses in success bars.
- Request badges, tables and API outcome fields obey the same policy as the KPI.
  A Claude-only success filter cannot return synthetic “successful” requests.
- Anthropic traffic routed through opencodex remains source `ocx` and retains its
  measured capabilities. Source selection does not use `provider` as a proxy.
- A missing price is distinguishable from a priced zero-cost request. Cache
  ratios identify observed eligible rows and omit unavailable rates from money calculations.
- Missing input usage is distinguishable from provider-reported zero input after
  normalization. Preserve enough presence/provenance metadata for L06 to exclude
  missing-input and attempt-summed rows from context comparisons.
- API and web types, dashboard labels and `docs/metrics.md` agree. Existing
  report totals and token/cost semantics do not silently change.

**Boundaries:** `server/src/report/source.ts`, `server/src/ocx/store.ts`,
`server/src/analytics.ts`, `server/src/api.ts`, `server/src/report/build.ts`,
`web/src/types.ts`, affected page components, and `docs/metrics.md`.

**Verification:** add focused mixed-source and absent-measurement fixtures; run
`make check-fast`, `make typecheck`, and `make smoke`; manually inspect one
Claude-only and one mixed-source dashboard view using synthetic data. Include
outcome-filter/badge checks and a missing-input versus observed-zero fixture.

**Stop conditions:** if an existing consumer requires a breaking response shape,
document the migration before changing it. If a source cannot prove a capability,
retain an unavailable state and record the gap rather than guessing.

## F02 — Source and project filters in the dashboard

Key: `agent-orchestration:issue-key=yaldi-source-project-filters`.
Initial status: **Blocked** by F01. Priority: P0. Size: M. Risk: Medium.

**Objective:** let users investigate the same cohort across views and Labs.

**Scope:** expose existing source/project API filters in the shared toolbar;
extend URL-backed filter types and requests; include active filter counts,
reset behavior, empty results and attribution-coverage wording.

**Out of scope:** saved-view accounts, a new project database, manual inference
of folders, changing the nearest-git-root grouping rule, or a mobile shell redesign.

**Acceptance:**

- Selecting a source or project changes all applicable dashboard queries; choices
  survive route navigation and page reload through the URL.
- Project choices come from the existing project aggregation; glob matching and
  source semantics remain consistent with reports.
- Reset clears the new filters. A no-match result displays an empty state.
- Unattributed usage stays identifiable in coverage; it is not silently assigned
  to the selected project. A project-filtered result explains excluded usage.
- New controls are keyboard usable and do not discard the existing range,
  provider, model, effort or outcome selections.
- Quota and send-ledger panels remain explicitly account/global observations
  where requests cannot be joined to them. Hide or qualify unsupported source
  selections; never present a global quota as a project's own usage.

**Boundaries:** `web/src/api.ts`, `web/src/lib/useFilters.tsx`,
`web/src/components/Layout.tsx`, `web/src/types.ts`, `server/src/api.ts`.

**Verification:** `make typecheck`, `make smoke`, and focused request/filter tests;
browser-check URL round trips, reset, no-match and combined filters with fixtures.

**Stop conditions:** if a page cannot honor the scope, expose and fix that
boundary before claiming shared filtering. Do not quietly drop parameters.

## F03 — Explain missing project attribution

Key: `agent-orchestration:issue-key=yaldi-attribution-reasons`.
Initial status: **Ready**. Priority: P0. Size: M. Risk: Medium.
Dependencies: none. Existing tracker:
[#47](https://github.com/Collaboration95/yald/issues/47), explanation slice only.

**Objective:** explain what a project-filtered total leaves out.

**Scope:** reason breakdowns in API/report coverage and HTML coverage notes;
include rows, tokens and model summaries. Distinguish opencodex rows without
conversation IDs from rows whose IDs have no matching rollout. Preserve an
explicit other/unknown bucket when a missing folder does not fit either reason,
including transcript rows without a working directory.

**Out of scope:** time-based matching, active-session overlap inference, image
pricing, or upstream changes. Those remain in #47's broader proposal.

**Acceptance:**

- Synthetic fixtures exercise no ID, no matching rollout, known folder, and
  another missing-folder case without fabricating a cause.
- Reason totals reconcile with the unattributed population for the same source
  and time scope. A project-filtered response explains exclusions consistently.
- The report JSON and rendered coverage note agree; existing coverage totals
  remain available to consumers.
- No new attribution is inferred and no unmetered image is given an invented price.
- When the backlog is applied, #47 is reused and the completed slice is identified;
  the issue is not closed while inference/pricing acceptance items remain unfinished.

**Boundaries:** `server/src/ocx/store.ts`, `server/src/codex/sessions.ts`,
`server/src/projects.ts`, `server/src/api.ts`, `server/src/report/types.ts`,
`server/src/report/build.ts`, `server/src/report/render.ts`.

**Verification:** targeted project and report fixtures, `make check-fast`,
`make typecheck`, and report-render checks. All examples use synthetic folders.

**Stop conditions:** preserve unknown reasons when evidence is unavailable. If
the frozen report contract cannot accept a compatible addition, settle the
versioning/migration before changing the schema.
