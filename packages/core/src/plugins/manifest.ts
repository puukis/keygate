import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  PluginDiagnostic,
  PluginManifest,
  PluginManifestCli,
  PluginManifestCommandReservation,
  PluginManifestEngine,
  PluginManifestRaw,
  PluginSourceKind,
  ResolvedPluginManifest,
} from './types.js';

const MANIFEST_FILENAME = 'keygate.plugin.json';
const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const JS_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

let cachedCoreVersion: string | null = null;

export function getPluginManifestFilename(): string {
  return MANIFEST_FILENAME;
}

export async function findPluginManifestPaths(pluginRoot: string): Promise<string[]> {
  const manifests: string[] = [];
  const rootManifest = path.join(pluginRoot, MANIFEST_FILENAME);

  if (await pathExists(rootManifest)) {
    manifests.push(rootManifest);
  }

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  } catch {
    return manifests;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedManifest = path.join(pluginRoot, entry.name, MANIFEST_FILENAME);
    if (await pathExists(nestedManifest)) {
      manifests.push(nestedManifest);
    }
  }

  return manifests;
}

export async function loadPluginManifest(
  manifestPath: string,
  options: {
    sourceKind: PluginSourceKind;
    scope: 'workspace' | 'global' | null;
    precedence: number;
  }
): Promise<ResolvedPluginManifest> {
  const rawText = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(rawText) as PluginManifestRaw;
  const rootDir = path.dirname(manifestPath);
  const normalized = normalizeManifest(parsed);
  const realRootDir = await safeRealpath(rootDir);

  const skillDirPaths = await Promise.all(
    normalized.skillsDirs.map((entry) => resolveManifestRelativePath(realRootDir, entry, {
      kind: 'skillsDirs',
      mustExist: true,
      mustBeDirectory: true,
    }))
  );

  const entryPath = normalized.entry
    ? await resolveManifestRelativePath(realRootDir, normalized.entry, {
      kind: 'entry',
      mustExist: true,
      mustBeDirectory: false,
      validateExtension: true,
    })
    : undefined;

  const configSchemaPath = normalized.configSchema
    ? await resolveManifestRelativePath(realRootDir, normalized.configSchema, {
      kind: 'configSchema',
      mustExist: true,
      mustBeDirectory: false,
      allowJson: true,
    })
    : undefined;

  if (normalized.entry) {
    validateRuntimeManifest(normalized);
    const engineRange = normalized.engine?.keygate ?? '';
    const version = await getCorePackageVersion();
    if (!satisfiesSimpleSemver(version, engineRange)) {
      throw new Error(
        `Plugin requires Keygate ${engineRange}, but installed @puukis/core is ${version}.`
      );
    }
  }

  return {
    ...normalized,
    runtimeCapable: Boolean(entryPath),
    rootDir: realRootDir,
    manifestPath: path.resolve(manifestPath),
    entryPath,
    configSchemaPath,
    skillDirPaths,
    sourceKind: options.sourceKind,
    scope: options.scope,
    precedence: options.precedence,
  };
}

export function normalizeManifest(input: PluginManifestRaw): PluginManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Plugin manifest must be a JSON object.');
  }

  const schemaVersion = normalizePositiveInteger(input['schemaVersion'], 1);
  const name = normalizeRequiredString(input['name'], 'Plugin manifest requires non-empty "name"');
  const id = normalizeOptionalString(input['id']);
  const version = normalizeOptionalString(input['version']);
  const description = normalizeOptionalString(input['description']);
  const entry = normalizeOptionalString(input['entry']);
  const configSchema = normalizeOptionalString(input['configSchema']);
  const skillsDirs = normalizeStringArray(input['skillsDirs']);
  const enabled = input['enabled'] !== false;
  const requiresConfig = normalizeStringArray(input['requiresConfig']);
  const engine = normalizeEngine(input['engine']);
  const cli = normalizeCli(input['cli']);

  if (!entry && skillsDirs.length === 0) {
    throw new Error('Plugin manifest must declare "entry" or at least one "skillsDirs" path.');
  }

  return {
    schemaVersion,
    id,
    name,
    version,
    description,
    entry,
    engine,
    skillsDirs,
    configSchema,
    cli,
    enabled,
    requiresConfig,
  };
}

export function validateRuntimeManifest(manifest: PluginManifest): void {
  if (!manifest.entry) {
    return;
  }

  if (!manifest.id || !RUNTIME_ID_PATTERN.test(manifest.id)) {
    throw new Error('Runtime plugin manifest requires "id" matching ^[a-z0-9][a-z0-9-]{1,62}$.');
  }

  if (!manifest.version) {
    throw new Error('Runtime plugin manifest requires non-empty "version".');
  }

  if (!manifest.description) {
    throw new Error('Runtime plugin manifest requires non-empty "description".');
  }

  if (!manifest.engine?.keygate) {
    throw new Error('Runtime plugin manifest requires "engine.keygate".');
  }
}

