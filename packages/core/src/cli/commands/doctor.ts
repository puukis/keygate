import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { OpenAICodexProvider } from '../../llm/OpenAICodexProvider.js';
import { readTokens, isTokenExpired } from '../../auth/index.js';
import { loadConfigFromEnv, getConfigDir, getKeygateFilePath } from '../../config/env.js';
import { SkillsManager } from '../../skills/manager.js';
import { MCPBrowserManager } from '../../codex/mcpBrowserManager.js';
import { hasWhatsAppLinkedAuth } from '../../whatsapp/index.js';
import { ensureCodexInstalled } from '../codexInstall.js';
import { runGatewayCommand } from './gateway.js';
import type { ParsedArgs } from '../argv.js';

export type DoctorSeverity = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  severity: DoctorSeverity;
  detail: string;
}

export async function runDoctorCommand(args: ParsedArgs): Promise<void> {
  const nonInteractive = Boolean(args.flags['non-interactive']);
  const checks = await runDoctorChecks();

  printDoctorReport(checks, { nonInteractive });

  const hasFail = checks.some((check) => check.severity === 'fail');
  if (hasFail) {
    throw new Error('Doctor found failing checks.');
  }
}

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const config = loadConfigFromEnv();

  // Config checks
  checks.push({
    id: 'config.provider',
    title: 'LLM provider configured',
    severity: config.llm.provider ? 'pass' : 'fail',
    detail: config.llm.provider ? `provider=${config.llm.provider}` : 'LLM provider missing',
  });

  checks.push({
    id: 'config.model',
    title: 'LLM model configured',
    severity: config.llm.model.trim().length > 0 ? 'pass' : 'fail',
    detail: config.llm.model.trim().length > 0 ? `model=${config.llm.model}` : 'LLM model is empty',
  });

  checks.push({
    id: 'config.workspace',
    title: 'Workspace path exists',
    severity: existsSync(config.security.workspacePath) ? 'pass' : 'fail',
    detail: config.security.workspacePath,
  });

  checks.push({
    id: 'security.mode',
    title: 'Security mode posture',
    severity: config.security.mode === 'safe' ? 'pass' : 'warn',
    detail: config.security.mode === 'safe'
      ? 'safe mode enabled'
      : `mode=${config.security.mode} (consider safe for stricter guardrails)`,
  });

  // Auth checks
  const authCheck = await runAuthCheck(config.llm.provider, config.llm.model, config.security.workspacePath);
  checks.push(authCheck);

  // Gateway status check
  const gatewayLogs: string[] = [];
  try {
    await runGatewayCommand(
      { positional: ['gateway', 'status'], flags: {} },
      { log: (line: string) => gatewayLogs.push(line) }
    );

    const statusLine = gatewayLogs.find((line) => line.startsWith('Gateway status:'));
    if (statusLine?.includes('running')) {
      checks.push({ id: 'gateway.status', title: 'Gateway service', severity: 'pass', detail: statusLine });
    } else if (statusLine?.includes('stopped')) {
      checks.push({ id: 'gateway.status', title: 'Gateway service', severity: 'warn', detail: statusLine });
    } else {
      checks.push({ id: 'gateway.status', title: 'Gateway service', severity: 'warn', detail: statusLine ?? 'Unknown gateway status' });
    }
  } catch (error) {
    checks.push({
      id: 'gateway.status',
      title: 'Gateway service',
      severity: 'warn',
      detail: error instanceof Error ? error.message : 'Gateway status check failed',
    });
  }

  // Channel config checks
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

  // Routing/trust checks
  checks.push(validateDmPolicy('discord', config.discord?.dmPolicy ?? 'pairing', config.discord?.allowFrom ?? []));
  checks.push(validateDmPolicy('slack', config.slack?.dmPolicy ?? 'pairing', config.slack?.allowFrom ?? []));
  checks.push(validateDmPolicy('whatsapp', config.whatsapp?.dmPolicy ?? 'pairing', config.whatsapp?.allowFrom ?? []));
  checks.push(validateWhatsAppGroupPolicy(config));

  // MCP/browser health
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

  // Skills diagnostics
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

  // Presence/config file checks
  checks.push({
    id: 'config.file',
    title: '.keygate file found',
    severity: existsSync(getKeygateFilePath()) ? 'pass' : 'warn',
    detail: getKeygateFilePath(),
  });

  return checks;
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
      title: 'whatsapp group routing policy',
      severity: 'warn',
      detail: 'open group mode without mention gating will process all group messages',
    };
  }

  return {
    id: 'routing.whatsapp.groupPolicy',
    title: 'whatsapp group routing policy',
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

function printDoctorReport(checks: DoctorCheck[], options: { nonInteractive: boolean }): void {
  const pass = checks.filter((check) => check.severity === 'pass').length;
  const warn = checks.filter((check) => check.severity === 'warn').length;
  const fail = checks.filter((check) => check.severity === 'fail').length;

  const mode = options.nonInteractive ? 'non-interactive' : 'interactive';
  console.log(`Keygate doctor report (${mode})`);
  console.log(`Summary: pass=${pass} warn=${warn} fail=${fail}`);

  for (const check of checks) {
    const icon = check.severity === 'pass' ? '✅' : check.severity === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${check.title}: ${check.detail}`);
  }
}
