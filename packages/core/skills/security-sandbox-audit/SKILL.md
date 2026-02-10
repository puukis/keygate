---
name: security-sandbox-audit
description: Audit execution risk between safe and spicy modes, with concrete hardening recommendations. Use when assessing command/tool risk, sandbox policy, or operational safety posture.
metadata: {"keygate":{"always":true}}
---
Evaluate risk by execution path, not by intent language.

1. Identify requested actions that mutate external/public systems.
2. Map each action to required tool, privilege, and confirmation path.
3. Highlight escalation points (shell, filesystem, browser mutations).
4. Recommend least-privilege alternatives where feasible.
5. Summarize residual risk and explicit user-approval boundaries.
