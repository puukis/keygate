---
name: dependency-upgrade
description: Upgrade dependencies with compatibility checks, lockfile hygiene, and rollback safety. Use when updating libraries, patching vulnerabilities, or refreshing toolchains.
metadata: {"keygate":{"requires":{"anyBins":["pnpm","npm","yarn"]}}}
---
Upgrade dependencies with controlled blast radius.

1. Identify target packages and intended version boundaries.
2. Upgrade incrementally and record lockfile deltas.
3. Run compile/tests/lint checks after each batch.
4. Watch for transitive breakage and peer constraint mismatches.
5. Document net effect: updated versions, risks, and fallback path.
