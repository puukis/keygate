# Keygate

Personal AI agent gateway - control your computer and online services via a single "Brain" connected to multiple chat interfaces.

## Features

- **Multi-Channel**: Connect via Web UI (`localhost:18790`) or Discord bot
- **ReAct Agent Loop**: Iterative reasoning with tool calling
- **OpenAI Codex OAuth**: Sign in with ChatGPT through Codex CLI/app-server (no API key paste)
- **File-Based Agent Identity**: First-chat bootstrap with persistent `SOUL.md`, `USER.md`, `BOOTSTRAP.md`, and `IDENTITY.md`
- **Security Modes**:
  - 🟢 **Safe Mode** (default): Sandboxed workspace, command allowlist, human approval required
  - 🔴 **Spicy Mode**: Full host access, unrestricted execution (requires explicit opt-in)
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
# Install Codex CLI if needed + run ChatGPT OAuth login + select default Codex model
keygate onboard --auth-choice openai-codex

# Login only
keygate auth login --provider openai-codex
```

The `openai-codex` provider delegates auth/token storage to official Codex tooling. Keygate does not store OpenAI OAuth tokens.
The installers run `keygate auth login --provider openai-codex` immediately when you select the Codex provider.
See smoke test steps in `docs/CODEX_SMOKE_TEST.md`.

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

After installation, config is stored at `~/.config/keygate/`:
- `config.json` - LLM provider, model, security settings
- `.env` - API keys

Startup behavior:
- `KEYGATE_OPEN_CHAT_ON_START=true` opens chat UI automatically when `keygate` starts
- `KEYGATE_CHAT_URL=http://localhost:18790` controls which chat page is opened

`openai-codex` uses `provider/model` format in config and UI, for example `openai-codex/gpt-5.2`.

On first start, Keygate also initializes workspace context files in `WORKSPACE_PATH`:
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

# CLI commands (serve/onboard/auth/install)
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

## License

MIT
