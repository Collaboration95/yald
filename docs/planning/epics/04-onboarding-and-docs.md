# E4 — First-run experience and docs

Parent key: `agent-orchestration:issue-key=yaldi-epic-onboarding`.
Priority: P1. Outcome: a visitor can understand Yald, install it and try the
investigations without sharing private usage logs.

Epic acceptance: O01–O02 are integrated; documentation matches implemented
behavior and the packaged demo exercises the release's complete first-run story.

## O01 — README and product-copy cleanup

Key: `agent-orchestration:issue-key=yaldi-readme-and-copy`.
Initial status: **Blocked** by F01, F02, F03, B01, L08.
Priority: P1. Size: S. Risk: Low.

**Objective:** make the README a short, accurate route into the product.

**Scope:** lead with Yald's purpose, hero screenshot and one verified installation
path; add a compact source capability matrix, the three investigation questions,
one report example, key limitations and links into detailed docs. Keep source
data locations, local archive behavior and price semantics easy to find.
Retain detailed environment, per-view and report examples in appropriate docs.

**Out of scope:** claiming an unverified npm/Homebrew install, rewriting history
or publishing launch posts. Final versioned release screenshots are R02.

**Acceptance:**

- A new visitor can identify supported sources, prerequisites, the install
  command and how to start Yald without first reading developer Make targets.
- Source capabilities reflect F01, including unavailable Claude timing/failures/
  quota and the distinction between source and provider.
- The first cost explanation says API list-price equivalent, not subscription
  billing. Missing price and attribution coverage are explained with the relevant views.
- “Read-only” means source logs are untouched; Yald's own local Claude archive
  is documented. An empty transcript directory is not advertised as removing
  archived usage. Source filtering is distinguished from archive deletion.
- Internal UI-migration prose and long feature inventories move out of the
  introduction. Detailed existing documentation stays reachable.
- Installation defaults agree across documented entry points. Resolve or clearly
  document the current raw-server 4317 versus launcher 4318 difference.
- Links and examples are valid; the README describes implemented features only.
  The demo command is linked once O02 is integrated, and R01 verifies it.

**Boundaries:** `README.md`, `docs/install.md`, `docs/metrics.md`,
`docs/architecture.md`, a concise feature/report guide if needed, and user-facing
copy that still implies opencodex is the only source.

**Verification:** check local links, render Markdown, and run documented commands
against isolated fixtures. Code changes for default consistency require their
focused launcher checks; prose-only edits do not need new mirrored tests.

**Stop conditions:** if a simplified sentence would overstate source coverage,
retain the qualification. Do not advertise a demo/distribution command until its
implementation and package check pass.

## O02 — Packaged synthetic demo

Key: `agent-orchestration:issue-key=yaldi-packaged-demo`.
Initial status: **Blocked** by B02, L08. Priority: P1. Size: M. Risk: High.

**Objective:** let someone experience the release immediately with safe example data.

**Scope:** a documented `yald demo --open` entry point that uses isolated synthetic
usage, pricing and quota inputs; includes the three investigations and Yaldi;
works from the installed package; and cleans up its own generated data on exit.
Reuse fixture patterns without making the development checkout a runtime dependency.

**Out of scope:** uploading logs, altering normal data homes, switching the real
proxy's pricing configuration, requiring provider credentials, or a hosted demo service.

**Acceptance:**

- A clean installed package can run `yald demo --open`; the default range contains
  meaningful synthetic project, cache and context examples and a clear demo label.
- Demo mode supplies all source homes and pricing inputs explicitly and reads
  no personal opencodex, Claude or Codex files. Sentinel real-home fixtures remain
  unread and unchanged, including a pre-existing Yald Claude archive.
- The sample clock and timestamps produce coherent current/prior windows and
  relative labels. Screenshots can use a deterministic clock without making a
  normal demo appear stale as wall-clock time passes.
- Example rates are labelled synthetic/illustrative and do not modify actual
  model-price overlays. No live provider or network pricing dependency is required.
- Shutdown cleans only demo-owned paths; occupied ports and interrupted startup
  fail clearly without deleting unrelated files or leaving a server running.
- The normal dashboard/report commands keep their data-source behavior.
  CLI help, the package file list and the README's demo link agree.

**Boundaries:** `scripts/yald.mjs`, fixture generation patterns, a packaged demo
module/data location, `package.json` files manifest and installation docs.

**Verification:** focused CLI/isolation/lifecycle tests; build and install a tarball
into a clean directory; run the demo and inspect the three investigations in a
browser. Confirm normal CLI/report help and empty-data startup still work.

**Stop conditions:** a fallback to real user homes, installed global pricing or
private usage examples is a failure, not an acceptable substitute for demo data.
