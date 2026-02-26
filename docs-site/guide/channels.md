# Channels

Keygate supports operating from multiple input/output surfaces.

## Channel types

- Web (primary control interface)
- Terminal/TUI
- Discord
- Slack

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
- restart channel process after token/prefix changes

## Slack setup

Required fields typically include:

- bot token
- app token
- signing secret

Operational notes:

- rotate tokens on membership/security events
- validate event subscriptions and scopes in Slack app config

## Channel safety guidance

- Use read-only mirror behavior where appropriate
- Keep high-risk tool execution in controlled sessions
- Audit tool event logs after sensitive workflows

## Failure modes to expect

- expired tokens
- missing scopes
- network/webhook interruptions
- malformed channel payloads

When channel errors happen, verify credentials first, then transport, then app logic.
