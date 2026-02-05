# Keygate

Personal AI agent gateway - control your computer and online services via a single "Brain" connected to multiple chat interfaces.

## Features

- **Multi-Channel**: Connect via Web UI (`localhost:18789`) or Discord bot
- **ReAct Agent Loop**: Iterative reasoning with tool calling
- **Security Modes**:
  - 🟢 **Safe Mode** (default): Sandboxed workspace, command allowlist, human approval required
  - 🔴 **Spicy Mode**: Full host access, unrestricted execution (requires explicit opt-in)
- **Built-in Tools**: Filesystem, Shell, Code Sandbox (JS/Python), Web Search, Browser Automation

## Quick Start

```bash
# One-liner install (Unix)
curl -fsSL https://raw.githubusercontent.com/puukis/keygate/main/scripts/install.sh | bash

# Or clone and run locally
git clone https://github.com/puukis/keygate.git
cd keygate
pnpm install
pnpm dev
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chat Interfaces                         │
│   ┌─────────────────┐           ┌─────────────────────┐    │
│   │   Web UI        │           │   Discord Bot       │    │
│   │ localhost:18789 │           │   !keygate {msg}    │    │
│   └────────┬────────┘           └──────────┬──────────┘    │
│            │                               │                │
│            └───────────────┬───────────────┘                │
│                            ▼                                │
│            ┌───────────────────────────────┐                │
│            │     Normalization Pipeline    │                │
│            └───────────────┬───────────────┘                │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                    Gateway                           │  │
│   │  • Session Management    • Lane Queue (per-session) │  │
│   │  • Security Mode Switch  • SQLite Persistence       │  │
│   └────────────────────────┬────────────────────────────┘  │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                     Brain                            │  │
│   │  ReAct Loop: Reason → Tool → Observe → Respond      │  │
│   │  LLM Providers: OpenAI / Gemini                     │  │
│   └────────────────────────┬────────────────────────────┘  │
│                            ▼                                │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                  Tool Executor                       │  │
│   │  Safe Mode: Sandbox │ Spicy Mode: Unrestricted      │  │
│   └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

After installation, config is stored at `~/.config/keygate/`:
- `config.json` - LLM provider, model, security settings
- `.env` - API keys

## Development

```bash
# Install dependencies
pnpm install

# Start all services in dev mode
pnpm dev

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
