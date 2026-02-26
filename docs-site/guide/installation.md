# Installation

This guide covers local development install and practical validation steps.

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

## Build and run

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
pnpm onboard
```

Auth-only flow:

```bash
pnpm auth:login
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
