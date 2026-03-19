# Installation

This guide covers local development setup and the macOS desktop installer flow.

## Prerequisites

- Node.js **22+**
- pnpm **9+**
- Git
- macOS/Linux/Windows shell

Check versions:

```bash
node -v
pnpm -v
git --version
```

## Clone and install

```bash
git clone https://github.com/puukis/keygate.git
cd keygate
pnpm install
```

## Build and run (dev workflow)

```bash
pnpm build
pnpm dev
```

## Configuration bootstrap

Copy the example file and adjust for your setup:

```bash
cp .keygate.example .keygate
```

Run onboarding:

```bash
pnpm keygate -- onboarding
```

What onboarding does now:

- provider selection is interactive
- OpenAI, Gemini, and Ollama show curated model menus plus a `Custom model ID` option
- Codex runs login first, then shows the live Codex model list when available
- if Codex model discovery fails or returns nothing, onboarding falls back to the built-in Codex model list instead of silently skipping the step

Auth-only flow:

```bash
pnpm onboard
pnpm auth:login
```

`pnpm auth:login` logs into Codex and writes the default discovered Codex model. Use full onboarding when you want to choose the model interactively.

## macOS desktop app and installer

Build local desktop artifacts:

```bash
pnpm macos:app
pnpm macos:dmg
```

Output paths:

- `packages/macos/dist/Keygate.app`
- `packages/macos/dist/Keygate-Installer.dmg`

The DMG uses a drag-to-Applications layout and a custom installer background.

If `pnpm macos:dmg` fails because `create-dmg` is missing:

```bash
brew install create-dmg
```

## Verify installation

- Web UI loads
- Connection status becomes **Connected**
- Sending a message produces streamed output
- Session creation/switching works
- Tool events appear in activity log

## Optional: docs site locally

```bash
pnpm docs:dev
```

## Common install issues

### `pnpm install` fails

- Verify Node major version is 22+
- Delete lockfile/node_modules only if dependency tree is broken
- Retry with clean cache

### Auth provider unavailable

- Re-run `pnpm auth:login`
- Validate provider credentials and environment

### Web app opens but cannot connect

- Check backend process and port
- Check browser console websocket errors

### `address already in use` when starting the gateway

- Another process already owns the configured host/port, usually `127.0.0.1:18790`
- If that is your existing Keygate instance, open the current UI instead of starting a second copy
- Otherwise stop the process using the port or rerun onboarding with a different server port
