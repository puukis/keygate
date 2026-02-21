import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  loadRegistry,
  saveRegistry,
  publishSkill,
  unpublishSkill,
  searchMarketplace,
  getMarketplaceEntry,
  listFeatured,
  recordDownload,
  type MarketplaceRegistry,
} from '../marketplace.js';

// Override config dir to use a temp directory
const originalEnv = process.env['XDG_CONFIG_HOME'];
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-marketplace-test-'));
  process.env['XDG_CONFIG_HOME'] = tmpDir;
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = originalEnv;
  }

  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('marketplace registry', () => {
  it('loadRegistry returns empty registry when no file exists', async () => {
    const registry = await loadRegistry();
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.entries)).toHaveLength(0);
  });

  it('saveRegistry and loadRegistry round-trip', async () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'test-skill': {
          name: 'test-skill',
          description: 'A test skill',
          version: '0.1.0-abc12345',
          author: 'tester',
          source: '/some/path',
          tags: ['testing'],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 5,
          featured: false,
        },
      },
    };

    await saveRegistry(registry);
    const loaded = await loadRegistry();
    expect(loaded.version).toBe(1);
    expect(loaded.entries['test-skill']!.name).toBe('test-skill');
    expect(loaded.entries['test-skill']!.downloads).toBe(5);
    expect(loaded.entries['test-skill']!.tags).toEqual(['testing']);
  });

  it('loadRegistry handles corrupted file gracefully', async () => {
    const registryPath = path.join(tmpDir, 'keygate', 'marketplace', 'registry.json');
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, 'not valid json!!!', 'utf8');

    const registry = await loadRegistry();
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.entries)).toHaveLength(0);
  });
});

