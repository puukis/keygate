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
keygate remote tailscale <start|stop|status|restart|url>
keygate remote ssh config --host <host> [--user <user>] [--port <port>] [--local-port <port>] [--remote-port <port>] [--identity-file <path>]
keygate remote ssh <start|stop|status|restart|url>
keygate ngrok <start|stop|status|restart|url>
```

Use these for first-time setup, auth, the TUI, the background gateway lifecycle, private remote access, and the macOS ngrok tunnel helper.

Notes:

- `keygate gateway` manages the Keygate server background process.
- `keygate remote tailscale` manages tailnet-only HTTPS access to the local gateway.
- `keygate remote ssh` manages a persisted SSH local-forward tunnel and exposes the remote gateway locally on `http://127.0.0.1:28790` by default.
- `keygate ngrok` manages a macOS LaunchAgent named `com.keygate.ngrok` that forwards `http://127.0.0.1:18790`.
- `keygate ngrok url` prints only the current public URL.

Examples:

```bash
keygate gateway open
keygate remote tailscale start
keygate remote ssh config --host gateway.example.com --user ops
keygate remote ssh start
keygate ngrok start
keygate ngrok status
keygate ngrok url
```

## Health, usage, and repair commands

```bash
keygate doctor [--non-interactive] [--json] [--repair]
keygate status [--session <id>] [--json]
keygate usage [--session <id>] [--window 24h|7d|30d|all] [--json]
keygate sandbox <list|explain|recreate> [--scope <key>] [--workspace <path>] [--json]
```

What each does:

- `keygate doctor`: run environment, auth, Docker sandbox, node, Gmail, remote access, channel, and plugin diagnostics
- `keygate doctor --repair`: perform safe repairs such as orphaned sandbox cleanup and due Gmail watch renewal
- `keygate status`: print the current bind host, remote auth mode, remote transport state, provider/model, security posture, session debug state, usage totals, sandbox health, node health, and Gmail watch health
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
keygate channels telegram <start|stop|restart|status|config>
```

Notes:

- Discord, Slack, and Telegram runtimes register their native operator commands when the bot starts.
- WhatsApp uses linked-device login instead of static bot credentials.
- Telegram requires `TELEGRAM_BOT_TOKEN` to be set before starting.
- The web channel maps to the background gateway lifecycle.

## Pairing commands

```bash
keygate pairing approve <discord|slack|whatsapp|telegram> <code>
keygate pairing pending [discord|slack|whatsapp|telegram]
```

These approve pending DM trust requests for external chat channels.

## Gmail automation commands

```bash
keygate gmail login [--headless]
keygate gmail list [--json]
keygate gmail send --to <email> --subject <text> --body <text> [--account <id|email>] [--reply-to <messageId>] [--thread <threadId>]
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
keygate gmail send --to team@example.com --subject "Status update" --body "Deployed successfully."
keygate gmail watch --account you@example.com --session web:ops --labels INBOX,IMPORTANT
keygate gmail test <watchId>
```

`keygate gmail send` reports that Gmail accepted the message and returns the Gmail message id. Remote delivery to the recipient inbox can still be delayed, filtered to spam, or rejected later by the destination provider.

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
