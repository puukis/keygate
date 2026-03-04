import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FSWatcher } from 'chokidar';
import { VectorStore } from './vectorStore.js';
import type { EmbeddingProvider, MemoryConfig } from './embedding/types.js';
import { createEmbeddingProvider } from './embedding/factory.js';
import { indexWorkspaceFiles, indexSessionTranscripts } from './indexer.js';
import { searchMemory, type MemorySearchResult, type MemorySearchOptions } from './search.js';
import { createMemoryWatcher } from './watcher.js';
import { chunkText } from './chunker.js';
import { createHash } from 'node:crypto';
import type { KeygateConfig } from '../types.js';

export interface MemoryManagerStatus {
  provider: string;
  model: string;
  dimensions: number;
  totalChunks: number;
  indexedFiles: string[];
  lastIndexed: string | null;
}

export class MemoryManager {
  private store: VectorStore | null = null;
  private provider: EmbeddingProvider | null = null;
  private watcher: FSWatcher | null = null;
  private config: KeygateConfig;
  private memoryConfig: MemoryConfig;
  private workspacePath: string;
  private lastIndexed: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private sessionIndexInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: KeygateConfig, memoryConfig: MemoryConfig) {
    this.config = config;
    this.memoryConfig = memoryConfig;
    this.workspacePath = config.security.workspacePath;
  }

  /**
   * Initialize the memory system: create provider, open vector store, start watcher.
   * Safe to call multiple times — only initializes once.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Create embedding provider
      this.provider = await createEmbeddingProvider(this.config, this.memoryConfig);

      // Create vector store with provider dimensions
      this.store = new VectorStore(this.provider.dimensions);

      // Initial index of workspace files
      await indexWorkspaceFiles(this.workspacePath, this.store, this.provider);
      this.lastIndexed = new Date().toISOString();

      // Start file watcher for auto-indexing
      if (this.memoryConfig.autoIndex) {
        this.startWatcher();
      }

      this.initialized = true;
    } catch (error) {
      // Reset state on failure
      this.store?.close();
      this.store = null;
      this.provider = null;
      this.initPromise = null;
      throw error;
    }
  }

  private startWatcher(): void {
    this.watcher = createMemoryWatcher(this.workspacePath, {
      onFileChange: (relativePath) => {
        void this.reindexFile(relativePath);
      },
      onFileRemove: (relativePath) => {
        this.store?.deleteByPath(relativePath);
      },
    });
  }

  private async reindexFile(relativePath: string): Promise<void> {
    if (!this.store || !this.provider) return;

    const absolutePath = path.join(this.workspacePath, relativePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, 'utf8');
    } catch {
      return;
    }

    const hash = createHash('sha256').update(content).digest('hex');
    const storedHash = this.store.getFileHash(relativePath);
    if (storedHash === hash) return;

    this.store.deleteByPath(relativePath);

    const chunks = chunkText(relativePath, content);
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.text);
    const embeddings = await this.provider.embedBatch(texts);

    const storedChunks = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]!,
      model: this.provider!.model,
      source: 'memory' as const,
    }));

    this.store.upsertChunks(storedChunks);

    const stat = await fs.stat(absolutePath);
    this.store.upsertFile(relativePath, hash, Math.floor(stat.mtimeMs), stat.size, 'memory');
    this.lastIndexed = new Date().toISOString();
  }

  /**
   * Semantic search over indexed memories.
   * Lazily initializes on first call if not already initialized.
   */
  async search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    await this.initialize();
    if (!this.store || !this.provider) {
      throw new Error('Memory system not initialized');
    }
    return searchMemory(query, this.provider, this.store, this.memoryConfig, opts);
  }

  /**
   * Force a full re-index of all workspace files.
   */
  async reindex(): Promise<{ indexed: number; skipped: number; removed: number }> {
    await this.initialize();
    if (!this.store || !this.provider) {
      throw new Error('Memory system not initialized');
    }
    const result = await indexWorkspaceFiles(this.workspacePath, this.store, this.provider);
    this.lastIndexed = new Date().toISOString();
    return result;
  }

  /**
   * Index session transcripts from the database.
   */
  async indexSessions(
    sessions: Array<{ id: string; messages: Array<{ role: string; content: string }>; updatedAt: Date }>,
  ): Promise<{ indexed: number; skipped: number }> {
    await this.initialize();
    if (!this.store || !this.provider) {
      throw new Error('Memory system not initialized');
    }
    return indexSessionTranscripts(sessions, this.store, this.provider);
  }

  /**
   * Get current status of the memory system.
   */
  status(): MemoryManagerStatus {
    return {
      provider: this.provider?.id ?? 'not initialized',
      model: this.provider?.model ?? 'unknown',
      dimensions: this.provider?.dimensions ?? 0,
      totalChunks: this.store?.totalChunks() ?? 0,
      indexedFiles: this.store?.indexedFiles() ?? [],
      lastIndexed: this.lastIndexed,
    };
  }

  /**
   * Whether the memory system has been successfully initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Start periodic session indexing.
   */
  startSessionIndexing(
    getSessionData: () => Promise<Array<{ id: string; messages: Array<{ role: string; content: string }>; updatedAt: Date }>>,
    intervalMs = 10 * 60 * 1000,
  ): void {
    if (this.sessionIndexInterval) return;

    this.sessionIndexInterval = setInterval(async () => {
      try {
        const sessions = await getSessionData();
        await this.indexSessions(sessions);
      } catch {
        // Silently ignore periodic indexing failures
      }
    }, intervalMs);
  }

  /**
   * Shutdown the memory system: stop watcher, close database.
   */
  shutdown(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionIndexInterval) {
      clearInterval(this.sessionIndexInterval);
      this.sessionIndexInterval = null;
    }
    if (this.store) {
      this.store.close();
      this.store = null;
    }
    this.provider = null;
    this.initialized = false;
    this.initPromise = null;
  }
}
