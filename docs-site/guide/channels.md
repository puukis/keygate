# Channels

Keygate supports operating from multiple input/output surfaces.

## Channel types

- Web
- Terminal/TUI
- Discord
- Slack
- WhatsApp
- Telegram

## Recommended rollout order

1. Start with web-only
2. Add terminal for local power users
3. Add one external chat channel
4. Validate permissions, rate limits, and moderation expectations
5. Add additional channels only after stable operations

## Discord setup

From the web config drawer you can configure:

- command prefixes
- bot token lifecycle
- token clear/rotation flow

Operational notes:

- keep token secret and never commit it
- the managed CLI startup now attempts to launch the Discord runtime automatically when a token is configured
- native slash commands are registered by the Discord runtime on startup
- Discord voice uses `/voice join`, `/voice leave`, and `/voice status`; see [Channel Actions & Voice](/guide/channel-actions-and-voice)

## Slack setup

Required fields typically include:

- bot token
- app token
- signing secret

Operational notes:

- rotate tokens on membership/security events
- validate event subscriptions and scopes in Slack app config
- the managed CLI startup attempts to launch Slack automatically when both bot and app tokens are present
- native operator commands are exposed as `/agenthelp`, `/agentstatus`, `/agentmodel`, `/agentcompact`, `/agentdebug`, `/agentstop`, `/agentnew`, and `/agentreset`

## WhatsApp setup

WhatsApp uses a linked-device session instead of a static token.

Primary steps:

1. Run `keygate channels whatsapp login`
2. Scan the QR in WhatsApp on your phone
3. Start the runtime with `keygate channels whatsapp start`
4. Configure DM and group policy in the web app

Key settings:

- `dmPolicy`: `pairing`, `open`, or `closed`
- `allowFrom`: explicit E.164 allowlist or `*`
- `groupMode`: `closed`, `selected`, or `open`
- `groupRequireMentionDefault`: default group mention gate
- `groups`: explicit `group:<id>` overrides
- accepted inbound chats get a best-effort `👀` reaction and typing presence while the assistant works

Operational notes:

- structured config lives in `config.json`
- auth state lives in `~/.keygate/channels/whatsapp/auth/`
- the managed CLI startup attempts to launch WhatsApp automatically when the channel config is present
- use `keygate pairing pending whatsapp` to review blocked DMs, then `keygate pairing approve whatsapp <code>` to allow one

## Telegram setup

Telegram uses a static bot token obtained from BotFather.

Primary steps:

1. Create a bot via @BotFather and copy the token
2. Set `TELEGRAM_BOT_TOKEN` in `~/.keygate/.env`
3. Start the runtime with `keygate channels telegram start`
4. Configure DM and group policy in the web app

Key settings:

- `dmPolicy`: `pairing`, `open`, or `closed`
- `groupMode`: `closed`, `open`, or `mention`
- `allowFrom`: comma-separated Telegram numeric user IDs
- `requireMentionDefault`: whether groups require a @mention by default

Operational notes:

- the managed CLI startup attempts to launch Telegram automatically when `TELEGRAM_BOT_TOKEN` is present
- use `keygate pairing approve telegram <code>` for DM pairing approvals
- forum topics in supergroups each get an isolated session automatically
- see the [Telegram guide](/guide/telegram) for webhook mode, streaming, and media details

## Operator commands across channels

Keygate supports a shared operator command set:

- `/help`
- `/status`
- `/model`
- `/compact`
- `/debug`
- `/stop`
- `/new`
- `/reset`

How those commands arrive depends on the channel:

- Web, TUI, macOS companion UI, WhatsApp, and Telegram use text slash commands
- Discord registers native slash commands on bot startup
- Slack uses native `/agent*` slash commands

The command behavior is shared across channels even when the transport differs.

Channel-native actions such as reactions, polls, edits, and thread replies now use a shared registry instead of one-off runtime code. See [Channel Actions & Voice](/guide/channel-actions-and-voice).

Notes:

- `/model` is session-scoped and does not rewrite the global default model
- `/compact` stores a summary and keeps the full transcript in storage
- `/debug on` enables the same session debug buffer visible in the web app

## Channel safety guidance

- Use read-only mirror behavior where appropriate
- Keep high-risk tool execution in controlled sessions
- Audit tool event logs after sensitive workflows
- Prefer DM pairing for external channels unless the bot is intentionally public

## Failure modes to expect

- expired tokens
- missing scopes
- network/webhook interruptions
- malformed channel payloads

When channel errors happen, verify credentials first, then transport, then app logic.
