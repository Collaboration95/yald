# Releasing

## Distribution status and plan

Checked on 2026-10-03: the public repository has no GitHub releases, and
`npm view yald-dashboard version dist-tags --json` returns E404. The package
manifest is prepared at `0.1.0`, exposes the `yald` command, and builds the UI
during `prepack`. The existing `v0.1.0` changelog entry and release notes are
preparation records, not evidence of a published release. The CI workflow tests
branches, pull requests, and version tags; it does not publish npm packages or
create releases. No Homebrew formula or tap is configured in this repository.

Use npm as the first installation channel, followed by a project-owned Homebrew
tap. Public packages are included in npm's free plan; paid plans are needed for
private npm packages ([npm pricing](https://www.npmjs.com/products)). Homebrew
charges no package listing fee for a tap: anyone can maintain one in a Git
repository ([tap documentation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)).
External hosting or build services can have their own costs.

The release work should proceed in this order:

1. Merge the reviewed dashboard changes through `dev` into `main`. Keep package
   version, tag, release notes, and npm version consistent. `v0.1.0` remains a
   reasonable first public release because no public release has been found.
2. Finalize the changelog and release notes. Fold the current Unreleased entries
   into the first release if these changes ship in it, and restore an empty
   Unreleased section for subsequent work. Later releases move only their own
   entries into a dated version section.
3. Build an npm tarball and inspect its contents. Limit it to the runtime server,
   built UI, launcher, and user documentation; omit design studies, verification
   screenshots, fixtures, and development files. Install the actual tarball in a
   clean temporary directory and test `yald --help`, startup, API health, and
   static assets on supported desktop systems.
4. Publish the first public npm package using a maintainer's npm account, then
   verify the documented install command. Configure a dedicated release workflow
   with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
   later releases, using OIDC instead of a persistent publishing token. That
   workflow needs npm 11.5.1+ and Node 22.14.0+; those are CI requirements and do
   not by themselves change the application's supported Node version.
5. Publish the matching version tag and GitHub release with release notes and
   downloadable artifacts. A GitHub release and an npm publication are separate
   actions; one does not automatically create the other.
6. Create a tap such as `Collaboration95/homebrew-tap`, containing
   `Formula/yald.rb`. Package an immutable versioned artifact with a SHA-256,
   declare its runtime dependencies, and verify a fresh installation before
   announcing the proposed command `brew install Collaboration95/tap/yald`.
   Update the formula's version and checksum for each release. An official
   Homebrew listing can be considered later; it requires maintainer review and
   meeting the [formula acceptance requirements](https://docs.brew.sh/Acceptable-Formulae).

The package's current `files` allowlist includes the entire `docs` and `server`
directories. Tightening that list and verifying the installed tarball are release
tasks still to complete, not checks already performed. npm account ownership and
publishing access must also be established before the first publication.

## v0.1.0 preparation

Repository materials for the first release are prepared for maintainer review:

- [Draft release notes](release-notes-v0.1.0.md): three-bullet overview, feature list, install instructions, known limits, and the [overview hero screenshot](screenshots/overview.png).
- [Launch drafts](launch-drafts.md): a short opencodex community note and a launch post, both with the same hero image reference and install command.
- Proposed repository metadata: description `Read-only analytics dashboard for opencodex usage, cost, and quota`; homepage `https://github.com/Collaboration95/yald`; topics `opencodex`, `llm`, `observability`, `dashboard`, `bun`, `react`, `echarts`, `cost-tracking`; social preview `docs/social-preview.png` (1200×630). These are recommendations; repository settings have not been changed.
- Discussion recommendation: keep Discussions disabled for the first release and revisit when there is an active support plan.

## Release checklist

- [x] Prepare release notes and launch drafts for review; do not post the drafts as part of repository preparation.
- [x] Record proposed repository metadata and a Discussions recommendation; applying settings remains a maintainer action.
- [ ] Confirm CI is green on `main` before tagging.
- [ ] Confirm the package contents with `npm pack --dry-run` and run the release checks: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, and `bun run smoke`.
- [ ] After maintainer go-ahead, merge the reviewed changes to `main` and create and push `v0.1.0`.
- [ ] Confirm the tag workflow is green, then publish the GitHub release using `docs/release-notes-v0.1.0.md`.
- [ ] Verify the release page, npm tarball contents, and `npx -p yald-dashboard yald --open` install path.
- [ ] After separate maintainer approval, make any external announcement.

Release publication, tag creation, repository setting changes, and external announcements are outside this preparation checklist and require maintainer authorization.
