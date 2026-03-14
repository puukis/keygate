# WebChat, Canvas, and Media Operations

This note documents the new guest-facing surfaces and media preprocessing flow added to Keygate.

## WebChat

- Guest links are signed HMAC tokens persisted in `webchat_links`.
- Operators create links through `POST /api/webchat/links`.
- Operators can list and revoke links through `GET /api/webchat/links` and `DELETE /api/webchat/links/:id`.
- Guests connect on `/webchat` and `/webchat/ws`.
- Links are session-bound, expiring, revocable, and rate-limited.
- Guests can only read and write the bound session, cancel their own run, upload attachments, and vote in WebChat polls when the link capabilities allow it.
- Guest attachment rendering against `/api/uploads/*` now requires the guest token when operator auth is enabled. The browser guest client appends the token automatically.
- WebChat polls are persisted in `channel_polls` and votes in `channel_poll_votes`.

## Canvas

- Canvas assets are served from the workspace `canvas/` directory.
- Built-in A2UI is served from `/__keygate__/a2ui`.
- The injected bridge exposes:
  - `window.Keygate.postMessage`
  - `window.Keygate.sendUserAction`
- `window.keygatePostMessage`
- `window.keygateSendUserAction`
- Canvas runtime state is persisted in `canvas_surfaces`.
- Tool-driven updates use `canvas_open`, `canvas_update`, and `canvas_close`.
- Canvas websocket URLs should include `sessionId` and `surfaceId` so browser and macOS `WKWebView` hosts stay bound to the correct session surface.
- Canvas user actions are persisted as structured message metadata and are reinjected into the bound session as user turns with `source: "canvas"`.

## Media Understanding

- Upload ingestion now accepts image, audio, video, and PDF files.
- Attachment metadata is normalized with `kind`, `sha256`, duration, dimensions, page counts, and `previewText`.
- Derived artifacts are cached in the media cache directory under `~/.keygate/media-cache/`.
- OpenAI is used first when `OPENAI_API_KEY` is present.
- Local fallbacks use:
  - `ffprobe` for media inspection
  - `ffmpeg` for video frame extraction
  - `whisper` or `whisper-cli` for transcription when installed
  - `pdfjs-dist` for PDF text extraction
- The macOS app now uses the generic attachment upload path as well, so operator-side uploads are no longer image-only.
- Assistant and user bubbles in the macOS app render attachment chips and derived previews.

## Operational checks

- `GET /api/status` now reports WebChat, canvas, media, and memory backend state.
- The macOS app polls `/api/status` and mirrors live canvas surfaces, voice sessions, and memory migration state in the native settings UI.
- The web app build now emits both the operator app and a dedicated `webchat.html` guest surface.
