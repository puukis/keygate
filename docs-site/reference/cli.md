# CLI Reference

Keygate exposes primary workflows via CLI scripts.

## Core commands

```bash
pnpm dev
pnpm build
pnpm test
pnpm keygate
pnpm onboard
pnpm auth:login
pnpm macos:app
pnpm macos:dmg
```

## What each does

- `pnpm dev`: starts local development services
- `pnpm build`: compiles packages for production use
- `pnpm test`: runs workspace tests
- `pnpm keygate`: runs CLI entrypoint
- `pnpm onboard`: guided first-time setup
- `pnpm auth:login`: provider authentication update
- `pnpm macos:app`: builds `packages/macos/dist/Keygate.app`
- `pnpm macos:dmg`: builds `packages/macos/dist/Keygate-Installer.dmg`

## Suggested operator workflow

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
```

## Troubleshooting CLI failures

- verify Node/pnpm versions
- ensure dependencies installed
- check auth state if model commands fail
- inspect package-level errors for workspace misconfiguration
