# Configuration Reference

This page summarizes practical configuration surfaces used in Keygate.

## Primary config files

- `.keygate` – local runtime configuration
- `.keygate.example` – baseline template used for bootstrapping

## Key configuration domains

### Provider and model

- default provider
- model ID
- model-specific settings (e.g., reasoning effort where supported)

### Security and execution

- safe/spicy mode defaults
- confirmation requirements
- command/tool policy boundaries

### Channel credentials

- Discord token + prefixes
- Slack bot token, app token, signing secret

### Browser MCP

- desired version pin
- domain policy (none/allowlist/blocklist)
- allow/block lists
- trace retention

### Scheduler

- per-job schedule
- session target mapping
- enabled/disabled state

## Configuration hygiene

- Never commit secrets
- Keep production and local values separate
- Prefer explicit values over hidden defaults for critical behavior
- Re-test key workflows after changing security/model settings

## Change management checklist

- [ ] Update config in controlled environment
- [ ] Validate connection and model operations
- [ ] Validate one tool execution path
- [ ] Validate channel send/receive for enabled channels
- [ ] Document behavior changes in docs and PR notes
