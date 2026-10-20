# Yald: the Yaldi release

Status: proposed execution plan, 2026-10-20. Product direction and the Yaldi name
were accepted by the maintainer. This packet defines the release and local issue
contracts; it does not claim implementation or create remote backlog objects.

Planning branch: `plan/yaldi-labs-release`, from `dev` at `c851ef6`.
Proposed release: **v0.2.0 — Meet Yaldi**. The version and publication date remain
unset in package metadata until release preparation. No calendar deadline is assumed.

## Release promise

Yald helps you investigate where your coding-agent usage goes: which projects
drive estimated cost, whether cache discounts outweigh write premiums, and how
submitted context grows through a conversation. Yaldi is the small detective who
makes those findings approachable and points back to the evidence.

Suggested public line: **Follow the tokens. Find the story.**

This is one complete product story: install Yald, explore safe sample data or
your own logs, find an explainable pattern, and inspect the requests behind it.
The release should feel useful before a visitor has personal usage history.

## Accepted direction and boundaries

- Keep the Yald name and existing `Yald.` wordmark. The mascot is **Yaldi**.
- Keep the paper, ink and coral visual direction; support the existing desktop
  light/dark experience. A mobile dashboard redesign is outside this release.
- Add an optional **Labs** tab with Project Radar, Cache Detective and Context
  Replay. Each investigation shares the dashboard's filters and links to evidence.
- Use existing ledgers, transcripts, pricing and reports. New provider APIs,
  hosted accounts, mandatory LLM calls and subscription-quota collection are outside scope.
- Treat cost as an **API list-price equivalent**, not subscription billing.
- Leave source logs untouched; document Yald's own Claude usage archive and its retention.
- Use synthetic fixtures for tests, screenshots, demo content and launch assets.

## What is already available

| Capability | Existing foundation | Work still required |
| --- | --- | --- |
| Source identity | `server/src/report/source.ts` distinguishes transcript and proxy rows | Apply the same source/coverage semantics throughout dashboard metrics |
| Project scope | `server/src/projects.ts` and `GET /api/projects` aggregate folders and git roots | Expose filters, explain unattributed rows, add comparable project trends |
| Cache economics | Token classes and input/read/write rates in `RequestRow` | Compute net economics with the pricing engine's tier rules and coverage |
| Session history | Request timestamps, model, tokens, source and conversation ID | Compare request sequences safely and rank growth patterns |
| Reporting | Exact windows, JSON payload, standalone HTML, CLI and HTTP endpoint | Reuse these boundaries; a new report format is unnecessary |
| Demo data | `web/scripts/fixtureHome.ts` and `scripts/preview-fixture.ts` | Make a packaged, isolated first-run demo |
| Branding | Approved [Yaldi exploration](../brand/yaldi/README.md) | Finalize small icons and integrate static/state artwork |

Claude transcripts have no measured timing, retry history, failed calls or quota.
Their synthetic HTTP 200 values must not become measured reliability or a successful
outcome badge/filter cohort. Missing input must remain distinguishable from observed
zero input. Distinguish source by protocol, not provider: Anthropic traffic can also pass through opencodex.
Group session-level investigations by `(source, conversationId)`.

## Five epics

| Epic | Outcome | Work packages |
| --- | --- | --- |
| [E1: Trustworthy data and scope](epics/01-trust-and-scope.md) | Every number says what was observed and what is missing | F01–F03 |
| [E2: Labs investigations](epics/02-labs-investigations.md) | Three useful investigations with reproducible evidence | L01–L08 |
| [E3: Yaldi identity](epics/03-yaldi-identity.md) | A recognizable logo and companion that fit a serious analytics tool | B01–B02 |
| [E4: First-run experience and docs](epics/04-onboarding-and-docs.md) | A newcomer can understand and try the product in one sitting | O01–O02 |
| [E5: Release proof and delivery](epics/05-release-readiness.md) | The shipped artifact, screenshots and claims agree | R01–R03 |

There are **18 focused work packages**. Each targets one reviewable PR to `dev`.
Parent epics are aggregate outcomes, not tasks a coding agent should acquire.

## Definition of Ready and Done

A work package is Ready when its dependencies are Done, its input contract is
specified, its acceptance checks are observable, and it has a credible verification
path. A product or schema decision that changes the contract moves it back to
Backlog until resolved. Dependency-held items below begin Blocked, not In progress.

Done means the acceptance checks pass, relevant definitions/docs agree, and the PR
has merged into `dev` with the required checks. Release work additionally needs the
evidence named in E5. A screenshot or a passing unit test alone is not release acceptance.

The stable issue key in each contract is the identity to use when materializing
GitHub issues. Search by key and existing URL before creating an issue. Initial
statuses here are planning state; they are not claims about GitHub metadata.

## Delivery sequence and gates

| Order | Work package | Initial state | Prerequisites |
| --- | --- | --- | --- |
| 1 | F01 — source capabilities and coverage | Ready | None |
| 2 | F03 — explain attribution gaps | Ready | None; reuse the reason-breakdown slice of #47 |
| 3 | F02 — source/project filters | Blocked | F01 |
| 4 | B01 — finalize the Yaldi asset set | Ready | Accepted name and visual direction |
| 5 | L01 — optional Labs shell | Blocked | F02 |
| 6 | L02 — Project Radar data | Blocked | F01, F03 |
| 7 | L03 — Project Radar view | Blocked | L01, L02 |
| 8 | L04 — net cache economics data | Blocked | F01 |
| 9 | L05 — Cache Detective view | Blocked | L01, L04 |
| 10 | L06 — context sequence data | Blocked | F01 |
| 11 | L07 — Context Replay view | Blocked | L01, L06 |
| 12 | L08 — evidence case files | Blocked | L03, L05, L07 |
| 13 | B02 — integrate Yaldi and state artwork | Blocked | B01, L01 |
| 14 | O01 — README and product-copy cleanup | Blocked | F01, F02, F03, B01, L08 |
| 15 | O02 — packaged synthetic demo | Blocked | B02, L08 |
| 16 | R01 — integrated and package verification | Blocked | O01, O02 |
| 17 | R02 — release-candidate packet | Blocked | R01 |
| 18 | R03 — promote and publish the qualified artifact | Blocked | R02 and release authorization at execution time |

