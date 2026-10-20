# Package qualification evidence

R01 uses the existing `make check` and CI unit/API, three-timezone, report and
synthetic smoke checks. Both required jobs retain their names:
`verify (ubuntu-latest)` and `verify (macos-latest)`. Their source builds check
source behavior; installed checks use only the producer's tarball.

The single `candidate` job builds and packs once. Its Actions artifact is named
`yald-candidate-RUN_ID-PRODUCER_RUN_ATTEMPT`. Both verify jobs download the exact
producer job output name, including on failed-job reruns. Artifacts are retained
for 90 days; the release owner must retain selected evidence before expiry.
No archive is overwritten or rebuilt under an existing identity.

Candidate files:

- `manifest.json`: actual source commit, tree and parents; package name/version,
  byte count, SHA256 and npm integrity; full unpacked file sizes/SHA256; content
  audit; actual producer OS, architecture, Node, Bun, npm and workflow run/attempt.
- `yald-dashboard-VERSION.tgz`: the sole candidate archive.
- `SHA256SUMS` and `npm-pack.json`: checksum and exact npm package file list.

Each `yald-receipt-RUN_ID-VERIFY_RUN_ATTEMPT-OS` artifact contains `receipt.json`,
`demo-receipt.json` and `candidate-manifest.json`. Receipts repeat the actual
tarball hash/version and source identity, producer identity, verifier runtime
versions (including the installed Bun), OS/architecture and results. Compare
the hash, source tree and producer artifact in **both** successful platform
receipts. A workflow definition or a local macOS run is not Linux evidence.

From a clean committed development checkout with dependencies installed:

```sh
make check
for zone in UTC Asia/Singapore America/Los_Angeles; do
  TZ="$zone" scripts/bun test server/src/time
done
node scripts/qualify-package.mjs produce /tmp/yald-candidate-UNIQUE
node scripts/qualify-package.mjs verify /tmp/yald-candidate-UNIQUE /tmp/yald-receipt-UNIQUE
```

Use new empty outside-checkout directories each time. `produce` performs the
fresh build and sole pack. `verify` never packs: it hashes and inspects that
archive, installs it in a fresh prefix containing a space, compares every
installed file before/after, and copies the existing installed-demo verifier
and read guard outside the checkout. Actual HTTP assets are compared against
tarball contents, independently of each platform's source build.

The installed verifier checks version/help/report, normal empty sources with
unavailable pricing, fixed/wall-clock demos with a fake OS opener, exact three
investigation/evidence APIs, assets, sentinel/import isolation, negative controls
and cleanup. Normal unavailable-pricing input is an explicit private package
with no estimator or rates, so a developer's global engine cannot mask it.
No global opencodex package or runtime checkout is required. Full file-list
inspection rejects tests, report samples, ledgers, output, machine-local home
paths and reference-only brand sources; required runtime/user guides and Yaldi
assets remain. Installed relative Markdown links are checked.

The parent evidence record must also name the actual candidate used for native
desktop keyboard, light/dark, source/project URL, all-three case, Labs-disabled
and hidden-artwork checks. Existing unchanged runtime proof may be reused when
package hashes establish equivalence; record the actual packaged-state checks.

This document deliberately contains no checksum or source identity for its own
tree. Immutable identities and actual platform outcomes belong in the uploaded
manifest/receipts and parent PR/issue evidence after the source is committed.
Until those receipts and UI evidence pass, qualification remains incomplete.
Record every unresolved finding there; material data, identity, isolation or
platform failures block R02. The selected release version is now `0.2.0`, with
archive `yald-dashboard-0.2.0.tgz`; the accepted R01 development archive saying
`0.1.0` does not qualify these changed inputs. See the
[0.2.0 candidate packet](release-candidate-v0.2.0.md). Node `>=18` and Bun `^1.4.0`
are declarations, not a claim that every permitted runtime was tested. CI
currently selects Node 22 and Bun latest; receipts record what actually ran.
Version selection, release inputs and requalification belong to R02; promotion,
tags and publication belong to R03.
