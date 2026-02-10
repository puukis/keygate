import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSkillAtPath, parseSkillMarkdown } from '../parser.js';

describe('skill parser', () => {
  it('parses valid skill markdown with defaults', () => {
    const parsed = parseSkillMarkdown(`---
name: repo-triage
description: Diagnose repo failures quickly
metadata: {"keygate":{"primaryEnv":"TEST_API_KEY"}}
---
Do work.
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.name).toBe('repo-triage');
    expect(parsed.value.userInvocable).toBe(true);
    expect(parsed.value.disableModelInvocation).toBe(false);
    expect(parsed.value.commandArgMode).toBe('raw');
    expect(parsed.value.metadata?.primaryEnv).toBe('TEST_API_KEY');
  });

  it('rejects invalid skill name', () => {
    const parsed = parseSkillMarkdown(`---
name: Invalid Name
description: bad
---
body
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain('must match');
  });

  it('rejects command dispatch without command tool', () => {
    const parsed = parseSkillMarkdown(`---
name: channel-ops
description: dispatch
command-dispatch: tool
---
body
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain('command-tool is required');
  });

  it('requires folder name to match skill name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-skill-parser-'));
    const skillDir = path.join(root, 'wrong-folder');
    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: right-name
description: ok
---
body
`,
      'utf8'
    );

    const parsed = await parseSkillAtPath(skillDir, 'workspace');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toContain('must match');
  });
});
