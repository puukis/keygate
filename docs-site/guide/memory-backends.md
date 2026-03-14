# Memory Backends

Keygate now separates the memory catalog from the active vector backend.

## Catalog vs vector search

SQLite still owns:

- memory file hashes
- chunk text
- keyword search (FTS)
- embedding cache
- rollback-friendly local metadata

Vector similarity can now target either:

- `sqlite-vec`
- `lancedb`

## Backend selection

Use `memory.backend.active` to choose the target backend.

Practical behavior:

- new or unchanged installs can stay on `sqlite-vec`
- setting the target to `lancedb` prepares a LanceDB dataset and backfills vectors
- the sqlite-backed vector path remains populated for rollback and continuity
- the SQLite catalog still owns chunk metadata, hashes, FTS, and embedding cache

## Migration phases

`memory_status` now reports:

- `backend`
- `targetBackend`
- `migrationPhase`
- `batchMode`
- `multimodal`

Current migration phases:

- `idle`
- `backfilling`
- `ready`

## Multimodal indexing

The memory manager can now expose enabled multimodal modalities in status. That is designed to work with attachment-derived text so images, audio, video, and PDF content can contribute useful searchable text instead of only existing as opaque files.

## Batch embedding mode

When `memory.batch.enabled` is active, Keygate reports `openai-remote` batch mode in both `memory_status` and the Overview screen.

Use this mode for:

- large initial LanceDB backfills
- full reindexing runs
- high-volume transcript ingestion

Smaller runs can still complete inline when remote batching is unnecessary or unavailable.

## Storage locations

- SQLite memory catalog and sqlite-vec data: `~/.keygate/memory-vectors.db`
- LanceDB dataset: `~/.keygate/memory-lancedb/`
