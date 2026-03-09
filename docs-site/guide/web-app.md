# Web App

The web app is the primary operator console for a running Keygate gateway.

## Main areas

### Chat

Use **Chat** for:

- live conversations
- text slash commands such as `/status`, `/model`, `/compact`, and `/debug`
- attachments
- mirrored read-only sessions from external channels

### Overview

The **Overview** tab is the high-level runtime health screen. It summarizes:

- websocket connection state
- current security mode
- selected provider/model
- browser and channel readiness
- recent usage totals
- high-level runtime status

### Instances

**Instances** is the runtime inventory view.

It shows:

- active Docker sandboxes
- sandbox scope and image
- paired device nodes
- node online/offline state
- node platform/version
- last seen and last invocation timestamps

Use it when safe-mode execution or device-node routing looks suspicious.

### Sessions

The **Sessions** tab manages web sessions:

- create
- rename
- switch
- delete

Session compaction and debug mode are session-scoped, so the selected session matters across Chat, Usage, and Debug.

### Automations

The **Automations** tab now has three sections:

- **Scheduler** for cron-driven prompts
- **Webhooks** for signed HTTP routes
- **Gmail** for Gmail account/watch routing

All three automation types deliver into normal Keygate sessions instead of bypassing the session pipeline.

### Usage

The **Usage** tab is no longer a placeholder. It shows:

- total turns, tokens, and cost
- 24h / 7d / 30d / all windows
- provider breakdowns
- model breakdowns
- session breakdowns
- daily aggregates

### Debug

The **Debug** tab shows the bounded debug event buffer for the active session.

Enable it from chat:

```text
/debug on
```

Disable it with:

```text
/debug off
```

### Git

The **Git** tab is the session-scoped repository view.

It automatically refreshes status when you open it and shows the repo attached to the active session workspace.

Use it to:

- inspect branch and ahead/behind state
- review staged, unstaged, and untracked files
- stage and unstage files
- discard unstaged changes
- commit staged work
- inspect recent local history

Important behavior:

- Keygate bootstraps managed workspaces as local repos by default
- the UI works with local Git only unless you manually add a remote yourself
- after routing, the Git tab follows that routed agent workspace rather than the root workspace
- assistant-triggered Git mutations in Safe Mode still go through the normal confirmation flow

For the full repo model, see [Local Git Workspaces](/guide/local-git-workspaces).

## Configuration surfaces

The configuration area includes:

- appearance and theme
- safe/spicy mode controls
- provider/model selection
- browser MCP policy
- Discord, Slack, and WhatsApp settings
- plugin management

## Operational notes

- **Usage**, **Debug**, and `/status` all read from the same persisted runtime state.
- **Instances** is the best first stop for Docker sandbox and device-node inspection.
- **Automations** can create Gmail watches after the Gmail account has already been linked through the CLI.

## Current limits

- Gmail OAuth login is still completed through `keygate gmail login`, not directly in the browser.
- Discord and Slack native slash command registration happens inside their channel runtimes, not in the web app itself.
