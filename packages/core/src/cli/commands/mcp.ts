import { loadConfigFromEnv } from '../../config/env.js';
import {
  MCPBrowserManager,
  PLAYWRIGHT_MCP_SERVER_NAME,
  type MCPBrowserStatus,
} from '../../codex/mcpBrowserManager.js';
import type { ParsedArgs } from '../argv.js';

export async function runMcpCommand(args: ParsedArgs): Promise<void> {
  const resource = args.positional[1] ?? 'browser';
  if (resource !== 'browser') {
    throw new Error(`Unknown mcp target: ${resource}. Supported target: browser`);
  }

  const action = args.positional[2] ?? 'status';
  const config = loadConfigFromEnv();
  const manager = new MCPBrowserManager(config);

  switch (action) {
    case 'install': {
      const status = await manager.setup();
      printStatus('MCP browser installed.', status);
      return;
    }

    case 'status': {
      const status = await manager.status();
      printStatus('MCP browser status', status);
      return;
    }

    case 'remove': {
      const status = await manager.remove();
      printStatus('MCP browser removed.', status);
      return;
    }

    case 'update': {
      const status = await manager.update();
      printStatus('MCP browser updated.', status);
      return;
    }

    default:
      throw new Error(`Unknown mcp browser command: ${action}`);
  }
}

function printStatus(header: string, status: MCPBrowserStatus): void {
  const installed = status.installed ? 'yes' : 'no';
  const configuredVersion = status.configuredVersion ?? '(not configured)';
  const policyValue = status.domainPolicy === 'none'
    ? 'none'
    : status.domainPolicy === 'allowlist'
      ? `${status.domainPolicy}: ${status.domainAllowlist.join(', ') || '(empty)'}`
      : `${status.domainPolicy}: ${status.domainBlocklist.join(', ') || '(empty)'}`;

  console.log(header);
  console.log(`- server: ${PLAYWRIGHT_MCP_SERVER_NAME}`);
  console.log(`- installed: ${installed}`);
  console.log(`- healthy: ${status.healthy ? 'yes' : 'no'}`);
  console.log(`- configured version: ${configuredVersion}`);
  console.log(`- pinned version: ${status.desiredVersion}`);
  console.log(`- policy: ${policyValue}`);
  console.log(`- artifact retention days: ${status.traceRetentionDays}`);
  console.log(`- output path: ${status.artifactsPath}`);

  if (status.warning) {
    console.log(`- warning: ${status.warning}`);
  }
}
