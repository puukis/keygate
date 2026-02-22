<p align="center">
  <img src="docs/assets/banner.png" alt="Keygate" width="800" />
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

## Features

- **Multi-Channel**: Connect via Web UI (`localhost:18790`) or Discord bot
- **ReAct Agent Loop**: Iterative reasoning with tool calling
- **OpenAI Codex OAuth**: Sign in with ChatGPT through Codex CLI/app-server (no API key paste)
- **File-Based Agent Identity**: First-chat bootstrap with persistent `SOUL.md`, `USER.md`, `BOOTSTRAP.md`, and `IDENTITY.md`
- **Security Modes**:
  - 🟢 **Safe Mode** (default): Sandboxed workspace, command allowlist, human approval required
  - 🔴 **Spicy Mode**: Full host access, unrestricted execution (requires explicit opt-in)
  - 🌶️ **Spicy Max Obedience (optional toggle)**: Spicy-only, best-effort reduction of avoidable refusals
- **Built-in Tools**: Filesystem, Shell, Code Sandbox (JS/Python), Web Search, Browser Automation

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
The installers run `keygate onboarding`, which triggers `keygate auth login --provider openai-codex` immediately when you select the Codex provider.
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
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chat Interfaces                         │
│   ┌─────────────────┐           ┌─────────────────────┐     │
│   │   Web UI        │           │   Discord Bot       │     │
│   │ localhost:18790 │           │   !keygate {msg}    │     │
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

After installation, config is stored at `~/.config/keygate/` (or the platform-equivalent config directory):
- `config.json` - LLM provider, model, security settings
- `.keygate` - API keys

Startup behavior:
- `KEYGATE_OPEN_CHAT_ON_START=true` opens chat UI automatically when `keygate` starts
- `KEYGATE_CHAT_URL=http://localhost:18790` controls which chat page is opened
- `SPICY_MAX_OBEDIENCE_ENABLED=false` enables a spicy-only max-obedience toggle by default (still best-effort; provider hard blocks can remain)

`openai-codex` uses `provider/model` format in config and UI, for example `openai-codex/gpt-5.2`.

On first start, Keygate also initializes continuity files in a device-specific folder under the config dir (default `~/.config/keygate/workspaces/<device-id>/`), and Safe Mode allows editing these continuity markdown files:
- `SOUL.md` - behavior contract/personality
- `USER.md` - user profile/preferences
- `BOOTSTRAP.md` - first-chat setup guidance
- `IDENTITY.md` - created during first chat when identity is established
- `memory/` - daily memory files (optional)

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

## Security Warning

> ⚠️ **Spicy Mode grants the AI full access to your system.** Only enable this if you understand the risks and are in a sandboxed environment.
>
> ⚠️ **Spicy Max Obedience further increases risk.** It aggressively suppresses avoidable refusals, but cannot override provider-enforced hard blocks.

## License

MIT
