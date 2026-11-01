**Yald 0.5.0 · 2026-11-01** — Fewer numbers, more dashboard.

The main pages shrink to what you would act on, and what remains is bigger, livelier and easier to explore. Dollar amounts are API list-price equivalents, not bills.

## Less to read
- Overview, Usage, Cost, Performance, Context, Sessions and Subagents all lose modules. The [changelog](https://github.com/Collaboration95/yald/blob/v0.5.0/CHANGELOG.md) lists each one.
- **Working style** and **Agent turns** moved to Labs, and their old links redirect. Labs is off by default, so turn it on to see them.
- Provider, Effort and Outcome filters moved into **More filters**.

## New ways to explore
- **Usage over time and top models share one pane.** The list is the legend: hover to emphasise, click to isolate.
- **Drag across When you work** to total any weekday and hour range.
- **Daily and running spend** sit together on Cost.
- **Speed by model** is a Codex-only box plot on Performance.

## A livelier dashboard
- Pages have one lead module and an uneven layout.
- Numbers are bigger, metric names are bolder, and tiles show the exact number on hover, focus or tap.
- Session links use real titles and match the theme.
- Small animations run across the controls, and reduced motion turns them off.

## Good to know
- Plan usage now leads Overview, labelled by tool and account. Claude Code plan readings are not included yet.
- API fields and `yald report` are unchanged, and no stored data is touched.

## Install
```sh
npm install -g https://github.com/Collaboration95/yald/releases/download/v0.5.0/yald-dashboard-0.5.0.tgz
yald --open
```
See the [installation guide](https://github.com/Collaboration95/yald/blob/v0.5.0/docs/install.md) for checksum verification.
