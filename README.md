<p align="center">
  <img src="docs/assets/banner.png" alt="Keygate" width="420" />
</p>

<p align="center">
  <strong>Personal AI agent gateway — control your computer and online services via a single "Brain" connected to multiple chat interfaces.</strong>
</p>

<p align="center">
  <a href="https://github.com/puukis/keygate/actions/workflows/publish-npm.yml"><img src="https://github.com/puukis/keygate/actions/workflows/publish-npm.yml/badge.svg" alt="Build" /></a>
  <a href="https://www.npmjs.com/package/@puukis/cli"><img src="https://img.shields.io/npm/v/@puukis/cli?color=cb3837&label=npm" alt="npm" /></a>
  <a href="https://github.com/puukis/keygate"><img src="https://img.shields.io/github/stars/puukis/keygate?style=social" alt="GitHub Stars" /></a>
  <a href="https://github.com/puukis/keygate/blob/main/LICENSE"><img src="https://img.shields.io/github/license/puukis/keygate?color=blue" alt="License" /></a>
  <a href="https://github.com/puukis/keygate/issues"><img src="https://img.shields.io/github/issues/puukis/keygate?color=yellow" alt="Issues" /></a>
  <a href="https://github.com/puukis/keygate/commits/main"><img src="https://img.shields.io/github/last-commit/puukis/keygate?color=green" alt="Last Commit" /></a>
  <img src="https://img.shields.io/node/v/@puukis/cli?color=339933" alt="Node" />
</p>

---

## Documentation

A full docs website now lives in `docs-site/` and is deployable to GitHub Pages.

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

When GitHub Pages is enabled for this repository, `.github/workflows/deploy-docs.yml` publishes the site automatically on `main` changes.

## Features

- **Multi-Channel**: Connect via Web UI (`127.0.0.1:18790`), Discord, Slack, Telegram, or WhatsApp
- **Built-in Remote Gateway Access**: Managed Tailscale tailnet exposure and managed SSH local-forward tunnels, both secured with token-gated operator auth
- **Shared Operator Commands**: `/help`, `/status`, `/model`, `/compact`, `/debug`, `/stop`, `/new`, and `/reset` across chat surfaces, with native Discord slash commands and Slack `/agent*` commands
- **WhatsApp Linked-Device Channel**: QR-based login, DM controls, group allowlists, `👀` acknowledgements, composing presence, and screenshot follow-up delivery
- **DM Pairing Trust Model**: Unknown Slack/Discord/WhatsApp DMs are gated by pairing approvals (configurable open/closed/pairing), with WhatsApp pending requests reviewed locally instead of auto-DMing codes
- **Long-term File Memory Recall**: `memory_search` + `memory_get` tools over `MEMORY.md` and `memory/*.md` with path+line snippets
- **Usage, Token, and Cost Accounting**: turn-level usage persisted in SQLite and exposed through `/status`, the web app, REST, websocket, and CLI
- **ReAct Agent Loop**: Iterative reasoning with tool calling
- **OpenAI Codex OAuth**: Sign in with ChatGPT through Codex CLI/app-server (no API key paste)
- **File-Based Agent Identity**: First-chat bootstrap with persistent `SOUL.md`, `USER.md`, `BOOTSTRAP.md`, and `IDENTITY.md`
- **Security Modes**:
  - 🟢 **Safe Mode** (default): Docker-backed sandbox for filesystem/shell/code tools, command allowlist, human approval required
  - 🔴 **Spicy Mode**: Full host access, unrestricted execution (requires explicit opt-in)
  - 🌶️ **Spicy Max Obedience (optional toggle)**: Spicy-only, best-effort reduction of avoidable refusals
- **Built-in Tools**: Filesystem, Shell, Code Sandbox (JS/Python), Web Search, Browser Automation
- **Brokered Device Nodes**: Paired macOS nodes for `notify`, `location`, `camera`, `screen`, and `shell`, with permission reporting and on-device approval for high-risk actions
- **Gmail Automations**: OAuth login, multiple watches, Pub/Sub push intake, renewal, dedupe, and delivery into normal sessions
- **Deep Runtime Plugin Hooks**: Plugins can hook model resolution, prompt building, tool calls, compaction, session lifecycle, subagents, and gateway startup/shutdown
- **Companion Chat Widget** (macOS): Floating always-on-top mini chat window — keeps the AI assistant visible while you work

## Quick Start