describe('publishSkill', () => {
  it('publishes a skill from a valid SKILL.md', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: A test skill for marketplace
---
This is the skill body.
`,
      'utf8'
    );

    const entry = await publishSkill({
      skillPath: skillDir,
      author: 'tester',
      source: skillDir,
      tags: ['test', 'demo'],
      featured: true,
    });

    expect(entry.name).toBe('my-skill');
    expect(entry.description).toBe('A test skill for marketplace');
    expect(entry.author).toBe('tester');
    expect(entry.tags).toEqual(['test', 'demo']);
    expect(entry.featured).toBe(true);
    expect(entry.downloads).toBe(0);
    expect(entry.version).toMatch(/^0\.1\.0-[0-9a-f]{8}$/);

    // Verify persisted
    const registry = await loadRegistry();
    expect(registry.entries['my-skill']).toBeDefined();
  });

  it('updates an existing skill preserving publishedAt and downloads', async () => {
    const skillDir = path.join(tmpDir, 'update-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: update-skill
description: Original description
---
Body v1.
`,
      'utf8'
    );

    const first = await publishSkill({
      skillPath: skillDir,
      author: 'author1',
      source: skillDir,
    });

    // Simulate some downloads
    await recordDownload('update-skill');
    await recordDownload('update-skill');

    // Update the skill
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: update-skill
description: Updated description
---
Body v2.
`,
      'utf8'
    );

    const second = await publishSkill({
      skillPath: skillDir,
      author: 'author1',
      source: skillDir,
    });

    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second.downloads).toBe(2);
    expect(second.description).toBe('Updated description');
  });

  it('throws on invalid skill path', async () => {
    await expect(
      publishSkill({
        skillPath: path.join(tmpDir, 'nonexistent'),
        author: 'test',
        source: '/nowhere',
      })
    ).rejects.toThrow();
  });
});

describe('unpublishSkill', () => {
  it('removes a published skill', async () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'doomed-skill': {
          name: 'doomed-skill',
          description: 'About to be removed',
          version: '0.1.0-deadbeef',
          author: 'ghost',
          source: '/gone',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 10,
          featured: false,
        },
      },
    };
    await saveRegistry(registry);

    const result = await unpublishSkill('doomed-skill');
    expect(result).toBe(true);

    const after = await loadRegistry();
    expect(after.entries['doomed-skill']).toBeUndefined();
  });

  it('returns false for non-existent skill', async () => {
    const result = await unpublishSkill('ghost-skill');
    expect(result).toBe(false);
  });
});

describe('searchMarketplace', () => {
  const registry: MarketplaceRegistry = {
    version: 1,
    entries: {
      'alpha-tool': {
        name: 'alpha-tool',
        description: 'Alpha testing tool',
        version: '0.1.0-aaaa',
        author: 'alice',
        source: '/a',
        tags: ['testing', 'alpha'],
        publishedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        downloads: 50,
        featured: true,
      },
      'beta-checker': {
        name: 'beta-checker',
        description: 'Beta quality checks',
        version: '0.1.0-bbbb',
        author: 'bob',
        source: '/b',
        tags: ['testing', 'beta'],
        publishedAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        downloads: 30,
        featured: false,
      },
      'gamma-deploy': {
        name: 'gamma-deploy',
        description: 'Deployment automation',
        version: '0.1.0-cccc',
        author: 'charlie',
        source: '/c',
        tags: ['deploy', 'ci'],
        publishedAt: '2024-01-03T00:00:00.000Z',
        updatedAt: '2024-01-03T00:00:00.000Z',
        downloads: 100,
        featured: false,
      },
    },
  };

  it('returns all entries for empty query', () => {
    const result = searchMarketplace(registry, '');
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);
    // Featured first
    expect(result.entries[0]!.name).toBe('alpha-tool');
    // Then by downloads
    expect(result.entries[1]!.name).toBe('gamma-deploy');
    expect(result.entries[2]!.name).toBe('beta-checker');
  });

  it('filters by query matching name', () => {
    const result = searchMarketplace(registry, 'beta');
    expect(result.total).toBe(1);
    expect(result.entries[0]!.name).toBe('beta-checker');
  });

  it('filters by query matching description', () => {
    const result = searchMarketplace(registry, 'deployment');
    expect(result.total).toBe(1);
    expect(result.entries[0]!.name).toBe('gamma-deploy');
  });

  it('filters by query matching author', () => {
    const result = searchMarketplace(registry, 'alice');
    expect(result.total).toBe(1);
    expect(result.entries[0]!.name).toBe('alpha-tool');
  });

  it('filters by tags', () => {
    const result = searchMarketplace(registry, '', { tags: ['deploy'] });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.name).toBe('gamma-deploy');
  });

  it('combines query and tag filters', () => {
    const result = searchMarketplace(registry, 'testing', { tags: ['alpha'] });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.name).toBe('alpha-tool');
  });

  it('respects limit and offset', () => {
    const result = searchMarketplace(registry, '', { limit: 1, offset: 1 });
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe('gamma-deploy');
  });

  it('returns empty for no matches', () => {
    const result = searchMarketplace(registry, 'nonexistent-xyz');
    expect(result.total).toBe(0);
    expect(result.entries).toHaveLength(0);
  });
});

describe('getMarketplaceEntry', () => {
  it('returns entry by name', () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'found-skill': {
          name: 'found-skill',
          description: 'Can be found',
          version: '0.1.0-ffff',
          author: 'finder',
          source: '/f',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 0,
          featured: false,
        },
      },
    };

    const entry = getMarketplaceEntry(registry, 'found-skill');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('found-skill');
  });

  it('returns null for missing entry', () => {
    const registry: MarketplaceRegistry = { version: 1, entries: {} };
    expect(getMarketplaceEntry(registry, 'nope')).toBeNull();
  });
});

describe('listFeatured', () => {
  it('returns only featured entries sorted by downloads', () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'feat-a': {
          name: 'feat-a',
          description: 'Featured A',
          version: '0.1.0-a',
          author: 'x',
          source: '/a',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 10,
          featured: true,
        },
        'feat-b': {
          name: 'feat-b',
          description: 'Featured B',
          version: '0.1.0-b',
          author: 'x',
          source: '/b',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 100,
          featured: true,
        },
        'regular': {
          name: 'regular',
          description: 'Not featured',
          version: '0.1.0-c',
          author: 'x',
          source: '/c',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 500,
          featured: false,
        },
      },
    };

    const featured = listFeatured(registry);
    expect(featured).toHaveLength(2);
    expect(featured[0]!.name).toBe('feat-b');
    expect(featured[1]!.name).toBe('feat-a');
  });

  it('respects limit', () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'a': { name: 'a', description: '', version: '', author: '', source: '', tags: [], publishedAt: '', updatedAt: '', downloads: 0, featured: true },
        'b': { name: 'b', description: '', version: '', author: '', source: '', tags: [], publishedAt: '', updatedAt: '', downloads: 0, featured: true },
        'c': { name: 'c', description: '', version: '', author: '', source: '', tags: [], publishedAt: '', updatedAt: '', downloads: 0, featured: true },
      },
    };

    const featured = listFeatured(registry, 2);
    expect(featured).toHaveLength(2);
  });
});

describe('recordDownload', () => {
  it('increments download count for existing entry', async () => {
    const registry: MarketplaceRegistry = {
      version: 1,
      entries: {
        'dl-skill': {
          name: 'dl-skill',
          description: 'Downloadable',
          version: '0.1.0-d',
          author: 'dl',
          source: '/d',
          tags: [],
          publishedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          downloads: 0,
          featured: false,
        },
      },
    };
    await saveRegistry(registry);

    await recordDownload('dl-skill');
    await recordDownload('dl-skill');
    await recordDownload('dl-skill');

    const loaded = await loadRegistry();
    expect(loaded.entries['dl-skill']!.downloads).toBe(3);
  });

  it('does nothing for non-existent entry', async () => {
    await saveRegistry({ version: 1, entries: {} });
    // Should not throw
    await recordDownload('ghost');
    const loaded = await loadRegistry();
    expect(Object.keys(loaded.entries)).toHaveLength(0);
  });
});
