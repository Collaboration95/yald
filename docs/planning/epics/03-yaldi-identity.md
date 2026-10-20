# E3 — Yaldi identity

Parent key: `agent-orchestration:issue-key=yaldi-epic-identity`.
Priority: P1. Outcome: Yald has a recognizable identity that supports its analytics
experience. The approved mascot name is **Yaldi**; the product remains **Yald**.

Epic acceptance: B01–B02 are integrated, production assets are packaged correctly,
small marks remain legible in both themes, and artwork never replaces essential text.

## B01 — Finalize the static Yaldi asset set

Key: `agent-orchestration:issue-key=yaldi-production-assets`.
Initial status: **Ready**. Priority: P1. Size: S. Risk: Low.
Dependencies: the accepted name and visual direction are already available.

**Objective:** turn the accepted exploration into a usable, consistent static identity.

**Scope:** preserve the [original concepts](../../brand/yaldi/README.md); create
production SVG logo variants, a simplified 16 px favicon and 32/48 px icons,
and consistently framed static mascot states. Keep paper/ink/coral styling,
transparent backgrounds and the existing wordmark. Document dimensions, clear
space, light/dark use, provenance and which assets are shipped versus reference-only.

**Out of scope:** renaming Yald, a design-system replacement, an animated pet,
a full animation atlas, external font dependencies, or trademark registration work.

**Acceptance:**

- Logo variants are editable vectors and look intentional at 16, 32 and 48 px;
  the smallest favicon uses a simpler silhouette rather than compressed detail.
- Static investigating, analysing, clue-found and resting artwork has a common
  framing/baseline and an opaque-content/transparent-background distinction.
- The four-pose reference remains labelled as a concept sheet, not ready-made
  animation frames. Original source files and generation provenance remain available.
- Assets have explicit filenames, intrinsic dimensions and theme usage; no
  application asset points outside the repository or to a generated-image home path.
- Browser inspection confirms crisp rendering against both light and dark surfaces.

**Boundaries:** `docs/brand/yaldi/`, a small runtime asset directory chosen to fit
the existing Vite build, and favicon assets. Integration is B02.

**Verification:** render vector variants at target sizes and inspect all static
states on both surfaces; confirm alpha channels and repository-relative references.
No unrelated application test suite is required for asset-only changes.

**Stop conditions:** preserve the accepted robot identity. A proposed new name
or fundamentally different character needs a product decision; routine cleanup
and consistent framing are within the approved direction.

## B02 — Integrate the identity and state artwork

Key: `agent-orchestration:issue-key=yaldi-brand-integration`.
Initial status: **Blocked** by B01, L01. Priority: P1. Size: M. Risk: Medium.

**Objective:** make Yaldi part of the product experience without obstructing data.

**Scope:** wordmark-adjacent mark, favicon, Labs loading/empty/finding artwork,
and matching accessible text. Replace stale opencodex-only product descriptions
where the app now covers both sources. Keep static artwork sufficient for release.

**Out of scope:** a floating assistant, chat interface, looping animation,
mascot-generated claims, or a redesign of the eight existing dashboard pages.

**Acceptance:**

- The product remains named Yald and the companion Yaldi; sidebar, page title,
  CLI/package descriptions and onboarding copy use that distinction consistently.
- Loading, no-data and evidence-backed finding states use the intended artwork,
  preserve layout, and state their meaning in text. An error remains an error,
  not a cheerful clue-found state.
- Decorative duplicates are hidden from assistive technology; meaningful images
  have concise alternatives. Keyboard use and chart legibility are unchanged.
- A compact hide-artwork preference is available; any incidental motion respects
  reduced motion. No animation work is required to pass this issue.
- The built app and installed package load the assets without external paths,
  missing files, network fonts introduced by the brand, or layout shifts.

**Boundaries:** `web/src/components/Wordmark.tsx`, `Layout.tsx`, Labs shared states,
`web/index.html`, runtime assets, preferences and package/CLI descriptions.

**Verification:** `make typecheck`, `make build`, `make smoke`, browser checks in
both themes with artwork enabled/hidden, and static-asset inspection from the build.

**Stop conditions:** if a brand flourish changes chart semantics, hides errors,
or adds a remote service, remove that behavior and retain the static identity.
