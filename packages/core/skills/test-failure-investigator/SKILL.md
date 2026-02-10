---
name: test-failure-investigator
description: Diagnose failing or flaky tests by classifying signal, reproducing deterministically, and narrowing to root cause. Use for red CI, unstable tests, or local test regressions.
metadata: {"keygate":{"requires":{"anyBins":["pnpm","npm","yarn"]}}}
---
Treat failing tests as evidence, not noise.

1. Reproduce failures with minimal scope.
2. Separate deterministic failures from flakes.
3. Inspect fixture state, timing assumptions, and environment coupling.
4. Identify smallest code path that explains failure.
5. Validate fix with targeted reruns before broad suite reruns.