```bash
# One-liner install (Unix)
curl -fsSL https://raw.githubusercontent.com/puukis/keygate/main/scripts/install.sh | bash
```

```bash
# Global npm install (cross-platform)
npm install -g @puukis/cli
```

```bash
# Or clone and run locally
git clone https://github.com/puukis/keygate.git
cd keygate
pnpm install
pnpm dev
```

If `@puukis/cli` is not published yet, `install.sh` falls back to source install/build automatically.

### Codex OAuth Onboarding

```bash
# Full interactive onboarding (provider, auth, safety mode, run now/later)
keygate onboarding

# Install Codex CLI if needed + run ChatGPT OAuth login + select default Codex model
keygate onboard --auth-choice openai-codex

# Login only
keygate auth login --provider openai-codex
```

The `openai-codex` provider delegates auth/token storage to official Codex tooling. Keygate does not store OpenAI OAuth tokens.
`keygate onboarding` now shows an interactive model picker for every provider. OpenAI, Gemini, and Ollama use curated built-in model menus plus a `Custom model ID` option.
When you pick Codex in onboarding, Keygate runs login first, then shows the live Codex model list when available. If Codex model discovery fails or returns nothing, onboarding falls back to a built-in Codex model list instead of skipping the step.
`keygate onboard --auth-choice openai-codex` and `keygate auth login --provider openai-codex` remain auth-first shortcuts that persist the default discovered Codex model.
See smoke test steps in `docs/CODEX_SMOKE_TEST.md`.

### Terminal Chat (Full-Screen TUI)

```bash
keygate tui
```

Inside TUI:
- `/help` shows command help
- `/new` starts a fresh terminal session
- `/exit` or `/quit` leaves TUI
- Multiline prompt mode: type `{` and finish with `}` on its own line

Terminal sessions are persisted and appear in the web UI session list as read-only entries.

### Background Gateway Lifecycle

```bash
# Start Keygate server in background (native OS manager)
keygate gateway open

# Check background server state
keygate gateway status

# Restart background server (close + open)
keygate gateway restart

# Stop background server
keygate gateway close
```

Manager mapping by OS:
- Linux: `systemd --user` (`keygate-gateway.service`)
- macOS: `launchd` user agent (`dev.keygate.gateway`)
- Windows: Task Scheduler task (`KeygateGateway`)

Notes:
- This lifecycle is start/stop-on-demand only (no login/boot auto-start is configured).
- `keygate gateway open` forces `KEYGATE_OPEN_CHAT_ON_START=false` for the managed process, so it will not auto-open a browser tab.

### Remote Gateway Access

Keygate now includes two CLI-managed remote-access paths:

- Tailscale tailnet-only HTTPS exposure on the gateway host
- managed SSH local-forward tunnels on operator machines

The recommended path is Tailscale first, SSH second, ngrok only when you explicitly need a public internet URL.

```bash
# Tailnet-only remote operator access
keygate remote tailscale start
keygate remote tailscale status
keygate remote tailscale url

# Configure and run an SSH local-forward tunnel
keygate remote ssh config --host gateway.example.com --user ops --identity-file ~/.ssh/id_ed25519
keygate remote ssh start
keygate remote ssh status
keygate remote ssh url
```

Operational notes:

- Keygate binds the gateway to `127.0.0.1` by default.
- Starting a managed remote transport automatically enables token-based operator auth if it was still off.
- If no operator token exists yet, Keygate generates one and prints it once during the start command.
- Tailscale exposure stays private to your tailnet.
- The managed SSH tunnel exposes the remote gateway locally on `http://127.0.0.1:28790` by default.
- Webhooks, Gmail push intake, and plugin-route auth keep their existing auth model.

### Ngrok Tunnel (macOS)

Use ngrok when you need a public URL. It is not the recommended default for routine operator access.

```bash
# Start a launchd-managed ngrok tunnel for the local Keygate web server
keygate ngrok start

# Inspect tunnel state and current public URL
keygate ngrok status
keygate ngrok url

# Restart or stop the background tunnel
keygate ngrok restart
keygate ngrok stop
```

Operational notes:

- `keygate ngrok` currently manages a macOS `launchd` user agent only.
- The managed agent label is `com.keygate.ngrok`.
- The tunnel always forwards `http://127.0.0.1:18790`.
- The generated LaunchAgent lives at `~/Library/LaunchAgents/com.keygate.ngrok.plist`.
- Logs are written to `~/.keygate/ngrok.log`.
- Install and authenticate ngrok first (`ngrok config add-authtoken ...`) so the tunnel can establish successfully.

