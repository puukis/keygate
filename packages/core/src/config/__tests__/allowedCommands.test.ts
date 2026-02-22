import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAllowedCommand,
  extractBaseCommand,
  extractBaseCommandFromCommandValue,
  loadAllowedCommands,
  normalizeBaseCommand,
} from '../allowedCommands.js';
import { getConfigDir } from '../env.js';

const ALLOWED_COMMANDS_FILE = 'allowed_commands.json';

describe('allowed command registry', () => {
  let configHome = '';

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-allowed-commands-'));
    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', configHome);
    } else {
      vi.stubEnv('XDG_CONFIG_HOME', configHome);
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (configHome) {
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('extracts the inner command for shell wrapper invocations', () => {
    const extracted = extractBaseCommand('/bin/zsh -lc touch ~/Desktop/main.py');
    expect(normalizeBaseCommand(extracted)).toBe('touch');
  });

  it('extracts the inner command from codex array command payloads', () => {
    const extracted = extractBaseCommandFromCommandValue([
      '/bin/zsh',
      '-lc',
      "printf 'def main():\\n    print(\\\"hello, world\\\")\\n' > /Users/leonardgunder/Desktop/main.py",
    ]);
    expect(normalizeBaseCommand(extracted)).toBe('printf');
  });

  it('extracts the inner command when wrapper payload is quoted', () => {
    const extracted = extractBaseCommand('FOO=bar /bin/bash -lc "git status"');
    expect(normalizeBaseCommand(extracted)).toBe('git');
  });

  it('normalizes malformed command strings to the executable only', () => {
    expect(normalizeBaseCommand("printf 'def main():\\n    print(\\\"hello,")).toBe('printf');
  });

  it('does not persist wrapper binaries', async () => {
    await addAllowedCommand('/bin/zsh');
    const loaded = await loadAllowedCommands();
    expect(loaded.commands).toEqual([]);
  });

  it('persists inner executable from wrapped command execution', async () => {
    const baseCommand = extractBaseCommand('/bin/zsh -lc touch ~/Desktop/main.py');
    await addAllowedCommand(baseCommand);
    const loaded = await loadAllowedCommands();
    expect(loaded.commands).toEqual(['touch']);
  });

  it('sanitizes legacy registry entries on load', async () => {
    const registryPath = path.join(getConfigDir(), ALLOWED_COMMANDS_FILE);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({ version: 1, commands: ['/bin/zsh', '/usr/bin/touch', 'echo'] }, null, 2)}\n`,
      'utf8'
    );

    const loaded = await loadAllowedCommands();
    expect(loaded.commands).toEqual(['echo', 'touch']);

    const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8')) as { commands?: string[] };
    expect(persisted.commands).toEqual(['echo', 'touch']);
  });
});
