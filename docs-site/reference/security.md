# Security

Keygate is designed around layered controls rather than a single trust toggle.

## Security modes

### Safe mode

Safe mode is the default and should stay the default for normal use.

In safe mode:

- sensitive actions can require approval
- `filesystem`, `shell`, and `sandbox` tools run through Docker-backed containers
- the workspace mount is restricted to the configured Keygate workspace
- Docker health is surfaced in `/status`, the web app, and `keygate doctor`

### Spicy mode

Spicy mode bypasses the Docker sandbox and executes on the host. It exists for expert users who intentionally accept the larger blast radius.

Use spicy mode only when:

- you understand the host access implications
- the workspace is disposable or tightly controlled
- you do not need safe-mode guardrails for that session

## Docker-backed safe mode

Safe mode depends on Docker for sandboxed execution.

Important behavior:

- gateway startup is still allowed when Docker is missing
- that state is considered degraded, not healthy
- safe-mode sandboxed tool calls fail fast with a remediation message
- `keygate doctor` reports Docker sandbox health as a failing check

Relevant config:

- `security.sandbox.scope`
- `security.sandbox.image`
- `security.sandbox.networkAccess`
- `security.sandbox.degradeWithoutDocker`

## Approval model

Keygate still asks for approval for risky actions even in safe mode.

Approve only after checking:

- the command or action summary
- the path or workspace target
- whether the action belongs in the current session

## Device-node trust model

Paired device nodes are another security boundary.

Current macOS node protections include:

- explicit node pairing and approval
- declared capability list
- per-capability permission reporting
- online/offline tracking
- explicit local confirmation for `camera`, `screen`, and `shell`

Node invocations are denied when:

- the node is offline
- the capability is not paired
- a macOS permission is missing
- the local approval prompt is denied

## External channel trust model

Discord, Slack, and WhatsApp DMs can be gated by pairing:

- `pairing`
- `open`
- `closed`

Pairing is the safest default for external inbound traffic. Use allowlists when you need a smaller trusted set.

## Operator auth and remote surfaces

Set `server.apiToken` or `KEYGATE_SERVER_API_TOKEN` when any operator-only HTTP surface is exposed.

That token is especially important for:

- plugin HTTP routes using `auth: "operator"`
- remote deployments
- multi-user or team-operated environments

The doctor command warns when operator auth is missing in situations that expose risk.

## Gmail push security

Gmail push intake can be hardened with two layers:

- an optional `gmail.defaults.pushPathSecret` query secret
- Google OIDC bearer token verification on incoming push requests

Use both when Keygate is reachable from the public internet.

## Browser policy hardening

If browser MCP is enabled:

- prefer `allowlist` over `none`
- keep traces only as long as operationally necessary
- review artifact retention when handling sensitive websites

## Session isolation

Sessions are an important security primitive.

Good practice:

- keep prod, personal, and experimental work in different sessions
- keep automation sessions narrow and dedicated
- use `/compact` to keep long-running automation sessions stable without deleting the full transcript

## Operational checklist

- [ ] safe mode is the default
- [ ] Docker is installed and healthy on safe-mode hosts
- [ ] `server.apiToken` is configured for remote/operator setups
- [ ] external DM policy is `pairing` unless there is a strong reason otherwise
- [ ] high-risk node capabilities are enabled only where needed
- [ ] Gmail push uses a secret and public URL only when required
- [ ] `keygate doctor` is part of routine verification
