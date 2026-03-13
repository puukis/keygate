import { loadConfigFromEnv } from '../../config/env.js';
import { Database } from '../../db/index.js';
import { UsageService } from '../../usage/index.js';
import { SandboxManager } from '../../sandbox/index.js';
import { NodeStore } from '../../nodes/index.js';
import { GmailAutomationService } from '../../gmail/index.js';
import { getRemoteStatusSummary } from './remote.js';
import type { ParsedArgs } from '../argv.js';

export async function runStatusCommand(args: ParsedArgs): Promise<void> {
  const config = loadConfigFromEnv();
  const db = new Database();
  const sandbox = new SandboxManager(config);
  const nodes = new NodeStore();
  const gmail = new GmailAutomationService(config);

  try {
    const sessionId = typeof args.flags['session'] === 'string' ? args.flags['session'].trim() : '';
    const session = sessionId ? db.getSession(sessionId) : null;
    const usage = sessionId ? db.getSessionUsageAggregate(sessionId) : new UsageService(db, config).summarize({ window: '30d' }).total;
    const [sandboxHealth, knownNodes, gmailHealth] = await Promise.all([
      sandbox.getHealth(),
      nodes.listNodes(),
      gmail.getHealth(),
    ]);
    const remote = await getRemoteStatusSummary(config);

    const payload = {
      mode: config.security.mode,
      spicyEnabled: config.security.spicyModeEnabled,
      spicyObedienceEnabled: config.security.spicyMaxObedienceEnabled === true,
      server: {
        host: config.server.host,
        port: config.server.port,
      },
      remote,
      llm: session?.modelOverride ?? {
        provider: config.llm.provider,
        model: config.llm.model,
        reasoningEffort: config.llm.reasoningEffort,
      },
      session: sessionId || undefined,
      debugMode: session?.debugMode === true,
      compactionSummaryRef: session?.compactionSummaryRef,
      usage,
      sandbox: sandboxHealth,
      nodes: {
        total: knownNodes.length,
        online: knownNodes.filter((node) => node.online === true).length,
      },
      gmail: gmailHealth,
    };

    if (args.flags['json'] === true) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log([
      `Mode: ${payload.mode}`,
      `Spicy enabled: ${payload.spicyEnabled ? 'yes' : 'no'}`,
      `Spicy obedience: ${payload.spicyObedienceEnabled ? 'yes' : 'no'}`,
      `Bind host: ${payload.server.host}:${payload.server.port}`,
      `Remote auth: ${payload.remote.authMode}`,
      `Tailscale remote: ${payload.remote.tailscale.state} (${payload.remote.tailscale.detail})`,
      `SSH tunnel: ${payload.remote.ssh.state} (${payload.remote.ssh.detail})`,
      `SSH local URL: ${payload.remote.ssh.localUrl}`,
      `Provider: ${payload.llm.provider}`,
      `Model: ${payload.llm.model}`,
      `Reasoning: ${payload.llm.reasoningEffort ?? 'default'}`,
      `Session: ${payload.session ?? 'global'}`,
      `Debug mode: ${payload.debugMode ? 'on' : 'off'}`,
      `Compaction: ${payload.compactionSummaryRef ?? 'none'}`,
      `Turns: ${'turnCount' in usage ? usage.turnCount : usage.turns}`,
      `Tokens: in ${usage.inputTokens} / out ${usage.outputTokens} / total ${usage.totalTokens}`,
      `Cost: $${usage.costUsd.toFixed(6)}`,
      `Sandbox: ${payload.sandbox.available ? 'healthy' : 'degraded'} (${payload.sandbox.scope}, ${payload.sandbox.image})`,
      `Nodes: ${payload.nodes.online}/${payload.nodes.total} online`,
      `Gmail: ${payload.gmail.accounts} account(s), ${payload.gmail.enabledWatches}/${payload.gmail.watches} watch(es) enabled`,
    ].join('\n'));
  } finally {
    gmail.stop();
    db.close();
  }
}
