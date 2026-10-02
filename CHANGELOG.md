# Changelog

All notable changes to yald are recorded here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. It stays on 0.x while the upstream opencodex ledger shape can change; 1.0 requires a stable ledger contract and published metric definitions.

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added

- Read-only dashboard over opencodex usage, spend, and quota ledgers, with eight analytics views.
- Pricing parity with `ocx usage`, fixture-based smoke coverage, metric and API documentation, and an installable CLI.
- Initial project work tracked by [issues #1](https://github.com/Collaboration95/yald/issues/1), [#2](https://github.com/Collaboration95/yald/issues/2), [#3](https://github.com/Collaboration95/yald/issues/3), [#4](https://github.com/Collaboration95/yald/issues/4), [#5](https://github.com/Collaboration95/yald/issues/5), [#6](https://github.com/Collaboration95/yald/issues/6), [#7](https://github.com/Collaboration95/yald/issues/7), and [#8](https://github.com/Collaboration95/yald/issues/8).
- CLI version reporting with `yald --version`.

### Changed

- Product identity is yald; opencodex remains the data source.
- Adopt Relay's paper surfaces, ink and coral charts, and consistent model colors across all eight analytics views and conversation detail, in light and dark themes.
- Center the desktop dashboard within a 1,480 px frame and move the eight navigation tabs into a left rail.
- Let Overview widgets keep their natural heights, with independent columns that bring the following panels directly beneath their content.
- Separate model leaderboard token volume and cost, label token share, success rate, and latency p50, and wrap long model names.
- Give Yald a brief periodic wiggle and expand it to `YetAnotherLlmDashboard` on hover or keyboard focus with a randomly selected transition; respect reduced-motion preferences.

### Removed

- Remove the “Your work, in view” tagline and replace “ledger” wording in the interface with activity and send accounting.

### Fixed

- Reuse unchanged usage snapshots during refresh and invalidate pricing overlays when their inputs change, retaining API data and freshness semantics.
- Exclude tests and design-verification files from the distribution package; include the prebuilt dashboard and the `yald` launcher.
