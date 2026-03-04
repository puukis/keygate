import type { ParsedArgs } from '../argv.js';
import { getFlagString, hasFlag } from '../argv.js';
import { AgentMemoryStore } from '../../db/agentMemory.js';
import { MemoryManager } from '../../memory/manager.js';
import { loadConfigFromEnv } from '../../config/env.js';

export async function runMemoryCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1] ?? 'list';

  // Vector memory subcommands (don't need AgentMemoryStore)
  if (action === 'vsearch' || action === 'reindex' || action === 'vstatus') {
    switch (action) {
      case 'vsearch':
        return runVectorSearch(args);
      case 'reindex':
        return runReindex();
      case 'vstatus':
        return runVectorStatus();
    }
  }

  const store = new AgentMemoryStore();

  try {
    switch (action) {
      case 'list':
        return runList(store, args);
      case 'get':
        return runGet(store, args);
      case 'set':
        return runSet(store, args);
      case 'delete':
        return runDelete(store, args);
      case 'search':
        return runSearch(store, args);
      case 'namespaces':
        return runNamespaces(store);
      case 'clear':
        return runClear(store, args);
      default:
        console.error(`Unknown memory action: ${action}`);
        console.log('Available: list, get, set, delete, search, namespaces, clear, vsearch, reindex, vstatus');
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function runList(store: AgentMemoryStore, args: ParsedArgs): void {
  const namespace = getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns');
  const json = hasFlag(args.flags, 'json');
  const limit = Number.parseInt(getFlagString(args.flags, 'limit') ?? '50', 10) || 50;

  const memories = store.list(namespace ?? undefined, limit);

  if (json) {
    console.log(JSON.stringify(memories, null, 2));
    return;
  }

  if (memories.length === 0) {
    console.log(namespace ? `No memories in namespace "${namespace}".` : 'No memories stored.');
    return;
  }

  console.log(`Memories${namespace ? ` [${namespace}]` : ''} (${memories.length}):\n`);
  for (const memory of memories) {
    const preview = memory.content.length > 80
      ? `${memory.content.slice(0, 77)}...`
      : memory.content;
    console.log(`  [${memory.namespace}/${memory.key}]  ${preview}`);
  }
}

function runGet(store: AgentMemoryStore, args: ParsedArgs): void {
  const key = args.positional[2];
  const namespace = getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns') ?? 'general';
  const json = hasFlag(args.flags, 'json');

  if (!key) {
    console.error('Usage: keygate memory get <key> [--namespace <ns>]');
    process.exitCode = 1;
    return;
  }

  const memory = store.get(namespace, key);

  if (!memory) {
    console.error(`Memory "${namespace}/${key}" not found.`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify(memory, null, 2));
  } else {
    console.log(`[${memory.namespace}/${memory.key}]`);
    console.log(memory.content);
    console.log(`\nUpdated: ${memory.updatedAt.toISOString()}`);
  }
}

function runSet(store: AgentMemoryStore, args: ParsedArgs): void {
  const key = args.positional[2];
  const content = args.positional.slice(3).join(' ') || getFlagString(args.flags, 'content');
  const namespace = getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns') ?? 'general';

  if (!key || !content) {
    console.error('Usage: keygate memory set <key> <content...> [--namespace <ns>]');
    process.exitCode = 1;
    return;
  }

  const memory = store.set(namespace, key, content);
  console.log(`Saved: [${memory.namespace}/${memory.key}]`);
}

function runDelete(store: AgentMemoryStore, args: ParsedArgs): void {
  const key = args.positional[2];
  const namespace = getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns') ?? 'general';

  if (!key) {
    console.error('Usage: keygate memory delete <key> [--namespace <ns>]');
    process.exitCode = 1;
    return;
  }

  const deleted = store.delete(namespace, key);
  if (deleted) {
    console.log(`Deleted: [${namespace}/${key}]`);
  } else {
    console.error(`Memory "${namespace}/${key}" not found.`);
    process.exitCode = 1;
  }
}

function runSearch(store: AgentMemoryStore, args: ParsedArgs): void {
  const query = args.positional[2] ?? '';
  const namespace = getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns');
  const json = hasFlag(args.flags, 'json');
  const limit = Number.parseInt(getFlagString(args.flags, 'limit') ?? '50', 10) || 50;

  if (!query) {
    console.error('Usage: keygate memory search <query> [--namespace <ns>]');
    process.exitCode = 1;
    return;
  }

  const result = store.search(query, { namespace: namespace ?? undefined, limit });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Search "${query}": ${result.total} result(s)\n`);
  for (const memory of result.memories) {
    const preview = memory.content.length > 80
      ? `${memory.content.slice(0, 77)}...`
      : memory.content;
    console.log(`  [${memory.namespace}/${memory.key}]  ${preview}`);
  }
}

function runNamespaces(store: AgentMemoryStore): void {
  const namespaces = store.listNamespaces();

  if (namespaces.length === 0) {
    console.log('No namespaces.');
    return;
  }

  console.log('Namespaces:');
  for (const ns of namespaces) {
    const count = store.count(ns);
    console.log(`  ${ns} (${count} entries)`);
  }
}

function runClear(store: AgentMemoryStore, args: ParsedArgs): void {
  const namespace = args.positional[2] ?? getFlagString(args.flags, 'namespace') ?? getFlagString(args.flags, 'ns');

  if (!namespace) {
    console.error('Usage: keygate memory clear <namespace>');
    process.exitCode = 1;
    return;
  }

  const count = store.clearNamespace(namespace);
  console.log(`Cleared ${count} memories from namespace "${namespace}".`);
}

// ==================== Vector Memory Subcommands ====================

async function createCliMemoryManager(): Promise<MemoryManager> {
  const config = loadConfigFromEnv();
  const memoryConfig = config.memory ?? {
    provider: 'auto' as const,
    vectorWeight: 0.7,
    textWeight: 0.3,
    maxResults: 10,
    minScore: 0.25,
    autoIndex: true,
    indexSessions: false,
    temporalDecay: true,
    temporalHalfLifeDays: 30,
    mmr: true,
  };
  const manager = new MemoryManager(config, memoryConfig);
  await manager.initialize();
  return manager;
}

async function runVectorSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional[2] ?? '';
  const json = hasFlag(args.flags, 'json');
  const maxResults = Number.parseInt(getFlagString(args.flags, 'limit') ?? '10', 10) || 10;
  const source = (getFlagString(args.flags, 'source') ?? 'all') as 'memory' | 'session' | 'all';

  if (!query) {
    console.error('Usage: keygate memory vsearch <query> [--limit N] [--source memory|session|all] [--json]');
    process.exitCode = 1;
    return;
  }

  let manager: MemoryManager | undefined;
  try {
    manager = await createCliMemoryManager();
    const results = await manager.search(query, { maxResults, source });

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`Vector search "${query}": ${results.length} result(s)\n`);
    for (const r of results) {
      const preview = r.snippet.length > 100 ? `${r.snippet.slice(0, 97)}...` : r.snippet;
      const scoreStr = r.score.toFixed(3);
      console.log(`  [${scoreStr}] ${r.source} ${r.path}:${r.startLine}  ${preview}`);
    }
  } catch (error) {
    console.error('Vector search failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    manager?.shutdown();
  }
}

async function runReindex(): Promise<void> {
  let manager: MemoryManager | undefined;
  try {
    manager = await createCliMemoryManager();
    await manager.reindex();
    console.log('Reindex complete.');
  } catch (error) {
    console.error('Reindex failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    manager?.shutdown();
  }
}

async function runVectorStatus(): Promise<void> {
  let manager: MemoryManager | undefined;
  try {
    manager = await createCliMemoryManager();
    const s = manager.status();
    console.log(`Vector Memory Status:`);
    console.log(`  Provider:    ${s.provider}`);
    console.log(`  Model:       ${s.model}`);
    console.log(`  Dimensions:  ${s.dimensions}`);
    console.log(`  Initialized: ${manager.isInitialized()}`);
    console.log(`  Chunks:      ${s.totalChunks}`);
    console.log(`  Files:       ${s.indexedFiles.length}`);
    if (s.lastIndexed) {
      console.log(`  Last indexed: ${s.lastIndexed}`);
    }  } catch (error) {
    console.error('Status failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    manager?.shutdown();
  }
}
