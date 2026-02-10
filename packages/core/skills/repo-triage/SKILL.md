---
name: repo-triage
description: Rapid repository diagnosis workflow for broken builds, failing commands, or unclear project state. Use when the user asks to debug project health, identify blockers, or isolate failure layers.
metadata: {"keygate":{"requires":{"bins":["git"]}}}
---
Inspect repository state before proposing changes.

1. Capture baseline quickly: git status, branch, recent commits, and workspace layout.
2. Reproduce reported failure with the smallest command that surfaces the issue.
3. Classify failure layer: environment, dependency, compile, test, runtime, or integration.
4. Isolate one root cause at a time and keep hypotheses explicit.
5. Prefer deterministic checks and summarize findings with direct next actions.
