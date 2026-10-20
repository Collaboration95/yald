# Releasing and distribution

## Selected release: 0.2.0 — Meet Yaldi

Version **0.2.0**, title **Meet Yaldi**, date **2026-10-20**, eventual tag
`v0.2.0`. The package is `yald-dashboard`, the executable is `yald`, and the
archive is `yald-dashboard-0.2.0.tgz`. Installed `yald --version` must print
exactly `0.2.0`. The baseline is a qualified **GitHub release tarball**.

Candidate preparation does not publish a release. Confirm actual assets on the
[release page](https://github.com/Collaboration95/yald/releases/tag/v0.2.0).
The earlier [v0.1.0](https://github.com/Collaboration95/yald/releases/tag/v0.1.0)
is a published prerelease, with different contents and bytes. Never relabel it.

See the [candidate packet](release-candidate-v0.2.0.md),
[versioned release body](release-notes-v0.2.0.md),
[installation guide](install.md) and [qualification procedure](release-evidence.md).
Exact source identities, selected artifact IDs and checksums belong in external
receipts after the final source is committed, avoiding a self-referencing tree.

## Qualify one archive

From clean committed source with frozen dependencies installed:

```sh
make check
for zone in UTC Asia/Singapore America/Los_Angeles; do
  TZ="$zone" scripts/bun test server/src/time
done
node scripts/qualify-package.mjs produce /tmp/yald-candidate-UNIQUE
node scripts/qualify-package.mjs verify /tmp/yald-candidate-UNIQUE /tmp/yald-receipt-UNIQUE
```

Use fresh outside-checkout directories. The existing producer builds once and
packs once; the verifier installs those exact bytes into a clean prefix with a
space. It checks the full payload, CLI, report, normal empty sources, unavailable
pricing, fixed/wall-clock demos, exact evidence, assets, isolation and teardown.
Tests, fixtures, source logs, private paths, reference art and verification tools
are excluded from the distribution. Explicitly manifested screenshots and user
documents are intentional payload. Installed relative Markdown links must resolve.

Local macOS evidence alone is insufficient. CI's `candidate` job produces
`yald-candidate-RUN_ID-PRODUCER_RUN_ATTEMPT`. Required
`verify (ubuntu-latest)` and `verify (macos-latest)` jobs install that same
archive. Retain its manifest, npm inventory, SHA256SUMS and both successful
receipt artifacts before the 90-day Actions retention expires. Compare actual
source commit/tree/ordered parents, archive hash/size/version, producer identity,
all installed files and UI resource hashes. Record actual runtimes and platforms;
Node `>=18` is a declaration, not evidence that every allowed version was tested.

Select **one exact producer artifact**, including its ID and attempt. A failed
verifier may retry against the original producer; never silently substitute a
new run's archive. Independent source builds in matrix jobs do not replace it.
A source, documentation or asset change requires a fresh candidate and receipts.

## Promote and publish the selected bytes

Release work merges into `dev`; promotion is this repository's protected
`dev` → `main` pull request. Follow [Contributing](../CONTRIBUTORS.md): required
checks, up-to-date base and resolved conversations, with no direct/force push or
protection bypass. Record the actual promotion commits and prove the final
`main`/tag tree equals the qualified candidate tree. If it changes, requalify.

The release owner downloads the selected producer and its two verifier artifacts
with authenticated `gh`, for example:

```sh
gh run download SELECTED_RUN_ID --repo Collaboration95/yald \
  --name yald-candidate-SELECTED_RUN_ID-PRODUCER_ATTEMPT --dir /tmp/selected-candidate
gh run download SELECTED_RUN_ID --repo Collaboration95/yald \
  --name yald-receipt-SELECTED_RUN_ID-VERIFY_ATTEMPT-Linux --dir /tmp/selected-linux
gh run download SELECTED_RUN_ID --repo Collaboration95/yald \
  --name yald-receipt-SELECTED_RUN_ID-VERIFY_ATTEMPT-macOS --dir /tmp/selected-macos
```

Replace placeholders with actual artifact names (verifier attempts can differ).
Retain successful run/check URLs, IDs and receipt paths in PR/issue evidence.
Attach the exact selected `.tgz`, `SHA256SUMS`, `manifest.json` and separately
named platform receipts to the release. Publish using
`docs/release-notes-v0.2.0.md` unchanged as the body and `Meet Yaldi` as the title.
Tag the qualified `main` commit only after all promotion gates pass.

Download the **published** package and checksums using `gh release download`,
verify SHA256, and compare byte-for-byte with the selected archive. Run the
existing clean-install verifier against those downloaded bytes on their recorded
clean candidate source (the verifier requires exact commit/tree/parents); separately
record equality with the promoted tag tree. A new build from an equal tree is not
the selected archive. Only successful published-download and installed-package
evidence completes publication. CI does not publish releases or packages itself.

## Separate, UNVERIFIED channels

- **npm registry:** no registry availability or `npx` command is promised. Future
  work must establish account/package ownership, authentication and publication
  prerequisites, publish the qualified tarball without repacking, and verify
  registry download integrity and clean installation. The package name remains
  `yald-dashboard`; the command remains `yald`. No registry publication is part
  of this candidate.
- **Homebrew:** no tested formula or available tap is promised. Future work needs
  a separately reviewed tap/formula with the exact release URL/SHA, dependency
  installation, style checks and a real startup/API test on supported systems.
  A template is not distribution evidence. No tap setup is part of this candidate.

External launch posts, social-preview upload, repository metadata and Discussions
settings are separate actions. Launch copy remains in
[drafts](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/launch-drafts.md);
preparing or publishing the release does not authorize posting those drafts.
