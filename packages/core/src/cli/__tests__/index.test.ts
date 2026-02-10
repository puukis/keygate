import { afterEach, describe, expect, it, vi } from 'vitest';

const { runTuiCommand } = vi.hoisted(() => ({
  runTuiCommand: vi.fn(async () => undefined),
}));

vi.mock('../commands/tui.js', () => ({
  runTuiCommand,
}));

import { printHelp, runCli } from '../index.js';

describe('cli index', () => {
  afterEach(() => {
    runTuiCommand.mockClear();
  });

  it('routes tui command to runTuiCommand', async () => {
    const handled = await runCli(['tui']);
    expect(handled).toBe(true);
    expect(runTuiCommand).toHaveBeenCalledTimes(1);
  });

  it('prints tui command in help output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printHelp();
      const helpText = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(helpText).toContain('keygate tui');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
