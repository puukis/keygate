import { describe, expect, it } from 'vitest';
import { formatCapabilitiesAndLimitsForReadability } from '../assistantOutputFormatter.js';

describe('formatCapabilitiesAndLimitsForReadability', () => {
  it('rewrites inline capability and limit lists to one bullet per line', () => {
    const input =
      "Current capabilities in this workspace: - Read/list/edit files in `/tmp/workspace` - Run allowed shell commands - Execute Python/JavaScript in a sandbox Current limits (Safe Mode): - File access is restricted to that workspace path - Many write/execute actions require your confirmation - I won't claim actions completed unless tool output confirms it";

    const output = formatCapabilitiesAndLimitsForReadability(input);

    expect(output).toBe(
      "Current capabilities in this workspace:\n" +
      "- Read/list/edit files in `/tmp/workspace`\n" +
      '- Run allowed shell commands\n' +
      '- Execute Python/JavaScript in a sandbox\n' +
      'Current limits (Safe Mode):\n' +
      '- File access is restricted to that workspace path\n' +
      '- Many write/execute actions require your confirmation\n' +
      "- I won't claim actions completed unless tool output confirms it"
    );
  });

  it('keeps already readable capability and limit bullet lists unchanged', () => {
    const input =
      'Capabilities:\n' +
      '- Read files\n' +
      '- Run shell commands\n\n' +
      'Limits (Safe Mode):\n' +
      '- Confirmation required for risky actions';

    expect(formatCapabilitiesAndLimitsForReadability(input)).toBe(input);
  });

  it('keeps unrelated prose unchanged', () => {
    const input = 'I checked the repository and updated three files.';
    expect(formatCapabilitiesAndLimitsForReadability(input)).toBe(input);
  });

  it('keeps inline bullet text unchanged when capability or limit context is missing', () => {
    const input = 'Shopping list: - apples - bananas - bread';
    expect(formatCapabilitiesAndLimitsForReadability(input)).toBe(input);
  });
});
