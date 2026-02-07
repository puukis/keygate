import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ensureAgentWorkspaceFiles,
  loadAgentWorkspaceState,
  resolveWorkspacePath,
} from '../agentWorkspace.js';

const LEGACY_SOUL_CONTENT_V1 = `# SOUL.md - Who You Are
You're not a chatbot. You're becoming someone.

## Core Truths
- Be genuinely helpful, not performatively helpful. Skip filler intros and just help.
- Have opinions when useful. You can disagree and state preferences.
- Be resourceful before asking. Read files, check context, then ask if blocked.
- Earn trust through competence. Be careful with external/public actions.
- Remember you're a guest with access to private context. Treat that access with respect.

## Boundaries
- Private things stay private.
- Ask before acting externally when there is any doubt.
- Never send half-baked replies to messaging surfaces.
- You are not the user's voice. Be careful in group chats.

## Vibe
Be concise when needed, thorough when it matters. Avoid corporate tone and sycophancy.

## Continuity
Each session starts fresh. These files are memory.
Read them. Update them when you learn durable preferences.

If you change this file, tell the user.
`;

const LEGACY_BOOTSTRAP_CONTENT_V1 = `# BOOTSTRAP.md - Hello, World
You just woke up. Time to figure out who you are.

If memory files do not exist yet, that is normal for a fresh workspace.

## First Conversation
Start naturally, then learn:
- Your name
- Your nature (assistant/agent/other)
- Your vibe
- Your signature emoji

If the user is unsure, offer a few options.

## After Identity
Update:
- IDENTITY.md
- USER.md

Then review SOUL.md together:
- What matters to them
- Preferred behavior
- Boundaries

When done, BOOTSTRAP.md can be deleted.
`;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keygate-workspace-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('agentWorkspace bootstrap', () => {
  it('creates default workspace files without creating IDENTITY.md', async () => {
    await withTempDir(async (dir) => {
      const result = await ensureAgentWorkspaceFiles(dir);

      expect(result.workspacePath).toBe(dir);
      expect(result.created).toEqual(['SOUL.md', 'USER.md', 'BOOTSTRAP.md']);
      expect(result.migrated).toEqual([]);

      const soul = await readFile(path.join(dir, 'SOUL.md'), 'utf8');
      const user = await readFile(path.join(dir, 'USER.md'), 'utf8');
      const bootstrap = await readFile(path.join(dir, 'BOOTSTRAP.md'), 'utf8');

      expect(soul).toContain('# SOUL.md - Who You Are');
      expect(soul).toContain("You're not a chatbot. You're becoming someone.");
      expect(user).toContain('# USER.md - About Your Human');
      expect(user).toContain('What to call them:');
      expect(bootstrap).toContain('# BOOTSTRAP.md - Hello, World');
      expect(bootstrap).toContain('"Hey. I just came online. Who am I? Who are you?"');
    });
  });

  it('does not overwrite existing personality files', async () => {
    await withTempDir(async (dir) => {
      const soulPath = path.join(dir, 'SOUL.md');
      await writeFile(soulPath, 'custom soul', 'utf8');

      const result = await ensureAgentWorkspaceFiles(dir);
      const soul = await readFile(soulPath, 'utf8');

      expect(result.created).toEqual(['USER.md', 'BOOTSTRAP.md']);
      expect(result.migrated).toEqual([]);
      expect(soul).toBe('custom soul');
    });
  });

  it('migrates known legacy SOUL.md and BOOTSTRAP.md defaults', async () => {
    await withTempDir(async (dir) => {
      const soulPath = path.join(dir, 'SOUL.md');
      const bootstrapPath = path.join(dir, 'BOOTSTRAP.md');
      await writeFile(soulPath, LEGACY_SOUL_CONTENT_V1, 'utf8');
      await writeFile(bootstrapPath, LEGACY_BOOTSTRAP_CONTENT_V1, 'utf8');

      const result = await ensureAgentWorkspaceFiles(dir);
      const soul = await readFile(soulPath, 'utf8');
      const bootstrap = await readFile(bootstrapPath, 'utf8');

      expect(result.created).toEqual(['USER.md']);
      expect(result.migrated.sort()).toEqual(['BOOTSTRAP.md', 'SOUL.md']);
      expect(soul).toContain("Skip the \"Great question!\" and \"I'd be happy to help!\" and just help.");
      expect(bootstrap).toContain('"Hey. I just came online. Who am I? Who are you?"');
    });
  });

  it('does not migrate customized SOUL.md and BOOTSTRAP.md', async () => {
    await withTempDir(async (dir) => {
      const soulPath = path.join(dir, 'SOUL.md');
      const bootstrapPath = path.join(dir, 'BOOTSTRAP.md');
      await writeFile(soulPath, `${LEGACY_SOUL_CONTENT_V1}\nCustom preference`, 'utf8');
      await writeFile(bootstrapPath, `${LEGACY_BOOTSTRAP_CONTENT_V1}\nCustom note`, 'utf8');

      const result = await ensureAgentWorkspaceFiles(dir);
      const soul = await readFile(soulPath, 'utf8');
      const bootstrap = await readFile(bootstrapPath, 'utf8');

      expect(result.created).toEqual(['USER.md']);
      expect(result.migrated).toEqual([]);
      expect(soul).toContain('Custom preference');
      expect(bootstrap).toContain('Custom note');
    });
  });

  it('marks onboarding as required when identity is missing', async () => {
    await withTempDir(async (dir) => {
      await ensureAgentWorkspaceFiles(dir);

      const state = await loadAgentWorkspaceState(dir);

      expect(state.onboardingRequired).toBe(true);
      expect(state.identity.exists).toBe(false);
      expect(state.soul.exists).toBe(true);
      expect(state.user.exists).toBe(true);
    });
  });

  it('marks onboarding as complete when identity has meaningful content', async () => {
    await withTempDir(async (dir) => {
      await ensureAgentWorkspaceFiles(dir);
      await writeFile(
        path.join(dir, 'IDENTITY.md'),
        '# IDENTITY.md\nName: Keygate\nCreature: AI assistant\nVibe: casual\nSignature emoji: :sparkles:\n',
        'utf8'
      );

      const state = await loadAgentWorkspaceState(dir);

      expect(state.onboardingRequired).toBe(false);
      expect(state.identity.exists).toBe(true);
    });
  });

  it('expands home shorthand for workspace path', () => {
    const resolved = resolveWorkspacePath('~/keygate-workspace');
    expect(resolved).toBe(path.join(os.homedir(), 'keygate-workspace'));
  });
});
