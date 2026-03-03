# Environment Variables

Use environment variables for secrets and environment-specific overrides.

> Note: exact variable names may evolve with runtime changes. Keep this page aligned with `.keygate.example` and core config loaders.

## Typical categories

- Provider credentials/tokens
- Channel credentials (Discord/Slack)
- Plugin runtime and plugin install behavior
- Runtime mode flags
- Network/host/port bindings
- Logging and debug levels

## Plugin environment variables

- `KEYGATE_SERVER_API_TOKEN`
- `KEYGATE_PLUGINS_WATCH`
- `KEYGATE_PLUGINS_WATCH_DEBOUNCE_MS`
- `KEYGATE_PLUGINS_PATHS`
- `KEYGATE_PLUGINS_NODE_MANAGER`

## WhatsApp note

WhatsApp does not require a new `.keygate` environment variable for login.

- Login is done through a linked-device QR flow
- Structured WhatsApp policy is stored in `~/.config/keygate/config.json`
- Linked auth credentials are stored in `~/.config/keygate/channels/whatsapp/auth/`

## Recommended policy

- Store secrets in `.env`/secret manager, not source control
- Use different values per environment (dev/staging/prod)
- Rotate credentials periodically and after personnel changes

## Validation workflow

1. Set/update env vars
2. Start Keygate and verify startup health
3. Run a model request
4. Run one safe tool call
5. Verify channel connectivity (if enabled)

## Security reminders

- Never expose tokens in logs
- Avoid sharing screenshots with visible secrets
- Revoke and reissue leaked credentials immediately
