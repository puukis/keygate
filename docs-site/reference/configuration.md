# Configuration Reference

This page summarizes practical configuration surfaces used in Keygate.

## Primary config files

- `~/.keygate/.env` – local runtime configuration on macOS/Linux
- `%USERPROFILE%\.keygate\.env` – local runtime configuration on Windows
- `.keygate.example` – baseline template used for bootstrapping
- `~/.keygate/config.json` – persisted structured settings such as skills and WhatsApp channel policy
- `~/.keygate/channels/whatsapp/auth/` – linked-device WhatsApp auth state

## Migration from the legacy config root

- Keygate now uses a home dotdir config root: `~/.keygate` on macOS/Linux and `%USERPROFILE%\.keygate` on Windows.
- Legacy installs stored config in `~/.config/keygate` (or the platform-equivalent config directory).
- On first run, Keygate copies the legacy tree into the new root when the new root does not exist, or when it only contains bootstrap/cache files and no primary config yet.
- The legacy `.keygate` filename is still read for compatibility, but new writes use `.env`.
- The old directory is not deleted automatically.

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
- WhatsApp DM policy, allowlist, group policy, and read-receipt settings (stored in `config.json`, not `.keygate`)

Example persisted WhatsApp block:

```json
{
  "whatsapp": {
    "dmPolicy": "pairing",
    "allowFrom": ["+15551234567"],
    "groupMode": "selected",
    "groups": {
      "group:120363025870000000": {
        "requireMention": true
      }
    },
    "groupRequireMentionDefault": true,
    "sendReadReceipts": true
  }
}
```

### Browser MCP

- desired version pin
- domain policy (none/allowlist/blocklist)
- allow/block lists
- trace retention

### Scheduler

- per-job schedule
- session target mapping
- enabled/disabled state

### Plugins

- plugin search roots
- install node manager
- per-plugin enabled flag
- persisted plugin config and env overlays
- `server.apiToken` for authenticated plugin HTTP routes

See the dedicated pages:

- `/reference/plugin-configuration`
- `/reference/plugin-manifest`

## Configuration hygiene

- Never commit secrets
- Never commit the WhatsApp auth directory
- Keep production and local values separate
- Prefer explicit values over hidden defaults for critical behavior
- Re-test key workflows after changing security/model settings

## Change management checklist

- [ ] Update config in controlled environment
- [ ] Validate connection and model operations
- [ ] Validate one tool execution path
- [ ] Validate channel send/receive for enabled channels
- [ ] Document behavior changes in docs and PR notes
