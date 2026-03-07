import { loadConfigFromEnv } from '../../config/env.js';
import { Database } from '../../db/index.js';
import { UsageService } from '../../usage/index.js';
import type { UsageWindow } from '../../usage/index.js';
import type { ParsedArgs } from '../argv.js';

export async function runUsageCommand(args: ParsedArgs): Promise<void> {
  const config = loadConfigFromEnv();
  const db = new Database();

  try {
    const sessionId = typeof args.flags['session'] === 'string' ? args.flags['session'].trim() : undefined;
    const window = normalizeWindow(args.flags['window']);
    const summary = new UsageService(db, config).summarize({ sessionId, window });

    if (args.flags['json'] === true) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log([
      `Window: ${summary.window}`,
      `Turns: ${summary.total.turns}`,
      `Tokens: in ${summary.total.inputTokens} / out ${summary.total.outputTokens} / total ${summary.total.totalTokens}`,
      `Cost: $${summary.total.costUsd.toFixed(6)}`,
      '',
      'By provider:',
      ...(summary.byProvider.length > 0
        ? summary.byProvider.slice(0, 10).map((bucket) => `- ${bucket.key}: ${bucket.turns} turns, ${bucket.totalTokens} tokens, $${bucket.costUsd.toFixed(6)}`)
        : ['- No usage recorded.']),
    ].join('\n'));
  } finally {
    db.close();
  }
}

function normalizeWindow(value: string | boolean | undefined): UsageWindow {
  if (value === '24h' || value === '7d' || value === '30d' || value === 'all') {
    return value;
  }

  return '30d';
}