### Runtime Plugins

```bash
# Install from npm, git, a local directory, or a tarball
keygate plugins install @acme/keygate-plugin --scope workspace
keygate plugins install https://github.com/acme/keygate-plugin.git --scope global
keygate plugins install ./path/to/local-plugin --link
keygate plugins install ./keygate-plugin.tgz --scope global

# Inspect installed plugins
keygate plugins list
keygate plugins info <plugin-id>

# Run a plugin-provided CLI command (if the plugin registers one)
keygate <plugin-command> ...
```

Local plugin directories must include a `keygate.plugin.json` manifest and the built `entry` file declared inside it.

Plugin capabilities in this release:

- runtime-loaded tool, RPC, HTTP, CLI, and background service extensions
- ordered runtime hooks for model/tool/session/subagent/gateway lifecycle interception
- JSON Schema validated plugin config
- hot reload with rollback on failure
- full plugin management in the web app Plugins panel

Documentation:

- `docs/PLUGIN_RUNTIME.md`
- `docs/PLUGIN_MANIFEST.md`
- `docs-site/guide/plugins.md`

### Channel Lifecycle and Config

```bash
# Manage web channel (maps to gateway lifecycle)
keygate channels web start
keygate channels web status
keygate channels web config

# Manage discord channel runtime + config
keygate channels discord start
keygate channels discord stop
keygate channels discord restart
keygate channels discord status
keygate channels discord config

# Manage whatsapp linked-device runtime + config
keygate channels whatsapp login --timeout 120
keygate channels whatsapp start
keygate channels whatsapp status
keygate channels whatsapp config
keygate channels whatsapp logout
```

WhatsApp operational notes:

- `keygate channels whatsapp login` opens a linked-device QR flow. No new `.env` entry is required.
- Direct messages follow the same trust model as other external channels: `pairing`, `open`, or `closed`.
- WhatsApp `pairing` is silent by design: review blocked DMs with `keygate pairing pending whatsapp`, then approve explicitly.
- WhatsApp `closed` is allowlist-only: numbers outside `allowFrom` are ignored silently.
- Group chats are controlled separately through `groupMode` (`closed`, `selected`, `open`) plus mention requirements.
- After changing WhatsApp config in the web app, restart the WhatsApp runtime so the new policy is applied.

Native operator commands:

- Discord registers `/help`, `/status`, `/model`, `/compact`, `/debug`, `/stop`, `/new`, and `/reset`
- Slack exposes `/agenthelp`, `/agentstatus`, `/agentmodel`, `/agentcompact`, `/agentdebug`, `/agentstop`, `/agentnew`, and `/agentreset`
- text slash commands continue to work in the web app, TUI, macOS, and other chat surfaces

### Status, Usage, and Debug

```bash
keygate status
keygate status --session web:ops --json
keygate usage --window 7d
keygate usage --session discord:1234567890 --window all
keygate doctor --json
keygate doctor --repair
```

These surfaces now report:

- bind host and port
- remote auth mode
- Tailscale remote-access state
- SSH tunnel profile and runtime state
- provider/model and reasoning state
- session-scoped model overrides
- debug mode state
- turn/token/cost aggregates
- Docker sandbox health
- node online/offline counts
- Gmail watch health

### Docker Sandboxes

```bash
keygate sandbox list
keygate sandbox explain --scope web:ops
keygate sandbox recreate --scope web:ops
```

Safe mode uses Docker for `filesystem`, `shell`, and `sandbox` tool execution. If Docker is missing, Keygate still starts, but safe-mode sandboxed tools fail fast and diagnostics report a degraded posture.

### Gmail Automations

```bash
keygate gmail login
keygate gmail list
keygate gmail send --to you@example.com --subject "Status update" --body "Deployment finished successfully."
keygate gmail watch --account you@example.com --session web:ops --labels INBOX,IMPORTANT
keygate gmail test <watch-id>
keygate gmail renew
```

The web app **Automations** screen now includes:

