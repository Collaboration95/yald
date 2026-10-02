# Compact desktop shell

Based on dev at `a35c535`. Relay's chart treatment now uses the Bench study's
left navigation structure, inside a centered frame capped at 1,480 px. All eight
tabs remain visible beside the charts; the activity totals sit at the bottom of
the rail. At the same 1,801 px browser width, Overview's first metric row moved
from y=339.91 to y=214.91: 125 px of vertical space reclaimed.

The Yald wordmark gives a brief, gentle wiggle after 1.8 seconds and every 14
seconds thereafter to invite discovery. It expands to `YetAnotherLlmDashboard`
with one of three randomly chosen transitions on hover or keyboard focus; the
wiggle stops during expansion. Its footprint stays fixed and reduced-motion
preferences disable both animations and transitions. The tagline is removed.
Visible and accessible UI copy uses activity, requests, and send accounting in
place of “ledger”. Internal
API names and data formats are unchanged.

Overview uses independent columns and stacks. Usage over time keeps its natural
height instead of stretching to match Cost composition. The leaderboard and
heatmap follow immediately below it; Quota follows the heatmap, and the smaller
side panels follow Cost composition. At the same desktop size, the usage card
shrinks from 568.22 to 396.84 px and the next panels move up 171.38 px. Shared
widget grids also align cards to their natural height.

Leaderboard model names wrap instead of truncating. Token volume and cost have
separate lines, and token share, success, and latency p50 use labeled columns
with larger text and aligned numeric values. Every original value remains.

Browser checks cover all nine pages: 32 charts, 40 summary metrics, 58 sections,
and 14 default tables match the prior interface. Only relative age text,
clock-dependent countdowns, and the renamed Send accounting section were
normalized, along with the intentional Overview section reordering. No horizontal
page overflow or remaining “ledger” UI copy was found.
Search filters survive tab navigation; Refresh and keyboard wordmark expansion
work. Light/dark views and widths of 1,440 and 2,560 px were inspected; the wide
frame remains 1,480 px with equal side margins. No mobile-specific work is included.

Validation: 39 tests / 906 assertions, web/server typechecks, lint, production
build, synthetic smoke checks for all nine pages, and `git diff --check` pass.

All screenshots use the isolated 98-request synthetic fixture. See the initial
[shell verification](verification.json), the current
[modular verification](modular-verification.json), [before](before.png),
[light](after-light.png), [dark](after-dark.png), [leaderboard](leaderboard.png), and
[expanded wordmark](wordmark-hover.png).
