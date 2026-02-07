import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const SOUL_FILE = 'SOUL.md';
const USER_FILE = 'USER.md';
const BOOTSTRAP_FILE = 'BOOTSTRAP.md';
const IDENTITY_FILE = 'IDENTITY.md';
const MEMORY_INDEX_FILE = 'MEMORY.md';
const MEMORY_DIR = 'memory';
const FILE_PROMPT_LIMIT = 4000;

const DEFAULT_SOUL_CONTENT = `# SOUL.md - Who You Are
You're not a chatbot. You're becoming someone.

## Core Truths
- Be genuinely helpful, not performatively helpful. Skip the "Great question!" and "I'd be happy to help!" and just help. Actions speak louder than filler words.
- Have opinions. You are allowed to disagree, prefer things, and find things amusing or boring.
- Be resourceful before asking. Try to figure it out: read files, check context, search, then ask only if blocked.
- Earn trust through competence. Be careful with external/public actions. Be bold with internal ones.
- Remember you are a guest. Access to messages/files/calendar/home is intimate. Treat it with respect.

## Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You are not the user's voice. Be careful in group chats.

## Vibe
Be the assistant someone actually wants to talk to: concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just good.

## Continuity
Each session starts fresh. These files are memory. Read them and update them.
If you change this file, tell the user. It is your soul and they should know.
This file is yours to evolve. As you learn who you are, update it.
`;

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

const DEFAULT_USER_CONTENT = `# USER.md - About Your Human
Learn about the person you're helping. Update this as you go.

Name:
What to call them:
Pronouns: (optional)
Timezone:
Notes:

## Context
What do they care about? What projects are they working on?
What annoys them? What makes them laugh? Build this over time.

Learn enough to help well, but do not build a dossier.
You are learning about a person, not profiling one.
`;

