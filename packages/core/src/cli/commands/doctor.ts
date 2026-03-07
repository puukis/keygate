import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { OpenAICodexProvider } from '../../llm/OpenAICodexProvider.js';
import { readTokens, isTokenExpired } from '../../auth/index.js';
import { loadConfigFromEnv, getConfigDir, getKeygateFilePath } from '../../config/env.js';
import { SkillsManager } from '../../skills/manager.js';
import { MCPBrowserManager } from '../../codex/mcpBrowserManager.js';
import { hasWhatsAppLinkedAuth } from '../../whatsapp/index.js';
import { SandboxManager } from '../../sandbox/index.js';
import { NodeStore } from '../../nodes/index.js';
import { GmailAutomationService } from '../../gmail/index.js';
import { Gateway } from '../../gateway/index.js';
import { Database } from '../../db/index.js';
import { ensureCodexInstalled } from '../codexInstall.js';
import { runGatewayCommand } from './gateway.js';
import type { ParsedArgs } from '../argv.js';

export type DoctorSeverity = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  severity: DoctorSeverity;
  detail: string;
  repairable?: boolean;
  repaired?: boolean;
}

export interface DoctorReport {
  generatedAt: string;
  checks: DoctorCheck[];
  repaired: string[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
}

export async function runDoctorCommand(args: ParsedArgs): Promise<void> {
  const nonInteractive = Boolean(args.flags['non-interactive']);
  const json = Boolean(args.flags['json']);
  const repair = Boolean(args.flags['repair']);
  const report = await runDoctorChecks({ repair });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report, { nonInteractive, repair });
  }

  if (report.summary.fail > 0) {
    throw new Error('Doctor found failing checks.');
  }
}

