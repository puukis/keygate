#!/usr/bin/env node
/**
 * Keygate Main Entry Point
 * Starts the WebSocket server for the Web UI
 */

import { startWebServer } from './server/index.js';
import type { KeygateConfig } from './types.js';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

// Try to load from ~/.config/keygate/.env first
const configDir = path.join(os.homedir(), '.config', 'keygate');
dotenv.config({ path: path.join(configDir, '.env') });
// Fallback to default behavior (CWD)
dotenv.config();

const config: KeygateConfig = {
  llm: {
    provider: (process.env['LLM_PROVIDER'] as 'openai' | 'gemini' | 'ollama') ?? 'openai',
    model: process.env['LLM_MODEL'] ?? 'gpt-4o',
    apiKey: process.env['LLM_API_KEY'] ?? '',
    ollama: {
        host: process.env['LLM_OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
    }
  },
  security: {
    mode: 'safe',
    spicyModeEnabled: process.env['SPICY_MODE_ENABLED'] === 'true',
    workspacePath: process.env['WORKSPACE_PATH'] ?? '~/keygate-workspace',
    allowedBinaries: ['git', 'ls', 'npm', 'cat', 'node', 'python3'],
  },
  server: {
    port: parseInt(process.env['PORT'] ?? '18790', 10),
  },
};

console.log('⚡ Starting Keygate...');
console.log(`   LLM Provider: ${config.llm.provider}`);
console.log(`   Model: ${config.llm.model}`);
console.log(`   Spicy Mode Enabled: ${config.security.spicyModeEnabled}`);
console.log('');

startWebServer(config);
