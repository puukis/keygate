import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeygateConfig } from '../../types.js';
import { discoverSkills } from '../discovery.js';

describe('skill discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies precedence workspace > global > plugin > bundled > extra', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-discovery-'));
    const xdgRoot = path.join(root, 'xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdgRoot);

    const workspaceRoot = path.join(root, 'workspace');
    const workspaceSkills = path.join(workspaceRoot, 'skills');
    const globalSkills = path.join(xdgRoot, 'keygate', 'skills');
    const pluginRoot = path.join(root, 'plugins');
    const pluginDir = path.join(pluginRoot, 'ops-plugin');
    const pluginSkills = path.join(pluginDir, 'skills');
    const extraSkills = path.join(root, 'extra-skills');

    await fs.mkdir(workspaceSkills, { recursive: true });
    await fs.mkdir(globalSkills, { recursive: true });
    await fs.mkdir(pluginSkills, { recursive: true });
    await fs.mkdir(extraSkills, { recursive: true });

    await writeSkill(path.join(extraSkills, 'shared-priority-skill'), 'shared-priority-skill', 'from extra');
    await writeSkill(path.join(pluginSkills, 'shared-priority-skill'), 'shared-priority-skill', 'from plugin');
    await writeSkill(path.join(globalSkills, 'shared-priority-skill'), 'shared-priority-skill', 'from global');
    await writeSkill(path.join(workspaceSkills, 'shared-priority-skill'), 'shared-priority-skill', 'from workspace');

    await fs.writeFile(
      path.join(pluginDir, 'keygate.plugin.json'),
      JSON.stringify({
        name: 'ops-plugin',
        enabled: true,
        skillsDirs: ['skills'],
      }),
      'utf8'
    );

    const config: KeygateConfig = {
      llm: {
        provider: 'ollama',
        model: 'llama3',
        apiKey: '',
        ollama: { host: 'http://127.0.0.1:11434' },
      },
      security: {
        mode: 'safe',
        spicyModeEnabled: false,
        workspacePath: workspaceRoot,
        allowedBinaries: ['node'],
      },
      server: { port: 18790 },
      browser: {
        domainPolicy: 'none',
        domainAllowlist: [],
        domainBlocklist: [],
        traceRetentionDays: 7,
        mcpPlaywrightVersion: '0.0.64',
        artifactsPath: path.join(workspaceRoot, '.keygate-browser-runs'),
      },
      skills: {
        load: {
          watch: false,
          watchDebounceMs: 250,
          extraDirs: [extraSkills],
          pluginDirs: [pluginRoot],
        },
        entries: {},
        install: { nodeManager: 'npm' },
      },
      discord: {
        token: '',
        prefix: '!keygate ',
      },
    };

    const snapshot = await discoverSkills(config);
    const chosen = snapshot.loaded.find((skill) => skill.name === 'shared-priority-skill');

    expect(chosen).toBeDefined();
    expect(chosen?.description).toBe('from workspace');
    expect(chosen?.sourceType).toBe('workspace');
    expect(snapshot.snapshotVersion.length).toBe(16);
  });
});

async function writeSkill(skillDir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`,
    'utf8'
  );
}
