# Meet Yaldi 0.2.0 candidate packet

Historical preparation record: the hosted Ubuntu/macOS CI workflow and its
required checks were removed on 2026-10-21. CI-based gates below describe the
earlier process. Current verification is [local](releasing.md#check-locally).
Earlier artifacts identify their original source, which predates this removal.

This is the checked-in preparation contract for #70, not a publication receipt.
Final version **0.2.0**, title **Meet Yaldi**, date **2026-10-20**, eventual tag
`v0.2.0`, package `yald-dashboard`, CLI version `0.2.0`, archive
`yald-dashboard-0.2.0.tgz`. The baseline channel is the qualified GitHub tarball;
npm and Homebrew remain **UNVERIFIED** follow-ups.

## Source and qualification

R01 (#69, PR #88) is accepted integration evidence, not the 0.2.0 archive.
Use the existing [qualification commands and receipt schema](release-evidence.md)
and [promotion procedure](releasing.md). Do not introduce a second validation
stack. Run `make check`, the three timezone suites, and
`node scripts/qualify-package.mjs produce ARTIFACT_DIR`, then
`node scripts/qualify-package.mjs verify ARTIFACT_DIR RECEIPT_DIR` from clean
committed source, with fresh directories outside the checkout.

After all source, images and docs are fixed, the release owner records the actual
commit, tree, ordered parents, package SHA256/size/integrity and installed CLI
version in the producer manifest and external evidence. A later doc/image/code
change means a new candidate. These immutable identities cannot be embedded in
the same tree they identify.

Select one new CI `yald-candidate-RUN_ID-PRODUCER_RUN_ATTEMPT` artifact and its
actual artifact ID. It contains `manifest.json`, `npm-pack.json`, `SHA256SUMS`
and the `.tgz`. Retain both successful
`yald-receipt-RUN_ID-VERIFY_RUN_ATTEMPT-OS` artifacts: `receipt.json`,
`demo-receipt.json` and `candidate-manifest.json`. Reconcile matching archive
hash, source identity and producer artifact on Linux and macOS. Record differing
verifier retry attempts explicitly. A local Darwin receipt or a green workflow
definition alone does not satisfy gate D. Retain evidence beyond Actions expiry.

## Release copy and payload

Use [versioned release notes](release-notes-v0.2.0.md) unchanged as the GitHub
release body, titled `Meet Yaldi`. The notes explain both sources, all three
investigations, exact evidence, optional Labs, Yaldi, isolated demo, normal archive
retention and measurement/price limits. Availability is conditional on actual
release assets, so the same copy is readable before and after publication.

The package manifest deliberately includes the notes, this packet, current user
guides and release screenshots. Historical Overview remains for existing
documentation links. Test/fixture data, verifier scripts, reference-only art,
source logs and local receipts remain outside the package. The existing package
audit verifies payload membership and installed relative Markdown links.

## Synthetic screenshots

- [Overview, light](screenshots/meet-yaldi-0.2.0/overview-light.png): both-source
  activity and priced/unpriced coverage. “Cache savings” is the older gross
  read-discount label; Cache Detective supplies the net comparison.
- [Project Radar, light](screenshots/meet-yaldi-0.2.0/project-radar-light.png):
  ranked synthetic projects and the fixed current/prior pair.
- [Cache Detective, dark](screenshots/meet-yaldi-0.2.0/cache-detective-dark.png):
  illustrative write premiums exceed read discounts, with eligibility gaps.
- [Context Replay, dark](screenshots/meet-yaldi-0.2.0/context-replay-dark.png):
  submitted-input sequence with missing input and observed zero.
- [Context evidence, light](screenshots/meet-yaldi-0.2.0/context-evidence-light.png):
  the fixed case, coverage limits and original request metadata.

These are unedited PNG captures of a freshly built, clean-installed **0.2.0**
tarball outside the checkout, using only native T3 preview. Every image shows
Yaldi and **Demo / synthetic data**, with illustrative prices. The first three
use a 1600×1100 CSS desktop viewport; the two longer Context captures use
1600×1700. Native saved PNGs are 1280×880 and 1280×1360 respectively.
They are not development-server images, planning mockups or generated artwork.

Reproduction: commit initial version/copy inputs, run the existing producer and
verifier, then install that archive with normal npm dependency scripts in a new
outside-checkout prefix containing a space. From a separate empty caller home,
run the installed `yald demo --now 2026-10-20T12:00:00Z --port PORT` on an owned
loopback port. The demo supplies isolated source homes and illustrative pricing;
the sample, API windows and UI sample-clock label are fixed together in UTC.
Temporary project path names and refresh-age text can differ between launches.

Use `preview_status`, open a new owned tab with `reuseExistingTab:false`, target
its `tabId` for navigation/interactions/saves, and keep the visible Demo label.
Close the owned tab and signal the owned demo, checking its temporary data and
listener are gone. Keep screenshot PNG hashes, native tab/URL/viewport metadata,
exact capture-package identity, actual runtime versions, fixed clock, served
asset hashes and API/evidence observations in external provenance. In this
capture, 42 served static resources matched the capture archive; the fixed Context
case stayed unchanged when the global toolbar changed to 24h.

Add the PNGs and final documentation, commit the final source, and produce/verify
again. Compare **all 77 runtime/UI file paths and SHA256 values** against the
capture manifest, including server/demo code and raw built HTML, JS, CSS, favicons
and Yaldi assets. Demo-served HTML injects clock metadata, so record its hash and
metadata separately from the raw packaged HTML. Compare PNG hashes too. Carry
this resource comparison forward to the parent's selected CI artifact. Changed
runtime/UI bytes require a new capture; changed payload bytes always require a
new archive/checksum and qualification. The initial capture archive is not the
final candidate.

The local handoff is `/tmp/yald-r02-evidence.md` and
`/tmp/yald-r02-legacy7-reconciliation.md`; the former names the actual final
manifest/receipt/log/provenance locations and unchanged release-body copy.
The parent retains this evidence in PR/issue/release attachments before local
temporary files or Actions artifacts expire. No exact source hash or tarball
checksum is embedded here because adding it would change the identified tree.

## Proposed reconciliation of legacy #7

Fresh authenticated `gh` reads on **2026-10-20** establish the following proposal.
#7 is open with every original checkbox unchecked. This packet does not edit
that issue or retroactively announce a 0.2.0 release.

1. **Repository metadata — open.** Description and homepage are null, topics
   empty. A source `docs/social-preview.png` exists, but upload of a custom
   preview is not established by these reads. No repository setting was changed.
2. **v0.1.0 tag/release/notes/hero — partial.** The
   [public prerelease](https://github.com/Collaboration95/yald/releases/tag/v0.1.0)
   was published 2026-10-02T17:51:17Z. Actual assets are
   `yald-dashboard-0.1.0.tgz` (375031 bytes) and `SHA256SUMS` (91 bytes).
   Its actual notes have three introductory bullets, features, installation and
   known limits, but no embedded hero image. Leave that history intact. New
   0.2.0 copy/screenshots do not complete the old hero requirement retroactively.
3. **CI on main and v0.1.0 tag — evidenced for those identities.**
   [Main run 38163952595](https://github.com/Collaboration95/yald/actions/runs/38163952595)
   and [tag run 37043532279](https://github.com/Collaboration95/yald/actions/runs/37043532279)
   completed successfully, including Linux/macOS jobs. The external reconciliation
   records their actual head SHAs. This is historical evidence, not 0.2.0 CI.
4. **opencodex community draft — prepared, unposted.**
   [Launch drafts](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/launch-drafts.md)
   cover both sources, evidence, synthetic demo, price and archive limits. Parent
   should link the final source revision in #7; no community message is sent.
5. **Launch-post draft with hero — prepared, unposted.** The same document links
   the actual installed Overview and dark investigation images, removes the
   unverified `npx` promise and uses the GitHub package path. Parent may reconcile
   draft preparation after review; external posting requires a separate explicit
   instruction for that destination/post.
6. **Discussions decision — open.** `has_discussions:false` is the observed
   setting, not a recorded maintainer decision. No enablement or decision is
   invented. Community files remain outside scope.

Against #7's acceptance criteria: publication with notes is evidenced as a
prerelease, while its hero requirement is partial; both drafts now exist in the
linked document; this work made no external post. An empty issue comment list
does not establish whether anyone posted elsewhere historically. Parent owns the
proposed reconciliation comment/checklist edits; **leave #7 and #47 open**.

## Promotion and remaining gates

The parent owns GitHub mutations, independent review, CI selection and issue
evidence. #70 is complete only after its PR merges to `dev` and gate D includes
the final matching source tree, screenshots and successful Linux/macOS receipts.
The accepted R01 archive is not reused or relabeled.

Then #71 owns protected `dev` → `main` promotion, final checks, a tag on qualified
`main`, and GitHub publication of the **same selected archive bytes**, checksum,
manifest and separately named successful platform receipts. Prove candidate tree
equals final main/tag tree. Download published assets with `gh`, compare checksum
and bytes with the selected archive, and clean-install those published bytes
using the existing verifier on the recorded candidate source. If the tree
changes, select and qualify a new candidate. Do not infer publication from a tag
or install instructions.

External launch copy remains
[drafts](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/launch-drafts.md).
Legacy #7 receives a proposed item-by-item evidence reconciliation; leave it
open. #47 also remains open. No external post, repository metadata/social-preview
upload, Discussions setting, registry publication or Homebrew setup is part of
this packet. These require their own scope and verification.
