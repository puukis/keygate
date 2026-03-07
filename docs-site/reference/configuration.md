# Configuration Reference

Keygate uses a mixed configuration model:

- `.env` for secrets and environment-specific overrides
- `config.json` for structured persisted settings
- runtime stores under `~/.keygate/` for SQLite, OAuth state, sandboxes, webhooks, Gmail watches, and channel auth

## Primary config files

- `~/.keygate/.env` on macOS/Linux
- `%USERPROFILE%\.keygate\.env` on Windows
- `~/.keygate/config.json`
- `~/.keygate/keygate.db`
- `~/.keygate/channels/whatsapp/auth/`
- `~/.keygate/auth/gmail/`
- `~/.keygate/gmail-store.json`

## Migration from the legacy config root

- Keygate now uses `~/.keygate` on macOS/Linux and `%USERPROFILE%\.keygate` on Windows.
- Legacy installs in `~/.config/keygate` are copied forward automatically when the new root is missing or only contains bootstrap/cache files.
- The legacy `.keygate` filename is still read for compatibility, but new writes target `.env`.

## Precedence model

1. Environment variables
2. Persisted `config.json`
3. Built-in defaults

That means you can keep stable defaults in `config.json` and override them in CI, staging, or one-off local shells through `.env`.

## `config.json` structure

Not every field must be present. A typical advanced config looks like this:

```json
{
  "llm": {
    "pricing": {
      "overrides": {
        "openai:gpt-4o": {
          "inputPerMillionUsd": 5,
          "outputPerMillionUsd": 15,
          "cachedInputPerMillionUsd": 2.5
        }
      }
    }
  },
  "security": {
    "sandbox": {
      "backend": "docker",
      "scope": "session",
      "image": "keygate-sandbox:latest",
      "networkAccess": false,
      "degradeWithoutDocker": true
    }
  },
  "gmail": {
    "clientId": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
    "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenEndpoint": "https://oauth2.googleapis.com/token",
    "redirectUri": "http://127.0.0.1:1488/oauth/callback",
    "redirectPort": 1488,
    "defaults": {
      "pubsubTopic": "projects/acme/topics/keygate-gmail",
      "pushBaseUrl": "https://keygate.example.com",
      "pushPathSecret": "replace-me",
      "targetSessionId": "web:ops-inbox",
      "labelIds": ["INBOX"],
      "promptPrefix": "[GMAIL WATCH EVENT]",
      "watchRenewalMinutes": 1320
    }
  },
  "plugins": {
    "entries": {
      "acme-plugin": {
        "enabled": true,
        "env": {
          "ACME_REGION": "eu-central-1"
        },
        "config": {
          "projectId": "demo"
        }
      }
    }
  }
}
```

## Key configuration domains

### Provider and model

Environment-driven defaults:

- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_REASONING_EFFORT`
- `LLM_API_KEY`
- `LLM_OLLAMA_HOST`

Persisted model pricing overrides live under:

```json
{
  "llm": {
    "pricing": {
      "overrides": {
        "<provider>:<model>": {
          "inputPerMillionUsd": 0,
          "outputPerMillionUsd": 0,
          "cachedInputPerMillionUsd": 0
        }
      }
    }
  }
}
```

Use pricing overrides when a provider does not report native cost data or when you want Keygate's estimates to follow your internal billing assumptions.

### Security and sandbox execution

Safe mode routes `filesystem`, `shell`, and `sandbox` tool calls through Docker.

Structured config:

```json
{
  "security": {
    "mode": "safe",
    "spicyModeEnabled": false,
    "spicyMaxObedienceEnabled": false,
    "sandbox": {
      "backend": "docker",
      "scope": "session",
      "image": "keygate-sandbox:latest",
      "networkAccess": false,
      "degradeWithoutDocker": true
    }
  }
}
```

Meaning of the sandbox fields:

- `backend`: currently always `docker`
- `scope`: `session` reuses one sandbox per session, `agent` isolates delegated agents separately
- `image`: Docker image used for safe-mode tool execution
- `networkAccess`: whether sandbox containers get outbound network access
- `degradeWithoutDocker`: when `true`, gateway startup stays non-fatal if Docker is missing, but safe-mode sandboxed tools fail fast and doctor reports a degraded posture

### Server and operator auth

Important server settings:

- `PORT`
- `server.apiToken` or `KEYGATE_SERVER_API_TOKEN`

Set `server.apiToken` when you expose operator-only plugin HTTP routes or remote web/API surfaces.

### Channel credentials and policy

Discord:

- token
- command prefix
- DM policy
- allowlist

Slack:

- bot token
- app token
- signing secret
- DM policy
- allowlist

WhatsApp:

- linked-device auth store
- DM policy
- allowlist
- group mode
- per-group mention rules
- read receipts

Example WhatsApp block:

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

Browser config includes:

- domain policy
- allowlist / blocklist
- trace retention
- Playwright MCP version pin

### Gmail automations

Gmail config is split into two layers:

- OAuth client and redirect settings under `gmail.*`
- watch creation defaults under `gmail.defaults.*`

Useful defaults:

- `pubsubTopic`: required to create watches
- `pushBaseUrl`: public base URL used to build the push callback
- `pushPathSecret`: optional shared secret appended to `/api/gmail/push`
- `targetSessionId`: default session for new watches
- `labelIds`: default Gmail label filters
- `promptPrefix`: default text prepended to Gmail-delivered session messages
- `watchRenewalMinutes`: renewal cadence used before Gmail watch expiration

### Plugins

Plugin config supports:

- plugin search roots
- install node manager
- per-plugin enabled flags
- per-plugin env overlays
- per-plugin JSON config

See:

- `/reference/plugin-sdk`
- `/reference/plugin-configuration`
- `/reference/plugin-manifest`

## Configuration hygiene

- Do not commit `.env`, OAuth token files, `keygate.db`, or `channels/whatsapp/auth/`.
- Keep `server.apiToken` set whenever operator-only HTTP surfaces are exposed.
- Re-run `keygate doctor` after changing sandbox, Gmail, or plugin config.
- Re-test one safe-mode tool call after changing `security.sandbox.*`.
