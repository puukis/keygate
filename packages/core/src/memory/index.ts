export { MemoryManager, type MemoryManagerStatus } from './manager.js';
export { VectorStore, type VectorSearchResult, type StoredChunk } from './vectorStore.js';
export { searchMemory, type MemorySearchResult, type MemorySearchOptions } from './search.js';
export { chunkText, chunkSessionMessages, type Chunk } from './chunker.js';
export { indexWorkspaceFiles, indexSessionTranscripts } from './indexer.js';
export { createMemoryWatcher } from './watcher.js';
export type { EmbeddingProvider, MemoryConfig, MemoryProviderName } from './embedding/types.js';
export { createEmbeddingProvider } from './embedding/factory.js';
