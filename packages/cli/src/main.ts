#!/usr/bin/env node

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  ensureAgentWorkspaceFiles,
  ensureWorkspaceGitRepo,
  getDefaultWorkspacePath,
  loadConfigFromEnv,
  loadEnvironment,
  printHelp,
  runCli,
  startWebServer,
} from '@puukis/core';

const DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_CHAT_PORT = 18790;

async function main(): Promise<void> {
  loadEnvironment();

  try {
    const handled = await runCli(process.argv.slice(2));
    if (handled) {
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (shouldPrintHelpForError(message)) {
      printHelp();
    }
    process.exitCode = 1;
    return;
  }

  const config = loadConfigFromEnv();
  const workspaceBootstrap = await ensureAgentWorkspaceFiles(getDefaultWorkspacePath());
  let gitBootstrap: Awaited<ReturnType<typeof ensureWorkspaceGitRepo>> | null = null;
  try {
    gitBootstrap = await ensureWorkspaceGitRepo(config.security.workspacePath, {
      isRootWorkspace: true,
      initialCommitPaths:
        path.resolve(config.security.workspacePath) === path.resolve(getDefaultWorkspacePath())
          ? [...workspaceBootstrap.created, ...workspaceBootstrap.migrated]
          : [],
    });
  } catch (error) {
    console.warn(
      `   Workspace Git bootstrap skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const staticAssetsDir = await resolveStaticAssetsDir();

  console.log('⚡ Starting Keygate...');
  console.log(`   LLM Provider: ${config.llm.provider}`);
  console.log(`   Model: ${config.llm.model}`);
  console.log(`   Spicy Mode Enabled: ${config.security.spicyModeEnabled}`);
  console.log(`   Spicy Max Obedience: ${config.security.spicyMaxObedienceEnabled === true}`);
  if (workspaceBootstrap.created.length > 0) {
    console.log(`   Initialized workspace files: ${workspaceBootstrap.created.join(', ')}`);
  }
  if (workspaceBootstrap.migrated.length > 0) {
    console.log(`   Migrated workspace files: ${workspaceBootstrap.migrated.join(', ')}`);
  }
  if (gitBootstrap?.createdRepo) {
    console.log(`   Initialized local git repo on branch ${gitBootstrap.branch}`);
  }
  if (!staticAssetsDir) {
    console.log('   Web UI bundle not found; API/WS server will still start.');
  }
  console.log('');

  startWebServer(config, {
    staticAssetsDir: staticAssetsDir ?? undefined,
    onListening: async () => {
      if (!shouldOpenChatSiteOnStart()) {
        return;
      }

      const chatSiteUrl = getChatSiteUrl(config.server.port);
      const opened = await openExternalUrl(chatSiteUrl);

      if (opened) {
        console.log(`🧭 Opened chat UI: ${chatSiteUrl}`);
        return;
      }

      console.log(`🧭 Open this chat URL manually: ${chatSiteUrl}`);
    },
  });
}

void main();

function shouldPrintHelpForError(message: string): boolean {
  return message.startsWith('Usage:') || message.startsWith('Unknown command:');
}

function shouldOpenChatSiteOnStart(): boolean {
  const rawValue = process.env['KEYGATE_OPEN_CHAT_ON_START'];

  if (!rawValue) {
    return true;
  }

  return !DISABLED_ENV_VALUES.has(rawValue.trim().toLowerCase());
}

function getChatSiteUrl(port: number): string {
  const configuredUrl = process.env['KEYGATE_CHAT_URL']?.trim();

  if (configuredUrl) {
    return configuredUrl;
  }

  const effectivePort = Number.isFinite(port) ? port : DEFAULT_CHAT_PORT;
  return `http://localhost:${effectivePort}`;
}

async function resolveStaticAssetsDir(): Promise<string | null> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, 'web'),
    path.resolve(currentDir, '..', 'web'),
    path.resolve(currentDir, '..', '..', 'web', 'dist'),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function openExternalUrl(url: string): Promise<boolean> {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };

  return new Promise<boolean>((resolve) => {
    const child = spawn(command.cmd, command.args, {
      stdio: 'ignore',
      detached: platform !== 'win32',
    });

    child.once('error', () => {
      resolve(false);
    });

    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