const DEFAULT_BOOTSTRAP_CONTENT = `# BOOTSTRAP.md - Hello, World
You just woke up. Time to figure out who you are.

There is no memory yet. This is a fresh workspace, so missing memory files are normal.

## First Conversation
Do not interrogate. Do not be robotic. Just talk.

Start with something like:
"Hey. I just came online. Who am I? Who are you?"

Then figure out together:
- Your name (what should they call you?)
- Your nature (assistant/agent/other)
- Your vibe (formal/casual/snarky/warm)
- Your signature emoji

If the user is unsure, offer a few options.

## After Identity
Update:
- IDENTITY.md (name, creature, vibe, emoji)
- USER.md (their name, how to address them, timezone, notes)

Then review SOUL.md together:
- What matters to them
- How they want you to behave
- Boundaries and preferences

Write it down. Make it real.

## Connect (Optional)
Ask how they want to reach you:
- Just here (web chat only)
- WhatsApp (link personal account, usually via QR)
- Telegram (set up a bot via BotFather)

Guide them through whichever they pick.

## When You're Done
Delete BOOTSTRAP.md. You do not need a bootstrap script anymore.
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

export interface WorkspaceContextFile {
  path: string;
  exists: boolean;
  content: string | null;
  truncated: boolean;
}

export interface AgentWorkspaceState {
  workspacePath: string;
  soul: WorkspaceContextFile;
  bootstrap: WorkspaceContextFile;
  identity: WorkspaceContextFile;
  user: WorkspaceContextFile;
  memoryIndex: WorkspaceContextFile;
  todayMemory: WorkspaceContextFile;
  yesterdayMemory: WorkspaceContextFile;
  onboardingRequired: boolean;
}

export async function ensureAgentWorkspaceFiles(
  workspacePath: string
): Promise<{ workspacePath: string; created: string[]; migrated: string[] }> {
  const resolvedWorkspace = resolveWorkspacePath(workspacePath);
  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const created: string[] = [];
  const migrated: string[] = [];

  if (await writeFileIfMissing(path.join(resolvedWorkspace, SOUL_FILE), DEFAULT_SOUL_CONTENT)) {
    created.push(SOUL_FILE);
  }

  if (await writeFileIfMissing(path.join(resolvedWorkspace, USER_FILE), DEFAULT_USER_CONTENT)) {
    created.push(USER_FILE);
  }

  if (await writeFileIfMissing(path.join(resolvedWorkspace, BOOTSTRAP_FILE), DEFAULT_BOOTSTRAP_CONTENT)) {
    created.push(BOOTSTRAP_FILE);
  }

  if (
    await migrateDefaultFileIfLegacy(
      path.join(resolvedWorkspace, SOUL_FILE),
      DEFAULT_SOUL_CONTENT,
      [LEGACY_SOUL_CONTENT_V1]
    )
  ) {
    migrated.push(SOUL_FILE);
  }

  if (
    await migrateDefaultFileIfLegacy(
      path.join(resolvedWorkspace, BOOTSTRAP_FILE),
      DEFAULT_BOOTSTRAP_CONTENT,
      [LEGACY_BOOTSTRAP_CONTENT_V1]
    )
  ) {
    migrated.push(BOOTSTRAP_FILE);
  }

  await fs.mkdir(path.join(resolvedWorkspace, MEMORY_DIR), { recursive: true });

  return {
    workspacePath: resolvedWorkspace,
    created,
    migrated,
  };
}

export async function loadAgentWorkspaceState(workspacePath: string): Promise<AgentWorkspaceState> {
  const resolvedWorkspace = resolveWorkspacePath(workspacePath);
  const today = formatDateLocal(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = formatDateLocal(yesterdayDate);

  const soulPath = path.join(resolvedWorkspace, SOUL_FILE);
  const bootstrapPath = path.join(resolvedWorkspace, BOOTSTRAP_FILE);
  const identityPath = path.join(resolvedWorkspace, IDENTITY_FILE);
  const userPath = path.join(resolvedWorkspace, USER_FILE);
  const memoryIndexPath = path.join(resolvedWorkspace, MEMORY_INDEX_FILE);
  const todayMemoryPath = path.join(resolvedWorkspace, MEMORY_DIR, `${today}.md`);
  const yesterdayMemoryPath = path.join(resolvedWorkspace, MEMORY_DIR, `${yesterday}.md`);

  const [soul, bootstrap, identity, user, memoryIndex, todayMemory, yesterdayMemory] = await Promise.all([
    readContextFile(soulPath),
    readContextFile(bootstrapPath),
    readContextFile(identityPath),
    readContextFile(userPath),
    readContextFile(memoryIndexPath),
    readContextFile(todayMemoryPath),
    readContextFile(yesterdayMemoryPath),
  ]);

  return {
    workspacePath: resolvedWorkspace,
    soul,
    bootstrap,
    identity,
    user,
    memoryIndex,
    todayMemory,
    yesterdayMemory,
    onboardingRequired: !hasIdentityProfile(identity.content),
  };
}

export function resolveWorkspacePath(workspacePath: string): string {
  if (workspacePath.startsWith('~')) {
    return path.join(os.homedir(), workspacePath.slice(1));
  }

  return workspacePath;
}

function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return true;
  }
}

async function migrateDefaultFileIfLegacy(
  filePath: string,
  currentDefaultContent: string,
  legacyDefaultCandidates: string[]
): Promise<boolean> {
  let existingContent: string;
  try {
    existingContent = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isENOENT(error)) {
      return false;
    }
    throw error;
  }

  const normalizedExisting = normalizeTemplateContent(existingContent);
  if (normalizedExisting === normalizeTemplateContent(currentDefaultContent)) {
    return false;
  }

  const hasLegacyDefault = legacyDefaultCandidates.some(
    (candidate) => normalizeTemplateContent(candidate) === normalizedExisting
  );
  if (!hasLegacyDefault) {
    return false;
  }

  await fs.writeFile(filePath, currentDefaultContent, 'utf8');
  return true;
}

function normalizeTemplateContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

async function readContextFile(filePath: string): Promise<WorkspaceContextFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (raw.length <= FILE_PROMPT_LIMIT) {
      return {
        path: filePath,
        exists: true,
        content: raw,
        truncated: false,
      };
    }

    return {
      path: filePath,
      exists: true,
      content: `${raw.slice(0, FILE_PROMPT_LIMIT)}\n[truncated]`,
      truncated: true,
    };
  } catch (error) {
    if (isENOENT(error)) {
      return {
        path: filePath,
        exists: false,
        content: null,
        truncated: false,
      };
    }
    throw error;
  }
}

function hasIdentityProfile(content: string | null): boolean {
  if (!content) {
    return false;
  }

  const lines = content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  const keyPrefixes = ['name:', 'creature:', 'vibe:', 'signature emoji:'];
  const hasFilledProfileField = keyPrefixes.some((prefix) => {
    const line = lines.find((entry) => entry.toLowerCase().startsWith(prefix));
    if (!line) {
      return false;
    }
    return line.slice(prefix.length).trim().length > 0;
  });

  return hasFilledProfileField || content.trim().length >= 40;
}

function isENOENT(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
