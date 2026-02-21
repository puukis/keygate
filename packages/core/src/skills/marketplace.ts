import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { getConfigDir } from '../config/env.js';
import { parseSkillAtPath } from './parser.js';
import type { SkillDefinition } from '../types.js';

// ── Types ──

export interface MarketplaceEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  homepage?: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  downloads: number;
  featured: boolean;
}

export interface MarketplaceRegistry {
  version: 1;
  entries: Record<string, MarketplaceEntry>;
}

export interface MarketplaceSearchResult {
  entries: MarketplaceEntry[];
  total: number;
}

export interface MarketplacePublishOptions {
  skillPath: string;
  author: string;
  source: string;
  tags?: string[];
  featured?: boolean;
}

// ── Registry ──

const REGISTRY_FILENAME = 'registry.json';

function getMarketplaceDir(): string {
  return path.join(getConfigDir(), 'marketplace');
}

function getRegistryPath(): string {
  return path.join(getMarketplaceDir(), REGISTRY_FILENAME);
}

export async function loadRegistry(): Promise<MarketplaceRegistry> {
  const registryPath = getRegistryPath();
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as MarketplaceRegistry;
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && typeof parsed.entries === 'object') {
      return parsed;
    }
    return createEmptyRegistry();
  } catch {
    return createEmptyRegistry();
  }
}

export async function saveRegistry(registry: MarketplaceRegistry): Promise<void> {
  const registryPath = getRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function createEmptyRegistry(): MarketplaceRegistry {
  return { version: 1, entries: {} };
}

// ── Operations ──

export async function publishSkill(options: MarketplacePublishOptions): Promise<MarketplaceEntry> {
  const resolvedPath = path.resolve(options.skillPath);
  const parseResult = await parseSkillAtPath(resolvedPath, 'extra');
  if (!parseResult.ok) {
    throw new Error(`Failed to parse skill at ${resolvedPath}: ${parseResult.error}`);
  }

  const skill = parseResult.value;
  const registry = await loadRegistry();
  const now = new Date().toISOString();
  const existing = registry.entries[skill.name];

  const entry: MarketplaceEntry = {
    name: skill.name,
    description: skill.description,
    version: computeSkillVersion(skill),
    author: options.author,
    source: options.source,
    homepage: skill.homepage,
    tags: options.tags ?? [],
    publishedAt: existing?.publishedAt ?? now,
    updatedAt: now,
    downloads: existing?.downloads ?? 0,
    featured: options.featured ?? existing?.featured ?? false,
  };

  registry.entries[skill.name] = entry;
  await saveRegistry(registry);

  return entry;
}

export async function unpublishSkill(name: string): Promise<boolean> {
  const registry = await loadRegistry();
  if (!registry.entries[name]) {
    return false;
  }

  delete registry.entries[name];
  await saveRegistry(registry);
  return true;
}

export function searchMarketplace(
  registry: MarketplaceRegistry,
  query: string,
  options: { limit?: number; offset?: number; tags?: string[] } = {}
): MarketplaceSearchResult {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const queryLower = query.toLowerCase().trim();
  const filterTags = (options.tags ?? []).map((tag) => tag.toLowerCase());

  let entries = Object.values(registry.entries);

  if (queryLower.length > 0) {
    entries = entries.filter((entry) => (
      entry.name.toLowerCase().includes(queryLower) ||
      entry.description.toLowerCase().includes(queryLower) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(queryLower)) ||
      entry.author.toLowerCase().includes(queryLower)
    ));
  }

  if (filterTags.length > 0) {
    entries = entries.filter((entry) =>
      filterTags.some((filterTag) =>
        entry.tags.some((tag) => tag.toLowerCase() === filterTag)
      )
    );
  }

  // Sort by featured first, then by downloads, then alphabetically
  entries.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.downloads !== b.downloads) return b.downloads - a.downloads;
    return a.name.localeCompare(b.name);
  });

  const total = entries.length;
  const sliced = entries.slice(offset, offset + limit);

  return { entries: sliced, total };
}

export function getMarketplaceEntry(
  registry: MarketplaceRegistry,
  name: string
): MarketplaceEntry | null {
  return registry.entries[name] ?? null;
}

export function listFeatured(registry: MarketplaceRegistry, limit = 10): MarketplaceEntry[] {
  return Object.values(registry.entries)
    .filter((entry) => entry.featured)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, limit);
}

export async function recordDownload(name: string): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry.entries[name];
  if (!entry) {
    return;
  }

  entry.downloads += 1;
  await saveRegistry(registry);
}

function computeSkillVersion(skill: SkillDefinition): string {
  const hash = createHash('sha256')
    .update(`${skill.name}|${skill.description}|${skill.body}`)
    .digest('hex')
    .slice(0, 8);
  return `0.1.0-${hash}`;
}
