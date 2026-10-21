# Explore the synthetic demo

The demo is included in the 0.2.0 package; see [installation](install.md) for
GitHub asset availability. It is absent from the earlier v0.1.0 preview. Run:

```sh
yald demo --open
```

From a [development checkout](install.md#development-checkout), use
`node scripts/yald.mjs demo --open` instead.

Yald listens on `http://127.0.0.1:4318` and opens your browser after its own server is ready. If browser opening is unavailable, use the printed URL. Use `yald demo --port 4320` for a different port. An occupied port fails without opening its existing listener.

The persistent **Demo / synthetic data** label identifies the demo on every page. All usage, projects, session metadata, quota and rates are invented examples. **Prices are illustrative, not live rates**; amounts show API list-price equivalents, not subscription bills or proof of savings. No provider credentials, requests or network pricing are needed. The demo uses Yald's normal ingestion, calculations and exact evidence selectors.

Labs starts enabled in a separate demo preference. Explore **Project Radar** for current/prior project changes, **Cache Detective** for read discounts and write premiums (including zero and unavailable comparisons), **Context Replay** for input sequences with gaps and observed zero, and **Spend spikes** for unusually expensive days and what changed on them. Open each finding's evidence link to inspect its exact source, window and requests. You can disable Labs or hide Yaldi's artwork; the synthetic-data and pricing labels remain visible.

Each launch creates fresh examples relative to the current wall clock, including both 30-day comparison periods. For repeatable screenshots, freeze the sample, API windows and relative UI labels together:

```sh
yald demo --now 2026-10-20T12:00:00Z
```

Use an ISO timestamp with `Z` or an explicit UTC offset. Demo calendar bucketing uses UTC. `yald demo --help` lists the supported options.

Press **Ctrl-C** to stop. Yald waits for its child server to exit, then removes its generated temporary folder, including its synthetic Claude archive. Every source home and pricing input is supplied explicitly before loading the server. Caller `.env` files, credentials, personal source homes, existing Claude archives and global opencodex pricing are outside the demo inputs. Your normal `yald` dashboard and `yald report` keep their usual source behavior. Closing only the browser leaves the local demo running until you stop the command.
