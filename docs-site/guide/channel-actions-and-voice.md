# Channel Actions and Discord Voice

Keygate now has a shared action layer for channel-native behavior and a manual Discord voice runtime that plugs into the same session model as text channels.

## Shared channel action layer

All outbound channel actions now go through the same registry instead of being implemented ad hoc inside each channel runtime.

That gives you:

- one audit trail in `channel_actions`
- one permission and capability surface
- one set of built-in tools for agent-driven channel actions
- one stream of realtime operator events for the web app and macOS app

Built-in tools:

- `channel_action`
- `channel_poll`
- `channel_react`
- `channel_edit`
- `channel_delete`
- `channel_thread_create`
- `channel_thread_reply`

Operator APIs:

- `GET /api/channel-actions?sessionId=...`
- `POST /api/channel-actions`
- `GET /api/channel-polls?sessionId=...`

## Supported actions by channel

### WebChat

- `send`
- `edit`
- `delete`
- `react`
- `poll`
- `poll-vote`

WebChat polls are fully owned by Keygate, so voting is available in both the guest surface and the operator UI.

### Discord

- `send`
- `read`
- `edit`
- `delete`
- `react`
- `reactions`
- `poll`
- `thread-create`
- `thread-list`
- `thread-reply`

### Slack

- `send`
- `react`
- `edit`
- `delete`
- `thread-reply`

Slack intentionally does not advertise poll support in this release.

### Telegram

- `send`
- `react`
- `edit`
- `delete`
- `poll`
- `topic-create`
- `thread-reply`

### WhatsApp

- `send`
- `react`
- `poll`
- `reply`

## Discord voice

Discord voice is manual by design.

Available slash commands:

- `/voice join`
- `/voice leave`
- `/voice status`

Operational flow:

1. A user runs `/voice join` in the control text channel.
2. Keygate joins the caller's current voice channel.
3. Speaker audio is decoded, segmented, and transcribed.
4. Transcripts are mirrored into the bound text session.
5. Assistant responses are posted into the text session and can be played back through TTS.

## Voice behavior details

- voice sessions are tracked as `voice:session` events
- reconnect and decrypt-failure recovery are handled in the runtime
- the text transcript remains the audit trail
- no auto-join behavior is enabled

The operator web app and macOS app both surface active voice sessions through `GET /api/status`.

## Embedded runtime startup

When the CLI starts the gateway, it now opportunistically starts configured Discord, Slack, Telegram, and WhatsApp runtimes from sibling packages.

Behavior:

- compiled installs load `dist/index.js`
- local `tsx` development can fall back to `src/index.ts`
- one channel failing to start does not abort the gateway