For one coding agent, take the lowest-order Ready item, keep one implementation
item In progress, and re-evaluate readiness after each merge. B01 can progress
independently when design work is available. Do not combine all three investigations
into one PR or leave the correctness foundation until release week.

- **Gate A — trustworthy foundation:** F01–F03 complete; mixed-source and missing
  attribution fixtures demonstrate honest values and denominators.
- **Gate B — useful Labs preview:** L01–L08 complete; each finding opens the same
  cohort/window that produced it. No-data and insufficient-data states work.
- **Gate C — recognizable first run:** B01–B02 and O01–O02 complete; a clean install
  can show the sample investigations without reading the user's actual homes.
- **Gate D — publishable candidate:** R01–R02 complete; clean-package validation,
  Linux/macOS evidence, release notes and checksums identify the same candidate.

## First implementation handoff

Start **F01: source capabilities and metric coverage** in
[E1](epics/01-trust-and-scope.md#f01--source-capabilities-and-metric-coverage).

It is first because all three investigations need to distinguish a real zero
from missing observations. Reuse `sourceOf()` and the report's source semantics;
write a mixed-source fixture that would otherwise report Claude transcript
responses as perfect reliability. Preserve token and priced-cost totals while
reporting success/timing only over eligible rows. Add explicit coverage to the
API and web types, update the metric definitions, and verify the existing views.

Do not start by drawing the Labs page: its labels and denominators depend on this contract.

## Existing work to reconcile

- [#47: missing project attribution](https://github.com/Collaboration95/yald/issues/47)
  already includes the reason breakdown, inference and image pricing. F03 is the
  explanation slice only. Reuse that issue for the slice; link this plan when
  applying the backlog. The broader issue stays open while its other acceptance
  items remain. Do not make inferred attribution or image-price guesses a Labs prerequisite.
- [#7: first public launch](https://github.com/Collaboration95/yald/issues/7) still
  tracks v0.1.0 launch work. The v0.1.0 release exists. R02 should reconcile the
  checklist with evidence and distinguish remaining launch chores from this
  release's new work. This planning packet does not close or rewrite that issue.
- No open PRs were returned by discovery on 2026-10-20. No matching Yald Project
  was returned by the owner-project listing. Remote discovery is a dated observation.

## Proposed GitHub execution board

This is a proposal for a later explicit backlog-apply action. No Project, issue,
label, milestone, dependency or status was changed during planning.

Use one Project, **Yald — Product delivery**, linked to this repository. Before
creation, inspect all pages and existing repository links again; reuse a matching
Project. Use milestone **v0.2.0 — Meet Yaldi** for this release. Do not assign
calendar iterations until there is an agreed schedule.

Fields: Status (Backlog, Ready, In progress, Review, Blocked, Done), Priority
(P0–P2), Size (S/M), Risk (Low/Medium/High), Area, Sequence and an optional Iteration.
Views: Epics, Ready queue, Current iteration when scheduled, Review and Blocked.
Use native parent and blocked-by relationships where supported; F03 reuses #47
and needs a clear partial-scope note rather than a duplicate issue.

Reuse existing `enhancement`, `bug`, `documentation` and `accessibility` labels;
propose only `epic`, `labs`, `branding` and `release` if they improve filtering.
Do not invent assignees or mark dependency-held work Ready.

## Follow-up roadmap

These ideas remain part of the direction, outside the first release cut:

| Follow-up | What must be true first |
| --- | --- |
| Spend-change waterfall | Stable comparable cohorts, a stated decomposition order and treatment of new models |
| Latency Watch | Measured timing, workload/tier cohorts, sample-count rules and retry separation |
| Model Switch Diary | Safe session identities and clear association-versus-causation wording |
| Retry Observatory | Metering coverage; exact triggers/costs additionally need retained attempt details |
| Budget targets and forecast ranges | Clear API-equivalent cost semantics and coverage; quota scenarios use observed percent burn |
| Saved views and report actions | Stable Labs evidence parameters and compatibility with the existing report contract |
| Agent cost trees / tool fingerprints | Richer parsing of parent/attempt/tool metadata; no automatic prompt-content capture |
| Native Codex and more local adapters | Source contracts and deduplication of native/proxy overlap |
| Historical/scenario pricing | Pricing provenance and explicit fixed-workload assumptions |
| Task outcomes and cost per task | An explicit opt-in outcome/tagging signal; current logs cannot measure productivity or quality |
| Claude subscription quota | An optional status-line collector; passive transcripts do not provide quota samples |
| Animated Yaldi | Production framing/state assets, reduced-motion support and evidence that motion helps the experience |
| Hub aggregation, npm automation, Homebrew | Separate operational scope and verified distribution/authentication requirements |

## Release decisions still open

- Confirm the final version name and date during R02; v0.2.0 is a planning target.
- Choose the publication channels during R02. A tested GitHub artifact is the
  baseline; npm/Homebrew are separate deliverables and must not be advertised as available prematurely.
- Decide whether to post launch drafts or enable Discussions separately. Existing
  #7 requires explicit authorization for external posts; preparing the draft is allowed.

None of these decisions blocks F01, F03 or B01.
