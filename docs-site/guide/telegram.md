# Telegram

Keygate can run a Telegram bot using the grammY library. The bot supports private DMs, group chats, and Telegram forum topics, with the same operator command set available on every other channel.

## What the feature includes

- Long polling by default, webhook mode when `TELEGRAM_WEBHOOK_URL` is set
- DM policy controls (`pairing`, `open`, `closed`)
- Allow-from list for trusted user IDs
- Group policy controls (`closed`, `open`, `mention`)
- Mention-gating for group traffic
- Forum topic isolation — each topic in a supergroup gets its own session
- Inbound media ingestion for photos, documents, voice, video, and stickers
- Streaming replies via edit-in-place message updates
- Inline keyboard confirmations for tool approval prompts
- Operator slash commands via `/help`, `/status`, `/model`, `/compact`, `/debug`, `/stop`, `/new`, `/reset`, `/inspect`

## Bot setup

Before running the bot you need a Telegram bot token from BotFather.

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the token BotFather provides (format: `123456789:ABC-DEF...`)

Add the token to your Keygate env file:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
```

## Runtime lifecycle

```bash
keygate channels telegram start
keygate channels telegram stop
keygate channels telegram restart
keygate channels telegram status
keygate channels telegram config
```

`start` fails fast if `TELEGRAM_BOT_TOKEN` is not set.

`config` prints the active policy settings without starting the runtime.

## DM policy modes

- `pairing`: unknown senders receive a pairing code and stay blocked until approved
- `open`: any sender can start a DM session
- `closed`: all DMs are silently ignored

Set via env var:

```dotenv
TELEGRAM_DM_POLICY=pairing
```

Allow-from entries are comma-separated Telegram numeric user IDs:

```dotenv
TELEGRAM_ALLOW_FROM=123456789,987654321
```

## Pairing approvals

When a sender hits a `pairing` policy, the bot replies with a code and instructs them to wait for operator approval. Run:

```bash
keygate pairing approve telegram <code>
```

List pending requests:

```bash
keygate pairing pending telegram
```

## Group policy modes

`TELEGRAM_GROUP_MODE` controls whether group messages are processed at all:

- `closed`: ignore all group messages (default)
- `open`: respond to every message in allowed groups
- `mention`: only respond when the bot is @mentioned

Set via env var:

```dotenv
TELEGRAM_GROUP_MODE=mention
```

By default, mention gating is active. To disable it and respond to all messages even without a mention when in `open` mode:

```dotenv
TELEGRAM_REQUIRE_MENTION_DEFAULT=false
```

## Forum topic support

When the bot is in a Telegram supergroup with Topics enabled, each topic gets an isolated session. Messages in topic A and topic B produce entirely separate conversation histories. No extra configuration is required — topic detection is automatic.

## Web UI configuration

Open the **Config** drawer and scroll to the **Telegram Bot** section:

- Paste the bot token in the **Bot Token** field
- Select a **DM Policy**
- Select a **Group Mode**
- Click **Save Telegram Config**
- Restart the runtime to apply changes:

```bash
keygate channels telegram restart
```

## Webhook mode

By default the bot uses long polling. For production or server environments you can switch to webhook mode:

```dotenv
TELEGRAM_WEBHOOK_URL=https://example.com
TELEGRAM_WEBHOOK_PORT=8787
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
```

When `TELEGRAM_WEBHOOK_URL` is set, the bot registers the webhook with Telegram on startup and starts an HTTP listener at the configured port and path.

## Media handling

Inbound media support:

- photos (highest-resolution variant)
- documents
- voice notes
- video
- stickers

Accepted media is downloaded from Telegram's file API, stored in the workspace attachment area, and attached to the normalized session message so the agent can read it.

## Streaming replies

Long responses are sent as a single message that gets edited in place as the agent produces output. Edits are throttled to roughly one per second to stay within Telegram's rate limits. When a response exceeds the 4000-character limit it overflows into additional messages.

If Telegram rejects the edit-in-place update, Keygate falls back to sending the completed response as a normal message so the final answer is still delivered instead of disappearing after the typing indicator stops.

If a tool approval prompt appears in the middle of a streamed response, Keygate stops editing the older assistant message and resumes in a fresh message underneath the confirmation prompt after you approve or cancel it. That keeps the prompt and the follow-up outcome in chronological order.

## Operator commands

The Telegram bot registers these native slash commands with BotFather on startup:

| Command | Effect |
|---------|--------|
| `/help` | Print the help text |
| `/status` | Show the current provider, model, and security posture |
| `/model` | List available models or switch models |
| `/compact` | Summarize and compact the session history |
| `/debug` | Toggle session debug output |
| `/stop` | Cancel the currently running agent turn immediately |
| `/new` | Start a new session |
| `/reset` | Hard-reset the session and clear history |
| `/inspect` | Show session metadata |

## Confirmation prompts

When the agent requires tool approval, the bot sends an inline keyboard message with three buttons:

- **Allow once** — approve this specific invocation
- **Allow always** — approve this command permanently for this session
- **Cancel** — deny and cancel the pending tool call

After you tap a button, Telegram shows a short acknowledgement toast and the keyboard is cleared so the same approval prompt cannot be tapped repeatedly.

Any follow-up assistant output for that same turn is posted beneath the prompt instead of rewriting the earlier in-progress message above it.

The `/stop` command is handled out of band for Telegram sessions, so it cancels the active turn immediately instead of waiting for the current streamed response to finish first.

Unanswered confirmations time out after 60 seconds and resolve as cancelled.

## Config changes and restarts

Policy changes made via the web UI or env vars are applied the next time the runtime starts. Restart after any config change:

```bash
keygate channels telegram restart
```

When you run Telegram from a local repository checkout instead of an installed package, Keygate now refreshes the `@puukis/core` build before the runtime starts. That keeps Gmail, approval, and other core fixes from getting stuck in stale `dist` output while Telegram is running from source.

## Common failure modes

- `TELEGRAM_BOT_TOKEN` not set: runtime refuses to start
- Bot not responding in DMs with `pairing` policy: check `keygate pairing pending telegram` and approve the code
- Bot not responding in groups with `mention` mode: include `@yourbotname` in the message
- Webhook not receiving updates: verify the public URL is reachable from Telegram's servers and the path and port match
- Streaming messages stop updating: Telegram's edit rate limit was exceeded; the final response is still delivered
- Approval button appears to do nothing: confirm the Telegram runtime is current, then retry once; successful taps now show an acknowledgement toast and remove the buttons

## Privacy and security

- Do not commit `TELEGRAM_BOT_TOKEN` to source control
- Use `pairing` or `closed` for DMs unless the bot is intentionally public
- Keep `TELEGRAM_GROUP_MODE=closed` unless you have moderation controls in place for group access
- Rotate the bot token from BotFather if it is ever leaked
