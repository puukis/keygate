import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPluginCatalog } from '../catalog.js';
import { loadPluginManifest, satisfiesSimpleSemver } from '../manifest.js';
import type { KeygateConfig } from '../../types.js';

describe('plugin manifest parsing', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('loads a runtime plugin manifest and resolves paths inside the plugin root', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-plugin-manifest-'));
    await fs.mkdir(path.join(tempRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'dist', 'index.js'), 'export default { setup() {} };\n', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'plugin.config.schema.json'), '{"type":"object"}\n', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'keygate.plugin.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'manifest-test',
      name: 'Manifest Test',
      version: '0.0.1',
      description: 'Test plugin',
      entry: './dist/index.js',
      engine: { keygate: '^0.1.11' },
      configSchema: './plugin.config.schema.json',
      cli: {
        commands: [{ name: 'manifest-test' }],
      },
    }, null, 2), 'utf8');

    const manifest = await loadPluginManifest(path.join(tempRoot, 'keygate.plugin.json'), {
      sourceKind: 'workspace',
      scope: 'workspace',
      precedence: 100,
    });
    const realRoot = await fs.realpath(tempRoot);

    expect(manifest.id).toBe('manifest-test');
    expect(manifest.runtimeCapable).toBe(true);
    expect(manifest.entryPath).toBe(path.join(realRoot, 'dist', 'index.js'));
    expect(manifest.configSchemaPath).toBe(path.join(realRoot, 'plugin.config.schema.json'));
  });

  it('rejects manifest-relative paths that escape the plugin root', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-plugin-escape-'));
    await fs.writeFile(path.join(tempRoot, 'keygate.plugin.json'), JSON.stringify({
      name: 'Escaping Plugin',
      skillsDirs: ['../outside'],
    }, null, 2), 'utf8');

    await expect(loadPluginManifest(path.join(tempRoot, 'keygate.plugin.json'), {
      sourceKind: 'workspace',
      scope: 'workspace',
      precedence: 100,
    })).rejects.toThrow('escapes plugin root');
  });

  it('detects CLI command collisions in the catalog', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-plugin-catalog-'));
    const first = path.join(tempRoot, 'first');
    const second = path.join(tempRoot, 'second');
    await fs.mkdir(path.join(first, 'dist'), { recursive: true });
    await fs.mkdir(path.join(second, 'dist'), { recursive: true });
    await fs.writeFile(path.join(first, 'dist', 'index.js'), 'export default { setup() {} };\n', 'utf8');
    await fs.writeFile(path.join(second, 'dist', 'index.js'), 'export default { setup() {} };\n', 'utf8');

    const manifest = {
      schemaVersion: 1,
      version: '0.0.1',
      description: 'Collision test',
      entry: './dist/index.js',
      engine: { keygate: '^0.1.11' },
      cli: { commands: [{ name: 'collision' }] },
    };

    await fs.writeFile(path.join(first, 'keygate.plugin.json'), JSON.stringify({
      ...manifest,
      id: 'collision-one',
      name: 'Collision One',
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(second, 'keygate.plugin.json'), JSON.stringify({
      ...manifest,
      id: 'collision-two',
      name: 'Collision Two',
    }, null, 2), 'utf8');

    const config = buildConfig(tempRoot);
    const catalog = await discoverPluginCatalog(config);

    expect(catalog.commandCollisions).toEqual([
      {
        command: 'collision',
        pluginIds: ['collision-one', 'collision-two'],
      },
    ]);
  });
});

describe('satisfiesSimpleSemver', () => {
  it('supports exact and caret ranges', () => {
    expect(satisfiesSimpleSemver('0.1.11', '^0.1.0')).toBe(true);
    expect(satisfiesSimpleSemver('0.1.11', '^0.2.0')).toBe(false);
    expect(satisfiesSimpleSemver('0.1.11', '0.1.11')).toBe(true);
    expect(satisfiesSimpleSemver('0.1.11', '=0.1.10')).toBe(false);
  });
});

function buildConfig(pluginPath: string): KeygateConfig {
  return {
    llm: {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: '',
      ollama: {
        host: 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: false,
      spicyMaxObedienceEnabled: false,
      workspacePath: pluginPath,
      allowedBinaries: [],
    },
    server: {
      port: 18790,
      apiToken: '',
    },
    browser: {
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64',
      artifactsPath: path.join(pluginPath, '.browser'),
    },
    skills: {
      load: {
        watch: false,
        watchDebounceMs: 250,
        extraDirs: [],
        pluginDirs: [],
      },
      entries: {},
      install: {
        nodeManager: 'npm',
      },
    },
    plugins: {
      load: {
        watch: false,
        watchDebounceMs: 250,
        paths: [pluginPath],
      },
      entries: {},
      install: {
        nodeManager: 'npm',
      },
    },
  };
}
