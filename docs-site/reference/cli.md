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

## WhatsApp channel commands

```bash
keygate channels whatsapp login [--force] [--timeout 120]
keygate channels whatsapp start
keygate channels whatsapp stop
keygate channels whatsapp restart
keygate channels whatsapp status
keygate channels whatsapp config
keygate channels whatsapp logout
```

## Pairing approvals

```bash
keygate pairing approve whatsapp <code>
keygate pairing pending [whatsapp]
```

## Plugin commands

```bash
keygate plugins list [--json]
keygate plugins info <id> [--json]
keygate plugins install <source> [--scope workspace|global] [--link]
keygate plugins update <id|--all>
keygate plugins remove <id> [--purge]
keygate plugins enable <id>
keygate plugins disable <id>
keygate plugins reload [id]
keygate plugins config get <id>
keygate plugins config set <id> --json '{"key":"value"}'
keygate plugins doctor [--json]
```

Plugins can also reserve their own top-level commands. If the first CLI token is not a built-in Keygate command, the CLI checks enabled plugin manifests for a reserved command name and dispatches to the owning plugin.

## Troubleshooting CLI failures

- verify Node/pnpm versions
- ensure dependencies installed
- check auth state if model commands fail
- inspect package-level errors for workspace misconfiguration
