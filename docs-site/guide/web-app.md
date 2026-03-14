# Web App

The web app is the primary operator console for a running Keygate gateway.

## Main areas

### Guest WebChat

The operator app is no longer the only browser surface. Keygate also ships a dedicated guest surface at `/webchat`.

Use it when you want:

- a session-scoped guest chat
- signed expiring guest links
- attachment uploads without exposing the full operator console
- session-bound canvas and poll events

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
- active WebChat guest-link counts
- live canvas base-path and A2UI state
- memory backend and migration phase
- active voice session count
- recent WebChat links, polls, and channel actions

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

WebChat sessions now appear as their own channel type and stay isolated from the operator session lifecycle.

From the Sessions tab you can also:

- create a guest WebChat link for the session
- see active guest-link counts per session
- inspect channel polls and recent channel action history for the selected session

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

## Canvas and A2UI

The web app can now receive session-scoped canvas events from:

- `/__keygate__/canvas/*`
- `/__keygate__/a2ui`

These surfaces are driven by the `canvas_open`, `canvas_update`, and `canvas_close` tools and are persisted server-side.

The Overview and session detail views also reflect canvas state and user-action events coming back from those surfaces.

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
