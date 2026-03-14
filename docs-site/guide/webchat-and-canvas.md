# WebChat and Canvas

Keygate now exposes two separate browser surfaces:

- the **operator web app** at `/`
- the **guest WebChat** surface at `/webchat`

Canvas and A2UI surfaces sit beside both and are delivered from the gateway itself.

## WebChat guest links

Guest access is link-based and session-scoped.

Important properties:

- links are signed and persisted
- each link expires
- each link can be revoked
- rate limits and connection limits are enforced per link
- guests can only see the session bound to that link

Operators create links through the authenticated API:

```http
POST /api/webchat/links
```

Typical payload:

```json
{
  "sessionId": "webchat:demo-room",
  "displayName": "Support Guest",
  "expiryMinutes": 120
}
```

The response includes the one-time guest token and the ready-to-open URL.

The operator web app now exposes:

- guest-link creation directly from the Sessions view
- revoke controls for active links
- live poll visibility and operator voting for WebChat-owned polls
- channel action history for the active session

## Guest capabilities

A WebChat guest can:

- send chat turns
- upload image, audio, video, and PDF attachments
- cancel their own run when enabled
- vote in WebChat polls when enabled
- receive chat, canvas, and action events for the bound session

A guest cannot:

- list or switch other sessions
- rename or delete sessions
- manage configuration
- access plugins, scheduler, Git, or operator-only controls

When operator token auth is enabled, guest attachment rendering still works because the WebChat client appends the guest token to `/api/uploads/*` requests.

## Canvas host

Canvas assets are served from the workspace `canvas/` directory.

Built-in routes:

- `/__keygate__/canvas/*`
- `/__keygate__/a2ui`
- `/__keygate__/canvas/ws`

The injected bridge exposes these APIs:

- `window.Keygate.postMessage`
- `window.Keygate.sendUserAction`
- `window.keygatePostMessage`
- `window.keygateSendUserAction`

The browser bridge carries the current query string through to the canvas websocket. In practice that means you should open surfaces with `sessionId` and `surfaceId` in the URL when you want a live, session-bound canvas.

Example:

```text
/__keygate__/a2ui?sessionId=webchat:demo-room&surfaceId=main
```

## Tool-driven canvas control

The built-in tools are:

- `canvas_open`
- `canvas_update`
- `canvas_close`

Each surface is persisted in the `canvas_surfaces` table, so reconnecting clients can recover the latest path and state.

The macOS app now opens active surfaces in a native `WKWebView` window and mirrors the same bridge contract used in the browser.

## User actions coming back from canvas

Canvas user actions are sent back through the canvas websocket as structured payloads and then rebroadcast to the session as canvas events.

They are also injected into the bound session as structured user turns, which means the agent can respond to UI interactions using the normal session pipeline.
