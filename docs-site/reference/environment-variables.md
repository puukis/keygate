# Environment Variables

Use environment variables for secrets, machine-specific overrides, and CI/runtime-specific behavior.

Keygate reads `.env` from:

- `~/.keygate/.env` on macOS/Linux
- `%USERPROFILE%\.keygate\.env` on Windows

Environment variables override values from `config.json`.

## Model and provider variables

- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_REASONING_EFFORT`
- `LLM_API_KEY`
- `LLM_OLLAMA_HOST`

Use these to choose the default provider/model and to supply provider credentials where required.

## Server and gateway variables

- `KEYGATE_SERVER_HOST`
- `PORT`
- `KEYGATE_SERVER_API_TOKEN`

Remote access notes:

- `KEYGATE_SERVER_HOST` overrides `server.host` and defaults to `127.0.0.1`.
- `KEYGATE_SERVER_API_TOKEN` is the shared operator token used for authenticated plugin HTTP routes and secured remote API access.
- `remote.authMode` does not have its own environment variable in v1. Turn remote operator auth on through `config.json` or by starting `keygate remote tailscale ...` or `keygate remote ssh ...`.

Typical examples:

```dotenv
KEYGATE_SERVER_HOST=127.0.0.1
PORT=18790
KEYGATE_SERVER_API_TOKEN=replace-me
```

## Safe-mode sandbox variables

- `KEYGATE_SANDBOX_SCOPE`
- `KEYGATE_SANDBOX_IMAGE`
- `KEYGATE_SANDBOX_NETWORK_ACCESS`
- `KEYGATE_SANDBOX_DEGRADE_WITHOUT_DOCKER`

These override `security.sandbox.*` from `config.json`.

Typical example:

```dotenv
KEYGATE_SANDBOX_SCOPE=session
KEYGATE_SANDBOX_IMAGE=keygate-sandbox:latest
KEYGATE_SANDBOX_NETWORK_ACCESS=false
KEYGATE_SANDBOX_DEGRADE_WITHOUT_DOCKER=true
```

## Browser MCP variables

- `BROWSER_DOMAIN_POLICY`
- `BROWSER_DOMAIN_ALLOWLIST`
- `BROWSER_DOMAIN_BLOCKLIST`
- `BROWSER_TRACE_RETENTION_DAYS`
- `MCP_PLAYWRIGHT_VERSION`

Use these when you want browser policy or Playwright MCP behavior to vary by machine or environment.

## Channel variables

Discord:

- `DISCORD_TOKEN`
- `DISCORD_DM_POLICY`
- `DISCORD_ALLOW_FROM`

Slack:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_DM_POLICY`
- `SLACK_ALLOW_FROM`

WhatsApp does not use a static auth env variable. Login is handled through a linked-device QR flow and its long-lived auth state is stored under `~/.keygate/channels/whatsapp/auth/`.

Telegram:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_DM_POLICY`
- `TELEGRAM_ALLOW_FROM`
- `TELEGRAM_GROUP_MODE`
- `TELEGRAM_REQUIRE_MENTION_DEFAULT`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_PORT`
- `TELEGRAM_WEBHOOK_PATH`

`TELEGRAM_BOT_TOKEN` is the only required variable. All others default to safe values (`pairing` DM policy, `closed` group mode, long polling).

## Gmail OAuth variables

- `KEYGATE_GMAIL_CLIENT_ID`
- `KEYGATE_GMAIL_CLIENT_SECRET`
- `KEYGATE_GMAIL_AUTHORIZATION_ENDPOINT`
- `KEYGATE_GMAIL_TOKEN_ENDPOINT`
- `KEYGATE_GMAIL_REDIRECT_URI`
- `KEYGATE_GMAIL_REDIRECT_PORT`

Important detail:

- Gmail watch defaults such as `pubsubTopic`, `pushBaseUrl`, `pushPathSecret`, `labelIds`, and `targetSessionId` live in `config.json`, not environment variables.

## Token storage variables

- `KEYGATE_TOKEN_STORE`
- `KEYGATE_DISABLE_KEYCHAIN`

`KEYGATE_TOKEN_STORE` controls where OAuth secrets are stored:

- `auto`: prefer keychain when available, otherwise fall back to file storage
- `keychain`: require secure keychain storage for new logins and new token stores
- `file`: always store tokens in the local Keygate config file

`KEYGATE_DISABLE_KEYCHAIN=true` forces file storage even if `KEYGATE_TOKEN_STORE=keychain`.

Practical behavior:

- Existing file-backed OAuth records continue to work even if `KEYGATE_TOKEN_STORE=keychain` is exported on a machine without working keychain support.
- New logins still fail in `keychain` mode when the OS keychain or `keytar` integration is unavailable, because there is no secure backend to write into.
- If you want portable behavior across headless shells, CI, containers, or Linux desktops without keychain support, set `KEYGATE_TOKEN_STORE=auto` or `KEYGATE_TOKEN_STORE=file`.

## Memory variables

- `KEYGATE_MEMORY_PROVIDER`
- `KEYGATE_MEMORY_MODEL`
- `KEYGATE_MEMORY_VECTOR_WEIGHT`
- `KEYGATE_MEMORY_TEXT_WEIGHT`
- `KEYGATE_MEMORY_MAX_RESULTS`
- `KEYGATE_MEMORY_MIN_SCORE`
- `KEYGATE_MEMORY_AUTO_INDEX`
- `KEYGATE_MEMORY_INDEX_SESSIONS`
- `KEYGATE_MEMORY_TEMPORAL_DECAY`
- `KEYGATE_MEMORY_TEMPORAL_HALF_LIFE`
- `KEYGATE_MEMORY_MMR`

## Plugin loader variables

- `KEYGATE_PLUGINS_WATCH`
- `KEYGATE_PLUGINS_WATCH_DEBOUNCE_MS`
- `KEYGATE_PLUGINS_PATHS`
- `KEYGATE_PLUGINS_NODE_MANAGER`

These affect plugin discovery, hot reload, and install behavior.

## Recommended policy

- Keep `.env` out of source control.
- Prefer `config.json` for stable shared defaults and `.env` for secrets or per-machine overrides.
- Rotate leaked or stale tokens immediately.
- After changing env vars, run `keygate doctor` and at least one real model/tool flow.
