---
name: release-guard
description: Pre-release readiness checks for versioning, manifests, artifacts, and publish safety. Use before tags, npm publish, release CI, or deployment handoff.
metadata: {"keygate":{"requires":{"bins":["git"],"anyBins":["pnpm","npm"]}}}
---
Gate release actions with explicit readiness checks.

1. Verify clean git state and intended branch/tag context.
2. Validate package versions, changelog/release notes, and publish manifests.
3. Confirm build, test, and smoke-check outputs are green.
4. Check credentials/environment preconditions without leaking secrets.
5. Produce a go/no-go summary with exact blockers if any remain.
