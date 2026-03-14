# Media Understanding

Keygate now preprocesses supported attachments before they are handed to the model.

Supported attachment types:

- images
- audio
- video
- PDF documents

## What Keygate derives

For each attachment, Keygate stores normalized metadata when available:

- `kind`
- `sha256`
- `durationMs`
- `width`
- `height`
- `pageCount`
- `previewText`

`previewText` is important because it is injected into the model prompt for user turns that include attachments. That means non-image attachments still become useful model context even when the underlying provider only supports text or image-native multimodal input.

## Processing order

### Images

- dimensions are measured locally
- if `OPENAI_API_KEY` is set, OpenAI vision generates a short actionable description
- otherwise Keygate falls back to a metadata-only summary

### Audio

- OpenAI transcription is attempted first
- if that is unavailable, Keygate tries local Whisper-style binaries

### Video

- `ffprobe` gathers duration and stream metadata
- `ffmpeg` extracts a representative frame
- the extracted frame is sent through the same image-description path

### PDF

- `pdfjs-dist` extracts text
- page count is recorded
- extracted text is clipped into `previewText`

## Cache behavior

Derived artifacts are cached by attachment hash under the media cache directory. Repeated uploads of the same file reuse the cached artifact instead of recomputing it.

This same cache is reused by:

- repeated guest uploads
- replayed session history
- Discord voice transcription segments
- memory backfills and reindexing

## Upload surfaces

Operator upload endpoints:

- `POST /api/uploads/attachment`
- `GET /api/uploads/attachment`

Legacy image routes remain available:

- `POST /api/uploads/image`
- `GET /api/uploads/image`

Guest upload endpoint:

- `POST /webchat/uploads/attachment`

The macOS app now uploads through the generic attachment endpoint too, so operator uploads are no longer image-only there either.

## UI surfaces

Operator UIs now expose derived attachment metadata more clearly:

- the web app keeps normalized attachment fields in session views
- the macOS app renders attachment chips and the derived `previewText`
- WebChat guests see uploaded files through token-aware attachment URLs when operator auth is enabled

## Operational notes

- media summaries improve both live chat context and memory indexing inputs
- attachment fetches for `/api/uploads/*` are readable by the browser so the guest UI can render uploaded files
- the status payload reports media enablement and local binary configuration
