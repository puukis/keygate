import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AgentMemoryStore } from '../agentMemory.js';

let tmpDir: string;
let store: AgentMemoryStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-memory-test-'));
  store = new AgentMemoryStore(path.join(tmpDir, 'test-memory.db'));
});

afterEach(() => {
  store.close();
});

describe('AgentMemoryStore', () => {
  describe('set and get', () => {
    it('stores and retrieves a memory', () => {
      const memory = store.set('general', 'user-name', 'Alice');
      expect(memory.namespace).toBe('general');
      expect(memory.key).toBe('user-name');
      expect(memory.content).toBe('Alice');
      expect(memory.id).toBeGreaterThan(0);

      const retrieved = store.get('general', 'user-name');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('Alice');
    });

    it('upserts existing memory', () => {
      store.set('general', 'fact', 'Original');
      const updated = store.set('general', 'fact', 'Updated');

      expect(updated.content).toBe('Updated');

      const all = store.list('general');
      expect(all).toHaveLength(1);
      expect(all[0]!.content).toBe('Updated');
    });

    it('stores in different namespaces independently', () => {
      store.set('prefs', 'color', 'blue');
      store.set('facts', 'color', 'red is warm');

      expect(store.get('prefs', 'color')!.content).toBe('blue');
      expect(store.get('facts', 'color')!.content).toBe('red is warm');
    });

    it('returns null for missing memory', () => {
      expect(store.get('general', 'nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('lists memories in a namespace', () => {
      store.set('notes', 'a', 'Note A');
      store.set('notes', 'b', 'Note B');
      store.set('other', 'c', 'Note C');

      const notes = store.list('notes');
      expect(notes).toHaveLength(2);
      expect(notes.map((m) => m.key).sort()).toEqual(['a', 'b']);
    });

    it('lists all memories when no namespace given', () => {
      store.set('ns1', 'k1', 'v1');
      store.set('ns2', 'k2', 'v2');

      const all = store.list();
      expect(all).toHaveLength(2);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.set('general', `key${i}`, `value${i}`);
      }

      const limited = store.list('general', 3);
      expect(limited).toHaveLength(3);
    });

    it('orders by most recently updated', async () => {
      store.set('general', 'old', 'Old value');
      // Wait a small amount to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.set('general', 'new', 'New value');

      const list = store.list('general');
      expect(list[0]!.key).toBe('new');
      expect(list[1]!.key).toBe('old');
    });
  });

  describe('search', () => {
    it('searches by key substring', () => {
      store.set('general', 'user-timezone', 'UTC+2');
      store.set('general', 'user-name', 'Bob');
      store.set('general', 'project', 'Keygate');

      const result = store.search('user');
      expect(result.total).toBe(2);
      expect(result.memories).toHaveLength(2);
    });

    it('searches by content substring', () => {
      store.set('facts', 'lang', 'TypeScript is great');
      store.set('facts', 'framework', 'React and friends');
      store.set('facts', 'tool', 'Vitest for testing');

      const result = store.search('React');
      expect(result.total).toBe(1);
      expect(result.memories[0]!.key).toBe('framework');
    });

    it('filters by namespace', () => {
      store.set('ns1', 'key', 'hello world');
      store.set('ns2', 'key', 'hello world');

      const result = store.search('hello', { namespace: 'ns1' });
      expect(result.total).toBe(1);
      expect(result.memories[0]!.namespace).toBe('ns1');
    });

    it('returns empty for no matches', () => {
      store.set('general', 'fact', 'Something');
      const result = store.search('zzzzz');
      expect(result.total).toBe(0);
      expect(result.memories).toHaveLength(0);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.set('general', `item${i}`, 'common content');
      }

      const result = store.search('common', { limit: 3 });
      expect(result.total).toBe(10);
      expect(result.memories).toHaveLength(3);
    });
  });

  describe('delete', () => {
    it('deletes an existing memory', () => {
      store.set('general', 'temp', 'temporary');
      expect(store.delete('general', 'temp')).toBe(true);
      expect(store.get('general', 'temp')).toBeNull();
    });

    it('returns false for non-existent memory', () => {
      expect(store.delete('general', 'ghost')).toBe(false);
    });
  });

  describe('clearNamespace', () => {
    it('clears all memories in a namespace', () => {
      store.set('temp', 'a', 'val');
      store.set('temp', 'b', 'val');
      store.set('keep', 'c', 'val');

      const cleared = store.clearNamespace('temp');
      expect(cleared).toBe(2);
      expect(store.list('temp')).toHaveLength(0);
      expect(store.list('keep')).toHaveLength(1);
    });
  });

  describe('listNamespaces', () => {
    it('lists distinct namespaces', () => {
      store.set('alpha', 'k', 'v');
      store.set('beta', 'k', 'v');
      store.set('alpha', 'k2', 'v');

      const namespaces = store.listNamespaces();
      expect(namespaces).toEqual(['alpha', 'beta']);
    });

    it('returns empty when no memories', () => {
      expect(store.listNamespaces()).toEqual([]);
    });
  });

  describe('count', () => {
    it('counts all memories', () => {
      store.set('a', 'k1', 'v');
      store.set('b', 'k2', 'v');
      expect(store.count()).toBe(2);
    });

    it('counts memories in a namespace', () => {
      store.set('ns', 'k1', 'v');
      store.set('ns', 'k2', 'v');
      store.set('other', 'k3', 'v');
      expect(store.count('ns')).toBe(2);
    });
  });

  describe('buildContextSummary', () => {
    it('builds a prompt-ready summary', () => {
      store.set('general', 'user-name', 'Alice');
      store.set('general', 'timezone', 'UTC+2');
      store.set('prefs', 'theme', 'dark');

      const summary = store.buildContextSummary();
      expect(summary).toContain('[general/user-name]');
      expect(summary).toContain('Alice');
      expect(summary).toContain('[prefs/theme]');
      expect(summary).toContain('dark');
    });

    it('returns empty string when no memories', () => {
      expect(store.buildContextSummary()).toBe('');
    });

    it('respects maxEntries limit', () => {
      for (let i = 0; i < 10; i++) {
        store.set('general', `key${i}`, `value${i}`);
      }

      const summary = store.buildContextSummary({ maxEntries: 3 });
      const lines = summary.split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
    });

    it('respects maxChars limit', () => {
      for (let i = 0; i < 50; i++) {
        store.set('general', `key${i}`, 'A'.repeat(100));
      }

      const summary = store.buildContextSummary({ maxChars: 500 });
      expect(summary.length).toBeLessThanOrEqual(600); // Some tolerance for line boundaries
    });

    it('filters by namespace', () => {
      store.set('work', 'task', 'Build feature');
      store.set('personal', 'hobby', 'Chess');

      const summary = store.buildContextSummary({ namespace: 'work' });
      expect(summary).toContain('Build feature');
      expect(summary).not.toContain('Chess');
    });
  });
});
