#!/usr/bin/env node
/**
 * Keygate Main Entry Point
 * Starts WebSocket server or runs onboarding/auth CLI commands.
 */

import { startWebServer } from './server/index.js';
import { runCli, printHelp } from './cli/index.js';
import { getDefaultWorkspacePath, loadConfigFromEnv, loadEnvironment } from './config/env.js';
import { ensureAgentWorkspaceFiles } from './workspace/agentWorkspace.js';
import { spawn } from 'node:child_process';

const DEFAULT_CHAT_SITE_URL = 'http://localhost:18790';
const DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

async function main(): Promise<void> {
  loadEnvironment();

  try {
    const handled = await runCli(process.argv.slice(2));
    if (handled) {
      return;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 1;
    return;
  }

  const config = loadConfigFromEnv();
  const workspaceBootstrap = await ensureAgentWorkspaceFiles(getDefaultWorkspacePath());

  console.log('⚡ Starting Keygate...');
  console.log(`   LLM Provider: ${config.llm.provider}`);
  console.log(`   Model: ${config.llm.model}`);
  console.log(`   Spicy Mode Enabled: ${config.security.spicyModeEnabled}`);
  if (workspaceBootstrap.created.length > 0) {
    console.log(`   Initialized workspace files: ${workspaceBootstrap.created.join(', ')}`);
  }
  if (workspaceBootstrap.migrated.length > 0) {
    console.log(`   Migrated workspace files: ${workspaceBootstrap.migrated.join(', ')}`);
  }
  console.log('');

  startWebServer(config, {
    onListening: async () => {
      if (!shouldOpenChatSiteOnStart()) {
        return;
      }

      const chatSiteUrl = getChatSiteUrl();
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

function shouldOpenChatSiteOnStart(): boolean {
  const rawValue = process.env['KEYGATE_OPEN_CHAT_ON_START'];

  if (!rawValue) {
    return true;
  }

  return !DISABLED_ENV_VALUES.has(rawValue.trim().toLowerCase());
}

function getChatSiteUrl(): string {
  const configuredUrl = process.env['KEYGATE_CHAT_URL']?.trim();

  if (!configuredUrl) {
    return DEFAULT_CHAT_SITE_URL;
  }

  return configuredUrl;
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
