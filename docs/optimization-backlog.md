# Deferred performance experiments

Saved on 2026-10-02 during UI design exploration. Implement
neither these experiments nor benchmark instrumentation during the design work.

After choosing a design, freeze its complete, correct implementation as the
baseline. Compare that baseline against the same UI with one optimization at a
time; do not attribute a redesign's timing difference to an optimization.

- First try overlapping the existing lazy ECharts import with route/data loading.
- Evaluate an ECharts SSR SVG for the first accurate chart, followed by the normal
  interactive chart. Measure first accurate visual and interactive readiness
  separately, including extra requests, rendering work, and handoff correctness.
- Profile refresh before considering per-file snapshot reuse or incremental
  JSONL reads. Preserve rotation, truncation, partial-line, and pricing invalidation.
- Consider a long-lived Bun worker only if profiling shows CPU work blocking
  concurrent requests. Account for its experimental API, memory, serialization,
  queueing, crash recovery, and a direct fallback.

Existing route splitting, selected ECharts imports, ETags, unchanged-file reuse,
and hidden-tab polling suppression are already implemented, not new achievements.

Before/after evidence must use production builds, identical fixtures, filters,
viewport, timezone, pricing, and cache policy. Record cold load, warm reload,
navigation, and complete refresh separately. Readiness requires the right data
and finished plots, not a heading or an empty canvas. Use balanced repeated runs
(at least 50 samples per primary case), p50/p95, failures, raw samples, and
screenshots/traces. Retain regressions and inconclusive results. Publish a claim
only after the improvement repeats outside measurement noise.

Relay has been chosen as the production design. Capture its verified commit as
the baseline for a separate, stacked performance PR. Earlier discovery timings
are not validated before/after performance gains.
