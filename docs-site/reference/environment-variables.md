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

- `PORT`
- `KEYGATE_SERVER_API_TOKEN`

`KEYGATE_SERVER_API_TOKEN` is the operator token used for authenticated plugin HTTP routes and secured remote API access.

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

## Gmail OAuth variables

- `KEYGATE_GMAIL_CLIENT_ID`
- `KEYGATE_GMAIL_AUTHORIZATION_ENDPOINT`
- `KEYGATE_GMAIL_TOKEN_ENDPOINT`
- `KEYGATE_GMAIL_REDIRECT_URI`
- `KEYGATE_GMAIL_REDIRECT_PORT`

Important detail:

- Gmail watch defaults such as `pubsubTopic`, `pushBaseUrl`, `pushPathSecret`, `labelIds`, and `targetSessionId` live in `config.json`, not environment variables.

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