- scheduler jobs
- signed webhooks
- Gmail accounts and watches

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chat Interfaces                         │
│   ┌─────────────────┐           ┌─────────────────────┐     │
│   │   Web UI        │           │   Discord Bot       │     │
│   │ 127.0.0.1:18790 │           │   !keygate {msg}    │     │
│   └────────┬────────┘           └──────────┬──────────┘     │
│            │                               │                │
│            └───────────────┬───────────────┘                │
│                            ▼                                │
│            ┌───────────────────────────────┐                │
│            │     Normalization Pipeline    │                │
│            └───────────────┬───────────────┘                │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                    Gateway                          │   │
│   │  • Session Management    • Lane Queue (per-session) │   │
│   │  • Security Mode Switch  • SQLite Persistence       │   │
│   └────────────────────────┬────────────────────────────┘   │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                     Brain                           │   │
│   │  ReAct Loop: Reason → Tool → Observe → Respond      │   │
│   │  LLM Providers: OpenAI / Gemini / Ollama / Codex    │   │
│   └────────────────────────┬────────────────────────────┘   │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                  Tool Executor                      │   │
│   │  Safe Mode: Sandbox │ Spicy Mode: Unrestricted      │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

After installation, config is stored at `~/.keygate/` on macOS/Linux and `%USERPROFILE%\.keygate` on Windows.
Existing `~/.config/keygate/` installs are copied into the new home dotdir on first run when `~/.keygate/` is missing, or when `~/.keygate/` only contains bootstrap/cache files and no primary config yet. The old directory is left in place.

Primary files:
- `config.json` - LLM provider, model, security settings
- `config.json` - also stores remote access state (`server.host`, `remote.*`, persisted SSH profile)
- `.env` - API keys and environment overrides

Startup behavior:
- `KEYGATE_OPEN_CHAT_ON_START=true` opens chat UI automatically when `keygate` starts
- `KEYGATE_CHAT_URL=http://127.0.0.1:18790` controls which chat page is opened
- `KEYGATE_SERVER_HOST=127.0.0.1` overrides the bind host without editing `config.json`
- `SPICY_MAX_OBEDIENCE_ENABLED=false` enables a spicy-only max-obedience toggle by default (still best-effort; provider hard blocks can remain)

DM trust + pairing:
- `DISCORD_DM_POLICY=pairing|open|closed` (default: `pairing`)
- `DISCORD_ALLOW_FROM=123,456,*` (optional user id allowlist)
- `SLACK_DM_POLICY=pairing|open|closed` (default: `pairing`)
- `SLACK_ALLOW_FROM=U123,U456,*` (optional user id allowlist)
- WhatsApp structured channel config is stored in `~/.keygate/config.json` under `whatsapp`
- WhatsApp linked-device auth is stored in `~/.keygate/channels/whatsapp/auth/` and must never be committed
- Approve a pairing code from terminal: `keygate pairing approve <discord|slack|whatsapp> <code>`
- Show pending requests: `keygate pairing pending [discord|slack|whatsapp]`

Diagnostics:
- Run comprehensive environment + auth + gateway + routing + sandbox + node + Gmail + plugin checks: `keygate doctor`
- CI-friendly mode (non-zero exit on failures): `keygate doctor --non-interactive`
- Machine-readable diagnostics: `keygate doctor --json`
- Safe automatic repairs: `keygate doctor --repair`

Tool risk engine + approval memory:
- High/medium-risk tool actions are risk-scored before confirmation.
- `allow_always` decisions are persisted with TTL (default 7 days).
- Audit trail is written to `~/.keygate/approvals-audit.jsonl` (or `%USERPROFILE%\.keygate\approvals-audit.jsonl` on Windows).
- Configure TTL with `KEYGATE_APPROVAL_TTL_HOURS`.

Session delegation (sub-agents):
- WebSocket API supports delegated session orchestration:
  - `sessions_spawn` (create delegated child session)
  - `sessions_list` (list delegated sessions)
  - `sessions_history` (fetch bounded message history)
  - `sessions_send` (inject a message into delegated session queue)
  - `subagents` with `list|steer|kill`

Scheduled automation (cron + wakeups):
- Persistent scheduler job store at your Keygate config dir (`scheduler-jobs.json`).
- Drift-resistant scheduler loop executes due jobs and dispatches prompts into target sessions.
- WebSocket API:
  - `scheduler_list`
  - `scheduler_create` (`sessionId`, `cronExpression`, `prompt`, optional `enabled`)
  - `scheduler_update` (`jobId`, optional `cronExpression|prompt|enabled`)
  - `scheduler_delete` (`jobId`)
  - `scheduler_trigger` (`jobId`) for immediate manual execution.
- Cron format: standard 5-field (`minute hour day-of-month month day-of-week`), e.g. `*/15 * * * *`.
- Safety note: scheduler jobs run through the same gateway/session pipeline as normal messages.