export function collectReservedCliCommands(manifest: Pick<PluginManifest, 'cli'>): string[] {
  return (manifest.cli?.commands ?? []).map((command) => command.name);
}

export function filterManifestDiagnostics(
  diagnostics: PluginDiagnostic[],
  manifestPath: string
): PluginDiagnostic[] {
  const target = path.resolve(manifestPath);
  return diagnostics.filter((entry) => path.resolve(entry.location) === target);
}

async function resolveManifestRelativePath(
  rootDir: string,
  relativePath: string,
  options: {
    kind: 'entry' | 'skillsDirs' | 'configSchema';
    mustExist: boolean;
    mustBeDirectory: boolean;
    validateExtension?: boolean;
    allowJson?: boolean;
  }
): Promise<string> {
  const resolved = path.resolve(rootDir, relativePath);
  const realResolved = await safeRealpath(resolved);

  if (!isPathWithin(realResolved, rootDir)) {
    throw new Error(`Plugin manifest ${options.kind} path escapes plugin root: ${relativePath}`);
  }

  if (options.mustExist) {
    const stat = await fs.stat(realResolved).catch(() => null);
    if (!stat) {
      throw new Error(`Plugin manifest ${options.kind} path does not exist: ${relativePath}`);
    }

    if (options.mustBeDirectory && !stat.isDirectory()) {
      throw new Error(`Plugin manifest ${options.kind} must point to a directory: ${relativePath}`);
    }

    if (!options.mustBeDirectory && stat.isDirectory()) {
      throw new Error(`Plugin manifest ${options.kind} must point to a file: ${relativePath}`);
    }
  }

  const extension = path.extname(realResolved).toLowerCase();
  if (options.validateExtension && !JS_ENTRY_EXTENSIONS.has(extension)) {
    throw new Error('Plugin manifest "entry" must reference a JavaScript module (.js, .mjs, or .cjs).');
  }

  if (options.allowJson && extension !== '.json') {
    throw new Error('Plugin manifest "configSchema" must reference a .json file.');
  }

  return realResolved;
}

async function getCorePackageVersion(): Promise<string> {
  if (cachedCoreVersion) {
    return cachedCoreVersion;
  }

  const packageUrl = new URL('../../package.json', import.meta.url);
  const raw = await fs.readFile(packageUrl, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  cachedCoreVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  return cachedCoreVersion;
}

function normalizeRequiredString(value: unknown, error: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(error);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeEngine(value: unknown): PluginManifestEngine | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const keygate = normalizeOptionalString((value as Record<string, unknown>)['keygate']);
  if (!keygate) {
    return undefined;
  }

  return { keygate };
}

function normalizeCli(value: unknown): PluginManifestCli | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const rawCommands = (value as Record<string, unknown>)['commands'];
  if (!Array.isArray(rawCommands)) {
    return undefined;
  }

  const commands: PluginManifestCommandReservation[] = [];
  for (const rawCommand of rawCommands) {
    if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
      continue;
    }

    const name = normalizeOptionalString((rawCommand as Record<string, unknown>)['name']);
    if (!name) {
      continue;
    }

    const summary = normalizeOptionalString((rawCommand as Record<string, unknown>)['summary']);
    commands.push(summary ? { name, summary } : { name });
  }

  if (commands.length === 0) {
    return undefined;
  }

  return { commands };
}

async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const normalizedRoot = ensureTrailingSeparator(path.resolve(root));
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === path.resolve(root) || normalizedCandidate.startsWith(normalizedRoot);
}

function ensureTrailingSeparator(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) {
      return 1;
    }
    if (left[index]! < right[index]!) {
      return -1;
    }
  }

  return 0;
}

export function satisfiesSimpleSemver(version: string, range: string): boolean {
  const normalizedRange = range.trim();
  const parsedVersion = parseVersion(version);
  if (!parsedVersion || !normalizedRange) {
    return false;
  }

  if (normalizedRange.startsWith('^')) {
    const min = parseVersion(normalizedRange.slice(1));
    if (!min) {
      return false;
    }

    const max: [number, number, number] =
      min[0] > 0
        ? [min[0] + 1, 0, 0]
        : min[1] > 0
          ? [0, min[1] + 1, 0]
          : [0, 0, min[2] + 1];

    return compareVersion(parsedVersion, min) >= 0 && compareVersion(parsedVersion, max) < 0;
  }

  const exact = parseVersion(normalizedRange.replace(/^[=v]+/, ''));
  if (!exact) {
    return false;
  }

  return compareVersion(parsedVersion, exact) === 0;
}
