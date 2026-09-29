# Releasing

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