Event-driven triggers (signed webhooks):
- Create/list/delete/rotate webhook routes via WebSocket API:
  - `webhook_list`
  - `webhook_create` (`name`, `sessionId`, optional `promptPrefix`, optional `secret`)
  - `webhook_delete` (`routeId`)
  - `webhook_update` (`routeId`, optional `sessionId|promptPrefix|enabled`)
  - `webhook_rotate_secret` (`routeId`)
- Receive webhook events at: `POST /api/webhooks/<routeId>`
- Signature header required: `x-keygate-signature: sha256=<hex-hmac>` using route secret.
- Accepted payloads are routed into target sessions through standard gateway message flow.

Multi-agent/channel routing rules:
- Rules map inbound identities (`channel`, optional `accountId`, `chatId`, `userId`) to an `agentKey`.
- Session isolation format: `<channel>:<agentKey>:<chatId>` (e.g. `discord:ops:123456`).
- Workspace isolation root per routed session: `<WORKSPACE_PATH>/agents/<agentKey>`.
- Routing rule management via WebSocket API:
  - `routing_list`
  - `routing_create` (fields: `scope` as channel or `*`, optional `accountId|chatId|userId`, required `agentKey`)
  - `routing_delete` (`ruleId`)
- Discord/Slack ingress now resolves routing before message processing.

Device node architecture:
- Node pair workflow:
  - `node_pair_request` (`nodeName`, `capabilities[]`)
  - `node_pair_pending`
  - `node_pair_approve` (`requestId`, `pairingCode`)
  - `node_pair_reject` (`requestId`)
- Node registry operations:
  - `node_list`
  - `node_describe` (`nodeId`)
- Invocation API:
  - `node_invoke` (`nodeId`, `capability`, optional `params`, optional `highRiskAck`)
- Capability-aware permission behavior:
  - invocation denied if node untrusted or capability not granted
  - high-risk capabilities (`shell`, `screen`, `camera`) require explicit `highRiskAck=true`
- Current implementation includes a real brokered macOS node runtime inside the companion app:
  - node credentials are paired and persisted locally
  - nodes register and heartbeat over the existing gateway websocket
  - `notify`, `location`, `camera`, `screen`, and `shell` are executed on-device
  - `camera` and `screen` can upload attachments back into the originating session
  - `camera`, `screen`, and `shell` require explicit on-device confirmation before execution

`openai-codex` uses `provider/model` format in config and UI, for example `openai-codex/gpt-5.2`.

On first start, Keygate also initializes continuity files in a device-specific folder under the config dir (default `~/.keygate/workspaces/<device-id>/`), and Safe Mode allows editing these continuity markdown files:
- `SOUL.md` - behavior contract/personality
- `USER.md` - user profile/preferences
- `BOOTSTRAP.md` - first-chat setup guidance
- `IDENTITY.md` - created during first chat when identity is established
- `memory/` - daily memory files (optional)

Keygate also bootstraps local Git repos for managed workspaces so the Git tab works immediately without GitHub:

- the configured root workspace becomes a local repo on `main`
- routed agent workspaces under `agents/<agentKey>/` become their own local repos on first use
- Keygate-created repos get a repo-local author identity of `Keygate Local <keygate@local>`
- managed repos ignore runtime artifact folders such as `.keygate-browser-runs/` and `.keygate-uploads/`
- the root workspace repo also ignores `agents/` so nested agent repos stay isolated
- no remote is configured unless you add one yourself

## Development

```bash
# Install dependencies
pnpm install

# Start all services in dev mode
pnpm dev

# CLI commands (serve/tui/onboarding/onboard/auth/install/gateway/channels)
pnpm keygate --help

# Uninstall current Keygate install (global package/fallback artifacts)
keygate uninstall --yes

# Update current Keygate install (npm/global or github source fallback)
keygate update

# Run tests
pnpm test

# Lint & format
pnpm lint
pnpm format
```

## Docker

Docker files are available in the repository root (`Dockerfile`, `docker-compose.yml`, `.dockerignore`).

See [`docs/DOCKER.md`](docs/DOCKER.md) for setup and usage, including automatic Playwright MCP browser configuration on container startup.

## Security Warning

> ⚠️ **Spicy Mode grants the AI full access to your system.** Only enable this if you understand the risks and are in a sandboxed environment.
>
> ⚠️ **Spicy Max Obedience further increases risk.** It aggressively suppresses avoidable refusals, but cannot override provider-enforced hard blocks.

## License

MIT
