# Security

Security in Keygate is about reducing blast radius while keeping useful autonomy.

## Security modes

### Safe mode (recommended default)

- conservative behavior
- explicit confirmations for sensitive actions
- lower risk for day-to-day usage

### Spicy mode (advanced)

- expanded autonomy and execution freedom
- intended for expert users with clear trust boundaries
- should be intentionally enabled, not casually left on

## Approval model

Sensitive actions can trigger a confirmation request.

Operational best practices:

- read the action summary before approving
- verify command/path targets
- deny and refine prompt when scope is unclear

## Secrets handling

- keep tokens out of git
- rotate on incident or team membership changes
- prefer short-lived credentials where possible

## Browser policy hardening

If browser MCP is enabled:

- use allowlist policy for production-like environments
- keep blocklist maintained if allowlist is too restrictive
- review traces/artifacts retention period for compliance

## Session isolation as a security primitive

Treat sessions as compartments:

- separate exploratory tasks from critical operations
- avoid mixing unrelated privileged workflows in one session

## Security checklist for production-minded use

- [ ] safe mode is default
- [ ] credentials stored securely
- [ ] channel tokens have minimum required scopes
- [ ] browser domain policy configured
- [ ] tool approvals reviewed regularly
- [ ] logs reviewed for abnormal behavior

## Incident response starter plan

1. Disable risky mode/features
2. Rotate impacted tokens
3. Preserve relevant logs/artifacts
4. Reproduce issue in isolated session
5. Patch and verify with tests
6. Document postmortem and prevention steps
