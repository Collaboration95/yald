# Releasing

Repository metadata prepared for the maintainer: description `Read-only analytics dashboard for opencodex usage, cost, and quota`; homepage `https://github.com/Collaboration95/yald`; topics `opencodex`, `llm`, `observability`, `dashboard`, `bun`, `react`, `echarts`, `cost-tracking`; social preview `docs/social-preview.png` (1200×630). Applying these settings is an external repository action and needs maintainer approval.

Discussion setting recommendation: keep Discussions disabled for the first release and revisit after the project has an active support plan. The release notes and launch drafts are ready for review in `release-notes-v0.1.0.md` and `launch-drafts.md`.

1. Update the root `version` and the matching changelog heading.
2. Add the release changes to `CHANGELOG.md` and review the package contents with `npm pack --dry-run`.
3. Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, and `bun run smoke`.
4. Merge the reviewed pull request to `main`; confirm CI is green.
5. Create and push the version tag, for example `git tag v0.1.0 && git push origin v0.1.0`.
6. Confirm the tag workflow is green, then publish with `gh release create v0.1.0 --title "yald 0.1.0" --notes-file docs/release-notes-v0.1.0.md`.
7. Verify the release page, npm tarball contents, and `npx -p yald-dashboard yald` install path.

Publishing a release or making external announcements requires maintainer approval. Keep announcement drafts for review; do not post them as part of routine release preparation.
