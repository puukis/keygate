---
name: browser-regression-check
description: Deterministic browser validation workflow using page snapshots and step screenshots. Use when verifying UI behavior, reproducing browser bugs, or checking post-change regressions.
metadata: {"keygate":{"requires":{"config":["browser"]}}}
---
Run browser validation as a deterministic sequence.

1. Capture state with browser snapshot before each action.
2. Execute one browser action at a time.
3. Capture screenshot after each action and compare expected vs observed state.
4. Avoid action batching; keep steps auditable.
5. Report outcome with exact failing step and reproducible sequence.