export async function runDoctorChecks(options: { repair?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const repaired: string[] = [];
  const config = loadConfigFromEnv();
  const sandbox = new SandboxManager(config);
  const nodeStore = new NodeStore();
  const gmail = new GmailAutomationService(config);
  const db = new Database();

  try {
    checks.push(checkFromBoolean(
      'config.provider',
      'LLM provider configured',
      Boolean(config.llm.provider),
      config.llm.provider ? `provider=${config.llm.provider}` : 'LLM provider missing',
    ));
    checks.push(checkFromBoolean(
      'config.model',
      'LLM model configured',
      config.llm.model.trim().length > 0,
      config.llm.model.trim().length > 0 ? `model=${config.llm.model}` : 'LLM model is empty',
    ));
    checks.push(checkFromBoolean(
      'config.workspace',
      'Workspace path exists',
      existsSync(config.security.workspacePath),
      config.security.workspacePath,
    ));
    checks.push({
      id: 'security.mode',
      title: 'Security mode posture',
      severity: config.security.mode === 'safe' ? 'pass' : 'warn',
      detail: config.security.mode === 'safe'
        ? 'safe mode enabled'
        : `mode=${config.security.mode} (consider safe for stricter guardrails)`,
    });
    checks.push({
      id: 'server.api_token',
      title: 'Operator API token configured',
      severity: config.server.apiToken.trim().length > 0 ? 'pass' : 'fail',
      detail: config.server.apiToken.trim().length > 0
        ? 'configured'
        : 'server.apiToken is empty; operator-only routes are exposed without an API token',
    });

    try {
      const sessionCount = db.listSessions().length;
      checks.push({
        id: 'db.integrity',
        title: 'SQLite session database',
        severity: 'pass',
        detail: `${sessionCount} persisted sessions readable`,
      });
    } catch (error) {
      checks.push({
        id: 'db.integrity',
        title: 'SQLite session database',
        severity: 'fail',
        detail: error instanceof Error ? error.message : 'Database could not be opened',
      });
    }

    checks.push(await runAuthCheck(config.llm.provider, config.llm.model, config.security.workspacePath));
    checks.push(await runGatewayStatusCheck());

    checks.push({
      id: 'channels.discord.token',
      title: 'Discord token configured',
      severity: config.discord?.token?.trim() ? 'pass' : 'warn',
      detail: config.discord?.token?.trim() ? 'configured' : 'DISCORD_TOKEN missing',
    });
    checks.push({
      id: 'channels.slack.tokens',
      title: 'Slack tokens configured',
      severity: config.slack?.botToken?.trim() && config.slack?.appToken?.trim() ? 'pass' : 'warn',
      detail: config.slack?.botToken?.trim() && config.slack?.appToken?.trim()
        ? 'configured'
        : 'SLACK_BOT_TOKEN or SLACK_APP_TOKEN missing',
    });

    const whatsappLinked = await hasWhatsAppLinkedAuth();
    const whatsappRuntimeRunning = isManagedChannelRunning(path.join(getConfigDir(), 'channels', 'whatsapp.json'));
    checks.push({
      id: 'channels.whatsapp.linked',
      title: 'WhatsApp linked',
      severity: whatsappLinked ? 'pass' : 'warn',
      detail: whatsappLinked ? 'linked-device auth is present' : 'run `keygate channels whatsapp login`',
    });
    checks.push({
      id: 'channels.whatsapp.runtime',
      title: 'WhatsApp runtime',
      severity: whatsappLinked
        ? (whatsappRuntimeRunning ? 'pass' : 'warn')
        : 'warn',
      detail: whatsappLinked
        ? (whatsappRuntimeRunning ? 'managed runtime is running' : 'linked but runtime is stopped')
        : 'runtime disabled until the channel is linked',
    });

    checks.push(validateDmPolicy('discord', config.discord?.dmPolicy ?? 'pairing', config.discord?.allowFrom ?? []));
    checks.push(validateDmPolicy('slack', config.slack?.dmPolicy ?? 'pairing', config.slack?.allowFrom ?? []));
    checks.push(validateDmPolicy('whatsapp', config.whatsapp?.dmPolicy ?? 'pairing', config.whatsapp?.allowFrom ?? []));
    checks.push(validateWhatsAppGroupPolicy(config));

    try {
      const mcpStatus = await new MCPBrowserManager(config).status();
      checks.push({
        id: 'mcp.browser',
        title: 'MCP browser health',
        severity: mcpStatus.healthy ? 'pass' : 'warn',
        detail: mcpStatus.healthy
          ? `healthy (version ${mcpStatus.configuredVersion ?? 'n/a'})`
          : (mcpStatus.warning ?? 'not healthy'),
      });
    } catch (error) {
      checks.push({
        id: 'mcp.browser',
        title: 'MCP browser health',
        severity: 'warn',
        detail: error instanceof Error ? error.message : 'MCP status check failed',
      });
    }

    try {
      const sandboxHealth = await sandbox.getHealth();
      checks.push({
        id: 'sandbox.docker',
        title: 'Docker sandbox health',
        severity: sandboxHealth.available ? 'pass' : 'fail',
        detail: sandboxHealth.detail,
      });

      const persistedSessionIds = new Set(db.listSessions().map((session) => session.id));
      const orphans = (await sandbox.list()).filter((runtime) => !persistedSessionIds.has(runtime.scopeKey));
      if (orphans.length > 0 && options.repair) {
        const removed = await sandbox.cleanupOrphans(persistedSessionIds);
        if (removed.length > 0) {
          repaired.push(`Removed ${removed.length} orphaned sandbox container(s).`);
        }
      }
      checks.push({
        id: 'sandbox.orphans',
        title: 'Sandbox container hygiene',
        severity: orphans.length === 0 ? 'pass' : 'warn',
        detail: orphans.length === 0
          ? 'no orphaned sandbox containers found'
          : `${orphans.length} orphaned sandbox container(s) found`,
        repairable: orphans.length > 0,
        repaired: orphans.length > 0 && options.repair,
      });
    } catch (error) {
      checks.push({
        id: 'sandbox.docker',
        title: 'Docker sandbox health',
        severity: 'fail',
        detail: error instanceof Error ? error.message : 'Docker sandbox health check failed',
      });
    }

    try {
      const [nodes, pending] = await Promise.all([
        nodeStore.listNodes(),
        nodeStore.listPendingRequests(),
      ]);
      const unknownPermissions = nodes.filter((node) => Object.values(node.permissions ?? {}).includes('unknown')).length;
      checks.push({
        id: 'nodes.store',
        title: 'Node store integrity',
        severity: 'pass',
        detail: `${nodes.length} paired nodes loaded, ${pending.length} pending pairing request(s)`,
      });
      checks.push({
        id: 'nodes.permissions',
        title: 'Node permission drift',
        severity: unknownPermissions === 0 ? 'pass' : 'warn',
        detail: unknownPermissions === 0
          ? 'all node permissions are explicitly known'
          : `${unknownPermissions} node(s) still report unknown capability permissions`,
      });
    } catch (error) {
      checks.push({
        id: 'nodes.store',
        title: 'Node store integrity',
        severity: 'warn',
        detail: error instanceof Error ? error.message : 'Node store could not be read',
      });
    }

    try {
      const gateway = Gateway.getInstance(config);
      const hookFailures = gateway.plugins.getHookFailures();
      checks.push({
        id: 'plugins.hooks',
        title: 'Plugin hook runtime',
        severity: hookFailures.length === 0 ? 'pass' : 'warn',
        detail: hookFailures.length === 0
          ? 'no plugin hook failures recorded'
          : `${hookFailures.length} plugin hook failures recorded`,
      });
      Gateway.reset();
    } catch (error) {
      checks.push({
        id: 'plugins.hooks',
        title: 'Plugin hook runtime',
        severity: 'warn',
        detail: error instanceof Error ? error.message : 'Plugin hook check failed',
      });
    }

    let manager: SkillsManager | null = null;
    try {
      manager = new SkillsManager({ config });
      await manager.ensureReady();
      const report = await manager.getDoctorReport('doctor');
      checks.push({
        id: 'skills.discovery',
        title: 'Skills discovery diagnostics',
        severity: report.diagnostics.length === 0 ? 'pass' : 'warn',
        detail: report.diagnostics.length === 0
          ? `${report.records.length} skills discovered`
          : `${report.diagnostics.length} diagnostics across ${report.records.length} skills`,
      });
    } catch (error) {
      checks.push({
        id: 'skills.discovery',
        title: 'Skills discovery diagnostics',
        severity: 'warn',
        detail: error instanceof Error ? error.message : 'Skills doctor check failed',
      });
    } finally {
      manager?.stop();
    }

    const gmailHealth = await gmail.getHealth();
    checks.push({
      id: 'gmail.oauth',
      title: 'Gmail OAuth client config',
      severity: config.gmail?.clientId?.trim() ? 'pass' : 'warn',
      detail: config.gmail?.clientId?.trim()
        ? 'gmail.clientId configured'
        : 'KEYGATE_GMAIL_CLIENT_ID or gmail.clientId is not configured',
    });
    checks.push({
      id: 'gmail.pubsub',
      title: 'Gmail Pub/Sub routing config',
      severity: config.gmail?.defaults.pubsubTopic?.trim() && config.gmail?.defaults.pushBaseUrl?.trim() ? 'pass' : 'warn',
      detail: config.gmail?.defaults.pubsubTopic?.trim() && config.gmail?.defaults.pushBaseUrl?.trim()
        ? `topic=${config.gmail.defaults.pubsubTopic}`
        : 'gmail.defaults.pubsubTopic or gmail.defaults.pushBaseUrl missing',
    });
    checks.push({
      id: 'gmail.health',
      title: 'Gmail account/watch health',
      severity: gmailHealth.expiredWatches > 0 ? 'warn' : 'pass',
      detail: `${gmailHealth.accounts} account(s), ${gmailHealth.watches} watch(es), ${gmailHealth.dueForRenewal} due for renewal`,
      repairable: gmailHealth.dueForRenewal > 0,
    });
    if (options.repair && gmailHealth.dueForRenewal > 0) {
      const renewed = await gmail.renewDueWatches();
      repaired.push(`Renewed Gmail watches for ${renewed} account(s).`);
    }

    checks.push({
      id: 'config.file',
      title: '.keygate file found',
      severity: existsSync(getKeygateFilePath()) ? 'pass' : 'warn',
      detail: getKeygateFilePath(),
    });
  } finally {
    gmail.stop();
    db.close();
  }

  const summary = summarizeChecks(checks);
  return {
    generatedAt: new Date().toISOString(),
    checks,
    repaired,
    summary,
  };
}

async function runGatewayStatusCheck(): Promise<DoctorCheck> {
  const gatewayLogs: string[] = [];
  try {
    await runGatewayCommand(
      { positional: ['gateway', 'status'], flags: {} },
      { log: (line: string) => gatewayLogs.push(line) }
    );

    const statusLine = gatewayLogs.find((line) => line.startsWith('Gateway status:'));
    if (statusLine?.includes('running')) {
      return { id: 'gateway.status', title: 'Gateway service', severity: 'pass', detail: statusLine };
    }
    if (statusLine?.includes('stopped')) {
      return { id: 'gateway.status', title: 'Gateway service', severity: 'warn', detail: statusLine };
    }
    return { id: 'gateway.status', title: 'Gateway service', severity: 'warn', detail: statusLine ?? 'Unknown gateway status' };
  } catch (error) {
    return {
      id: 'gateway.status',
      title: 'Gateway service',
      severity: 'warn',
      detail: error instanceof Error ? error.message : 'Gateway status check failed',
    };
  }
}

async function runAuthCheck(provider: string, model: string, workspacePath: string): Promise<DoctorCheck> {
  if (provider !== 'openai-codex') {
    return {
      id: 'auth.provider',
      title: 'Auth check',
      severity: 'pass',
      detail: `provider=${provider} (OAuth check skipped)`,
    };
  }

  const localTokens = await readTokens();
  if (localTokens) {
    const expired = isTokenExpired(localTokens);
    return {
      id: 'auth.openai-codex',
      title: 'OpenAI Codex auth',
      severity: expired ? 'warn' : 'pass',
      detail: expired ? 'local OAuth token present but expired' : 'local OAuth token present',
    };
  }

  const codexInstall = await ensureCodexInstalled({ autoInstall: false });
  if (!codexInstall.installed) {
    return {
      id: 'auth.openai-codex',
      title: 'OpenAI Codex auth',
      severity: 'fail',
      detail: codexInstall.error ?? 'Codex CLI not installed',
    };
  }

  const providerClient = new OpenAICodexProvider(model, { cwd: workspacePath });
  try {
    const account = await providerClient.checkAccount();
    if (account.account) {
      return {
        id: 'auth.openai-codex',
        title: 'OpenAI Codex auth',
        severity: 'pass',
        detail: account.account.email ? `logged in as ${account.account.email}` : 'logged in via Codex CLI',
      };
    }

    return {
      id: 'auth.openai-codex',
      title: 'OpenAI Codex auth',
      severity: 'fail',
      detail: 'not logged in',
    };
  } catch (error) {
    return {
      id: 'auth.openai-codex',
      title: 'OpenAI Codex auth',
      severity: 'warn',
      detail: error instanceof Error ? error.message : 'Auth check failed',
    };
  } finally {
    await providerClient.dispose();
  }
}

function validateDmPolicy(
  channel: 'discord' | 'slack' | 'whatsapp',
  policy: 'pairing' | 'open' | 'closed',
  allowFrom: string[]
): DoctorCheck {
  if (policy === 'closed' && allowFrom.length === 0) {
    return {
      id: `routing.${channel}.dmPolicy`,
      title: `${channel} DM routing policy`,
      severity: 'warn',
      detail: 'closed policy with empty allowlist blocks all DMs',
    };
  }

  if (policy === 'open') {
    return {
      id: `routing.${channel}.dmPolicy`,
      title: `${channel} DM routing policy`,
      severity: 'warn',
      detail: 'open policy allows all DMs (consider pairing for stricter trust)',
    };
  }

  return {
    id: `routing.${channel}.dmPolicy`,
    title: `${channel} DM routing policy`,
    severity: 'pass',
    detail: `${policy} (${allowFrom.length} allowlist entries)`,
  };
}

function validateWhatsAppGroupPolicy(config: ReturnType<typeof loadConfigFromEnv>): DoctorCheck {
  if (config.whatsapp?.groupMode === 'open' && config.whatsapp.groupRequireMentionDefault === false) {
    return {
      id: 'routing.whatsapp.groupPolicy',
      title: 'WhatsApp group routing policy',
      severity: 'warn',
      detail: 'open group mode without mention gating will process all group messages',
    };
  }

  return {
    id: 'routing.whatsapp.groupPolicy',
    title: 'WhatsApp group routing policy',
    severity: 'pass',
    detail: `${config.whatsapp?.groupMode ?? 'closed'} (${Object.keys(config.whatsapp?.groups ?? {}).length} explicit group rules)`,
  };
}

function isManagedChannelRunning(statePath: string): boolean {
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return false;
    }

    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function checkFromBoolean(id: string, title: string, ok: boolean, detail: string): DoctorCheck {
  return {
    id,
    title,
    severity: ok ? 'pass' : 'fail',
    detail,
  };
}

function summarizeChecks(checks: DoctorCheck[]): DoctorReport['summary'] {
  return {
    pass: checks.filter((check) => check.severity === 'pass').length,
    warn: checks.filter((check) => check.severity === 'warn').length,
    fail: checks.filter((check) => check.severity === 'fail').length,
  };
}

function printDoctorReport(
  report: DoctorReport,
  options: { nonInteractive: boolean; repair: boolean }
): void {
  const mode = options.nonInteractive ? 'non-interactive' : 'interactive';
  console.log(`Keygate doctor report (${mode})`);
  console.log(`Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`);
  if (options.repair) {
    console.log(`Repair mode: ${report.repaired.length > 0 ? 'applied' : 'no repairs needed'}`);
  }

  for (const check of report.checks) {
    const icon = check.severity === 'pass' ? '✅' : check.severity === 'warn' ? '⚠️' : '❌';
    const repairSuffix = check.repaired ? ' [repaired]' : check.repairable ? ' [repairable]' : '';
    console.log(`${icon} ${check.title}${repairSuffix}: ${check.detail}`);
  }

  if (report.repaired.length > 0) {
    console.log('\nRepairs applied:');
    for (const entry of report.repaired) {
      console.log(`- ${entry}`);
    }
  }
}
