# Memory Backend Architecture

Keygate now keeps SQLite as the memory catalog and uses a selectable vector backend.

## Current model

- SQLite remains the source of truth for:
  - indexed file metadata
  - chunk text
  - FTS search
  - embedding cache
- Vector similarity can target:
  - `sqlite-vec`
  - `lancedb`

## Migration behavior

- Existing installs still keep the sqlite-vec table populated.
- When `memory.backend.active` is set to `lancedb`, Keygate prepares LanceDB, backfills vectors from the SQLite catalog, and only then activates LanceDB for similarity search.
- SQLite data is retained for rollback and keyword-search continuity.
- New installs can target LanceDB directly, but the SQLite catalog remains present for metadata, FTS, and embedding cache bookkeeping.

## Status surface

`memory_status` now includes:

- active backend
- target backend
- migration phase
- batch mode
- enabled multimodal modalities
- indexed file inventory and last-indexed timestamps

`GET /api/status` surfaces the same memory summary to operator UIs.

## Batch and multimodal behavior

- `memory.batch.enabled=true` switches status reporting to `openai-remote` batch mode.
- Small or unsupported runs still fall back inline; the status payload is the operator-facing source of truth for what is active.
- Attachment-derived summaries from media preprocessing are what make multimodal memory indexing useful in practice.

## Files

- SQLite catalog and legacy vectors: `~/.keygate/memory-vectors.db`
- LanceDB dataset: `~/.keygate/memory-lancedb/`
