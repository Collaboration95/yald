# E5 — Release proof and delivery

Parent key: `agent-orchestration:issue-key=yaldi-epic-release`.
Priority: P0 at the release gate. Outcome: the artifact people install matches
the screenshots, source revision and release claims.

Epic acceptance: R01–R03 are completed with traceable evidence. Integration
branches target `dev`; release promotion is this repository's `dev` → `main`
PR, in line with `CONTRIBUTORS.md` and the main-source policy.

Planning this epic does not authorize immediate tags, package publication,
repository-setting changes or external launch messages.

## R01 — Integrated and package verification

Key: `agent-orchestration:issue-key=yaldi-release-verification`.
Initial status: **Blocked** by O01, O02. Priority: P0. Size: M. Risk: High.

O01 transitively requires the trust foundation and completed Labs; O02 requires
the completed static identity and demo. This is the integration gate for the release.

**Objective:** make release acceptance reproducible from a clean checkout and install.

**Scope:** extend meaningful CI/smoke/package checks for the new boundaries and
record acceptance evidence. Reuse the existing Linux/macOS CI and `make check`
instead of introducing a second verification stack.

**Out of scope:** version-tag creation, registry publication, Homebrew setup,
cloud deployment, or adding tests that merely mirror presentation code.

**Acceptance:**

- `make check` passes, including the existing multi-timezone and report coverage
  where applicable. CI covers Linux and macOS on the candidate changes.
- Integration fixtures cover mixed source capabilities, missing price/attribution,
  source/project URL filters, the three Labs investigations, empty data and exact
  evidence-set/window reconciliation.
- A clean tarball install works without a source checkout or globally installed
  opencodex package. Check version/help, normal empty-data startup, a report dry
  run, demo startup/shutdown and built asset loading.
- Package contents include required runtime assets/demo data and exclude private
  logs, exploration output, test ledgers and machine-local paths. Reference-only
  brand sources are included only if intentionally documented in the manifest.
- Desktop keyboard and light/dark checks cover the new controls; optional Labs
  and hidden-artwork states work. Current supported views retain their behavior.
- An evidence record identifies source commit/tree, commands, platform results,
  inspected UI states and any unresolved findings. Material failures block R02.

**Boundaries:** `.github/workflows/ci.yml`, smoke/CLI/package tests, fixture helpers,
package manifest and a release evidence document under `docs/`.

**Verification:** `make check`, CI receipts for both platforms, tarball file-list
inspection and a clean installed-package exercise with isolated homes.

**Stop conditions:** do not waive a failing data/identity/isolation check to meet
a date. Record platform limitations honestly; do not claim a platform was tested
from the presence of a workflow definition alone.

## R02 — Release-candidate packet

Key: `agent-orchestration:issue-key=yaldi-release-candidate`.
Initial status: **Blocked** by R01. Priority: P0. Size: S. Risk: Medium.

**Objective:** prepare a concrete, internally consistent candidate for publication.

**Scope:** settle the final version/channel choices; update version/changelog,
release notes and install references; produce synthetic screenshots and the
qualified tarball with checksums; prepare release and launch copy. Reconcile the
remaining v0.1.0 launch checklist in
[#7](https://github.com/Collaboration95/yald/issues/7) against existing evidence
without pretending unfinished launch chores were delivered.

**Out of scope:** publishing the candidate, posting launch messages, automatically
closing #7, or promising npm/Homebrew availability before validation.

**Acceptance:**

- The final version is chosen explicitly; package/CLI version, changelog,
  release notes and artifact filename agree. `v0.2.0 — Meet Yaldi` is a proposal,
  not a version already published by this plan.
- Notes explain the three investigations, Yaldi and source/price limitations.
  Screenshots use synthetic data and the actual candidate UI.
- The candidate source commit/tree is recorded. Build, package and clean-install
  checks are rerun for changed version/release inputs; the exact resulting
  artifact's checksum and validation receipts are attached to the packet.
- Release channels and their prerequisites are recorded. A GitHub tarball is
  the baseline; npm and Homebrew remain separately verified distribution work.
- #7 has a proposed evidence-backed reconciliation, and launch posts exist as
  drafts. Existing requirements for explicit external-post authorization remain visible.

**Boundaries:** package version metadata, `CHANGELOG.md`, versioned release notes,
screenshots/social preview, `docs/releasing.md`, `docs/launch-drafts.md`, evidence packet.

**Verification:** compare installed CLI version with artifact metadata; verify
checksums; inspect synthetic screenshots and copy; run the clean-package checks
affected by final candidate changes.

**Stop conditions:** any code or asset change after qualification creates a new
candidate requiring relevant validation. Do not replace bytes while retaining an
old checksum or claim an unverified channel is ready.

## R03 — Promote and publish the qualified artifact

Key: `agent-orchestration:issue-key=yaldi-publish-release`.
Initial status: **Blocked** by R02 and release authorization at execution time.
Priority: P0. Size: S. Risk: High.

**Objective:** make the verified release installable and traceable.

**Scope:** the repository's `dev` → `main` promotion PR, exact release-source
verification, tag/release creation and uploading the tested artifact/checksums.
Execute only the publication channels authorized for that release. Use the
authenticated `gh` CLI for all GitHub access.

**Out of scope:** bypassing branch protection, force-updating tags, repacking
different bytes for each channel, repository-setting changes, or sending launch
messages without explicit instructions.

**Acceptance:**

- The promotion PR comes from this repository's `dev` and satisfies the required
  source policy, Linux/macOS checks, up-to-date branch and resolved conversations.
- The release tag identifies the exact qualified source tree on `main`; record
  the final commit and candidate provenance. Any change to that tree is qualified
  again before publication.
- The GitHub release contains the candidate tarball, its matching checksums,
  accurate notes and the selected version. Verify download/checksum and one clean
  install of those published bytes.
- If npm publication is separately in scope, publish the same verified artifact
  and verify the installed version. Otherwise keep install copy honest about
  the available GitHub distribution.
- Record actual channel URLs, checks and remaining launch chores. Post to other
  communities or change repository settings only when explicitly instructed.

**Boundaries:** GitHub PR/release state, `docs/releasing.md`, the qualified artifact
and release evidence. Link every created/worked PR to the T3 thread when available.

**Verification:** fresh PR/check reads, tag/source-tree comparison, published
artifact checksum and a clean download/install/startup check.

**Stop conditions:** release operations start only once this gate is Ready and
publication is authorized. Respect existing session authorization; do not request
the same approval twice. A mismatched tree/artifact or failed required check
stops publication until corrected.
