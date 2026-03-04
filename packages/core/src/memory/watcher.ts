import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

export interface WatcherCallbacks {
  onFileChange(relativePath: string): void;
  onFileRemove(relativePath: string): void;
}

const DEBOUNCE_MS = 1500;

/**
 * Watch workspace memory files for changes and trigger re-indexing.
 * Watches MEMORY.md and memory/*.md files.
 */
export function createMemoryWatcher(
  workspacePath: string,
  callbacks: WatcherCallbacks,
): FSWatcher {
  const memoryDir = path.join(workspacePath, 'memory');
  const memoryFile = path.join(workspacePath, 'MEMORY.md');

  const watcher = watch([memoryFile, memoryDir], {
    persistent: true,
    ignoreInitial: true,
    // Only watch .md files
    ignored: (filePath: string) => {
      if (filePath === memoryDir) return false; // allow watching the directory itself
      const ext = path.extname(filePath);
      return ext !== '.md' && ext !== '';
    },
    awaitWriteFinish: {
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 200,
    },
  });

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  function debounced(filePath: string, fn: () => void): void {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      filePath,
      setTimeout(() => {
        debounceTimers.delete(filePath);
        fn();
      }, DEBOUNCE_MS),
    );
  }

  function toRelative(absolutePath: string): string {
    return path.relative(workspacePath, absolutePath);
  }

  watcher.on('add', (filePath) => {
    const relative = toRelative(filePath);
    if (isMemoryFile(relative)) {
      debounced(filePath, () => callbacks.onFileChange(relative));
    }
  });

  watcher.on('change', (filePath) => {
    const relative = toRelative(filePath);
    if (isMemoryFile(relative)) {
      debounced(filePath, () => callbacks.onFileChange(relative));
    }
  });

  watcher.on('unlink', (filePath) => {
    const relative = toRelative(filePath);
    if (isMemoryFile(relative)) {
      const timer = debounceTimers.get(filePath);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(filePath);
      }
      callbacks.onFileRemove(relative);
    }
  });

  return watcher;
}

function isMemoryFile(relativePath: string): boolean {
  if (relativePath === 'MEMORY.md') return true;
  return relativePath.startsWith('memory/') && relativePath.endsWith('.md');
}
