import { describe, expect, it } from 'vitest';
import { chunkText, chunkSessionMessages } from '../chunker.js';

describe('chunker', () => {
  describe('chunkText', () => {
    it('returns a single chunk for short texts', () => {
      const chunks = chunkText('test.md', 'Hello world\nThis is short.');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].path).toBe('test.md');
      expect(chunks[0].text).toBe('Hello world\nThis is short.');
      expect(chunks[0].startLine).toBe(1);
    });

    it('produces overlapping chunks for long texts', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: some words to pad the content out for testing purposes`);
      const text = lines.join('\n');
      const chunks = chunkText('big.md', text);

      expect(chunks.length).toBeGreaterThan(1);

      // Chunks should overlap
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeLessThan(chunks[i - 1].endLine);
      }
    });

    it('generates stable chunk IDs', () => {
      const text = 'Deterministic content';
      const a = chunkText('f.md', text);
      const b = chunkText('f.md', text);
      expect(a[0].id).toBe(b[0].id);
    });

    it('generates different IDs for different paths', () => {
      const text = 'Same content';
      const a = chunkText('a.md', text);
      const b = chunkText('b.md', text);
      expect(a[0].id).not.toBe(b[0].id);
    });
  });

  describe('chunkSessionMessages', () => {
    it('groups user-assistant turns', () => {
      const messages = [
        { role: 'user', content: 'What is TypeScript?' },
        { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
        { role: 'user', content: 'How do I use it?' },
        { role: 'assistant', content: 'Install it with npm install typescript.' },
      ];
      const chunks = chunkSessionMessages('sess-1', messages);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].path).toContain('sess-1');
    });

    it('handles empty messages', () => {
      const chunks = chunkSessionMessages('s', []);
      expect(chunks).toHaveLength(0);
    });
  });
});
