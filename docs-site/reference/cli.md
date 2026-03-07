# CLI Reference

This page covers the operator-facing `keygate` CLI and the workspace helper scripts used during development.

## Common workspace scripts

```bash
pnpm dev
pnpm build
pnpm test
pnpm docs:dev
pnpm docs:build
pnpm keygate --help
pnpm onboard
pnpm auth:login
pnpm macos:app
pnpm macos:dmg
```

- `pnpm dev`: build core packages and start local development services
- `pnpm build`: compile the publishable workspace packages
- `pnpm test`: run workspace tests
- `pnpm docs:dev`: start the VitePress docs server
- `pnpm docs:build`: build the docs site
- `pnpm keygate --help`: run the CLI entrypoint directly from source
- `pnpm onboard`: shortcut for Codex onboarding
- `pnpm auth:login`: shortcut for `keygate auth login --provider openai-codex`
- `pnpm macos:app`: build `packages/macos/dist/Keygate.app`
- `pnpm macos:dmg`: build `packages/macos/dist/Keygate-Installer.dmg`

## Core runtime commands

```bash
keygate serve
keygate tui
keygate onboarding [--no-prompt] [--defaults] [--no-run]
keygate onboard --auth-choice openai-codex [--device-auth]
keygate auth login --provider openai-codex [--device-auth]
keygate auth logout [--force]
keygate auth status
keygate gateway <open|close|status|restart>
```

Use these for first-time setup, auth, the TUI, and the background gateway lifecycle.

## Health, usage, and repair commands

```bash
keygate doctor [--non-interactive] [--json] [--repair]
keygate status [--session <id>] [--json]
keygate usage [--session <id>] [--window 24h|7d|30d|all] [--json]
keygate sandbox <list|explain|recreate> [--scope <key>] [--workspace <path>] [--json]
```

What each does:

- `keygate doctor`: run environment, auth, Docker sandbox, node, Gmail, channel, and plugin diagnostics
- `keygate doctor --repair`: perform safe repairs such as orphaned sandbox cleanup and due Gmail watch renewal
- `keygate status`: print the current provider/model, security posture, session debug state, usage totals, sandbox health, node health, and Gmail watch health
- `keygate usage`: show turn/token/cost aggregates for a time window
- `keygate sandbox list`: list active Docker sandboxes
- `keygate sandbox explain`: describe the scope, labels, and workspace mapping for one sandbox
- `keygate sandbox recreate`: replace a sandbox container for a given scope

Examples:

```bash
keygate doctor --json
keygate doctor --repair
keygate status --session web:ops --json
keygate usage --window 7d
keygate sandbox explain --scope web:ops
```

## Channel commands

```bash
keygate channels web <start|status|config>
keygate channels discord <start|stop|restart|status|config>
keygate channels slack <start|stop|restart|status|config>
keygate channels whatsapp <login|start|stop|restart|status|config|logout>
```

Notes:

- Discord and Slack runtimes register their native operator commands when the bot starts.
- WhatsApp uses linked-device login instead of static bot credentials.
- The web channel maps to the background gateway lifecycle.

## Pairing commands

```bash
keygate pairing approve <discord|slack|whatsapp> <code>
keygate pairing pending [discord|slack|whatsapp]
```

These approve pending DM trust requests for external chat channels.

## Gmail automation commands

```bash
keygate gmail login [--headless]
keygate gmail list [--json]
keygate gmail watch --session <id> [--account <id|email>] [--labels a,b] [--prompt-prefix text] [--disabled]
keygate gmail update <watchId> [--session <id>] [--labels a,b] [--prompt-prefix text] [--enabled true|false]
keygate gmail delete <watchId>
keygate gmail test <watchId>
keygate gmail renew [--account <id|email>]
```

Typical flow:

```bash
keygate gmail login
keygate gmail list
keygate gmail watch --account you@example.com --session web:ops --labels INBOX,IMPORTANT
keygate gmail test <watchId>
```

## Memory, skills, and plugins

```bash
keygate memory <list|get|set|delete|search|namespaces|clear>
keygate skills <list|doctor|validate|where|install|update|remove|search|info|publish|unpublish|featured>
keygate plugins <list|info|install|update|remove|enable|disable|reload|config|doctor>
```

Plugins can also reserve their own top-level CLI commands. If the first token is not a built-in Keygate command, the CLI checks enabled plugin manifests and dispatches to the matching plugin command.

## Troubleshooting

- Use `keygate doctor` first when startup, model, channel, sandbox, or Gmail flows look wrong.
- Use `keygate status --json` for machine-readable health snapshots.
- Use `keygate sandbox list` if safe-mode filesystem or shell tools stop working.
- Use `keygate gmail list --json` when Gmail watches do not seem to renew or dispatch.
