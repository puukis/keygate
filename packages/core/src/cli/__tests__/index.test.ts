import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  runTuiCommand,
  runSkillsCommand,
  runDoctorCommand,
  runPluginsCommand,
  runNgrokCommand,
  runRemoteCommand,
  runPluginCliBridge,
  loadConfigFromEnv,
} = vi.hoisted(() => ({
  runTuiCommand: vi.fn(async () => undefined),
  runSkillsCommand: vi.fn(async () => undefined),
  runDoctorCommand: vi.fn(async () => undefined),
  runPluginsCommand: vi.fn(async () => undefined),
  runNgrokCommand: vi.fn(async () => undefined),
  runRemoteCommand: vi.fn(async () => undefined),
  runPluginCliBridge: vi.fn(async () => false),
  loadConfigFromEnv: vi.fn(() => ({}) as any),
}));

vi.mock('../commands/tui.js', () => ({
  runTuiCommand,
}));
vi.mock('../commands/skills.js', () => ({
  runSkillsCommand,
}));
vi.mock('../commands/doctor.js', () => ({
  runDoctorCommand,
}));
vi.mock('../commands/plugins.js', () => ({
  runPluginsCommand,
}));
vi.mock('../commands/ngrok.js', () => ({
  runNgrokCommand,
}));
vi.mock('../commands/remote.js', () => ({
  runRemoteCommand,
}));
vi.mock('../../plugins/index.js', () => ({
  runPluginCliBridge,
}));
vi.mock('../../config/env.js', () => ({
  loadConfigFromEnv,
}));

import { printHelp, runCli } from '../index.js';

describe('cli index', () => {
  afterEach(() => {
    runTuiCommand.mockClear();
    runSkillsCommand.mockClear();
    runDoctorCommand.mockClear();
    runPluginsCommand.mockClear();
    runNgrokCommand.mockClear();
    runRemoteCommand.mockClear();
    runPluginCliBridge.mockClear();
    loadConfigFromEnv.mockClear();
  });

  it('routes tui command to runTuiCommand', async () => {
    const handled = await runCli(['tui']);
    expect(handled).toBe(true);
    expect(runTuiCommand).toHaveBeenCalledTimes(1);
  });

  it('routes skills command to runSkillsCommand', async () => {
    const handled = await runCli(['skills', 'list']);
    expect(handled).toBe(true);
    expect(runSkillsCommand).toHaveBeenCalledTimes(1);
  });

  it('routes doctor command to runDoctorCommand', async () => {
    const handled = await runCli(['doctor', '--non-interactive']);
    expect(handled).toBe(true);
    expect(runDoctorCommand).toHaveBeenCalledTimes(1);
  });

  it('routes plugins command to runPluginsCommand', async () => {
    const handled = await runCli(['plugins', 'list']);
    expect(handled).toBe(true);
    expect(runPluginsCommand).toHaveBeenCalledTimes(1);
  });

  it('routes ngrok command to runNgrokCommand', async () => {
    const handled = await runCli(['ngrok', 'status']);
    expect(handled).toBe(true);
    expect(runNgrokCommand).toHaveBeenCalledTimes(1);
  });

  it('routes remote command to runRemoteCommand', async () => {
    const handled = await runCli(['remote', 'ssh', 'status']);
    expect(handled).toBe(true);
    expect(runRemoteCommand).toHaveBeenCalledTimes(1);
  });

  it('prints tui command in help output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printHelp();
      const helpText = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(helpText).toContain('keygate tui');
      expect(helpText).toContain('keygate doctor');
      expect(helpText).toContain('keygate plugins');
      expect(helpText).toContain('keygate ngrok');
      expect(helpText).toContain('keygate remote tailscale');
      expect(helpText).toContain('web|discord|slack|whatsapp');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
