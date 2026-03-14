# Channel Actions and Discord Voice

This note captures the normalized channel action layer and the Discord voice runtime added to Keygate.

## Channel action registry

- All outbound channel-native work now flows through the shared `ChannelActionRegistry`.
- Results are persisted in `channel_actions`.
- The operator web app and the macOS app both surface recent action history from the same event stream.

Supported action families:

- WebChat: `send`, `edit`, `delete`, `react`, `poll`, `poll-vote`
- Discord: `send`, `read`, `edit`, `delete`, `react`, `reactions`, `poll`, `thread-create`, `thread-list`, `thread-reply`
- Slack: `send`, `react`, `edit`, `delete`, `thread-reply`
- Telegram: `send`, `react`, `edit`, `delete`, `poll`, `topic-create`, `thread-reply`
- WhatsApp: `send`, `react`, `poll`, `reply`

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

## Discord voice

- Discord voice is manual and slash-command driven.
- Supported commands are `/voice join`, `/voice leave`, and `/voice status`.
- Voice sessions are bound to a control text channel/session.
- Incoming speaker audio is segmented, decoded, transcribed, and mirrored into the text session.
- Assistant replies are mirrored into the text channel and can be played back with OpenAI TTS.
- Voice lifecycle events are broadcast as `voice:session` websocket events and included in `GET /api/status`.

## Operational prerequisites

- `DISCORD_TOKEN` must be configured.
- Discord intents must allow guild voice state updates.
- OpenAI media/TTS support is required for the best experience.
- `ffmpeg` and `ffprobe` remain useful local fallbacks for media preprocessing.
