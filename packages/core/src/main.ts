#!/usr/bin/env node
/**
 * Keygate Main Entry Point
 * Starts WebSocket server or runs onboarding/auth CLI commands.
 */

import { startWebServer } from './server/index.js';
import { runCli, printHelp } from './cli/index.js';
import { loadConfigFromEnv, loadEnvironment } from './config/env.js';

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

  console.log('⚡ Starting Keygate...');
  console.log(`   LLM Provider: ${config.llm.provider}`);
  console.log(`   Model: ${config.llm.model}`);
  console.log(`   Spicy Mode Enabled: ${config.security.spicyModeEnabled}`);
  console.log('');

  startWebServer(config);
}

void main();
