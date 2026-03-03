# Architecture

Keygate is structured as a workspace of focused packages.

## Package layout

- `packages/core` – runtime, orchestration, tools, scheduler, policy/security logic
- `packages/web` – browser control UI and session operations
- `packages/cli` – command entrypoints and onboarding/auth helpers
- `packages/discord` – Discord channel integration
- `packages/slack` – Slack channel integration

## Runtime flow

1. Input enters from web, CLI, or channel integration.
2. Runtime resolves the active session and model/provider settings.
3. Agent performs a reasoning/tool loop.
4. Tool execution passes through policy + approval mechanisms.
5. Streamed assistant output returns to session/channel.
6. Session metadata, tool events, and context usage are updated.

## Session model

- **Main web session** for direct interaction
- Additional sessions for project/task isolation
- Read-only mirrored sessions for external channel conversations

Benefits:

- Safer context boundaries
- Easier debugging and auditing
- Better automation targeting

## Tooling and security model

Tool calls are not all equal. Keygate treats sensitive actions with stronger controls.

- Safe mode defaults to conservative operation
- Confirmation prompts for actions requiring explicit user consent
- Browser MCP has domain policy controls (none/allowlist/blocklist)

## Plugin host

The gateway now embeds a plugin host alongside the skills system.

- plugin manifests are discovered before activation
- plugin config is validated against JSON Schema before code loads
- plugin setup happens in a staging registry
- services start before a staged instance replaces the live one
- failed hot reloads keep the previous healthy instance active

This keeps tool, RPC, HTTP, and CLI extensions rollback-safe instead of partially registered.

## UI architecture

The web app maintains session-scoped state maps:

- messages by session
- stream status by session
- tool events by session
- context usage by session

This design allows concurrent monitoring across many sessions and channels.

## Why this architecture

- Easy package-level ownership
- Clear boundary between runtime and presentation
- Channel integrations can evolve independently
- Security controls remain centralized in runtime policy paths
