import { approvePairingCode, listPendingPairings, type PairingChannel } from '../../security/pairing.js';
import type { ParsedArgs } from '../argv.js';

const CHANNELS: PairingChannel[] = ['discord', 'slack', 'whatsapp'];

export async function runPairingCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[1];

  switch (subcommand) {
    case 'approve':
      await runApprove(args);
      return;
    case 'pending':
      await runPending(args);
      return;
    default:
      printPairingHelp();
  }
}

async function runApprove(args: ParsedArgs): Promise<void> {
  const channel = parseChannel(args.positional[2]);
  const code = args.positional[3]?.trim() ?? '';

  if (!channel || !code) {
    throw new Error('Usage: keygate pairing approve <discord|slack|whatsapp> <code>');
  }

  const result = await approvePairingCode(channel, code);
  if (!result.approved) {
    throw new Error(`Pairing approval failed (${result.reason ?? 'unknown_error'}).`);
  }

  console.log(`Approved ${channel} user ${result.userId} for DM access.`);
}

async function runPending(args: ParsedArgs): Promise<void> {
  const channel = parseChannel(args.positional[2]);
  const pending = await listPendingPairings(channel ?? undefined);

  if (pending.length === 0) {
    console.log('No pending pairing requests.');
    return;
  }

  console.log('Pending pairing requests:');
  for (const request of pending) {
    console.log(`- ${request.channel} user=${request.userId} code=${request.code} expires=${request.expiresAt}`);
  }
}

function parseChannel(value: string | undefined): PairingChannel | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (CHANNELS.includes(normalized as PairingChannel)) {
    return normalized as PairingChannel;
  }

  return null;
}

function printPairingHelp(): void {
  console.log(`Pairing commands:\n  keygate pairing approve <discord|slack|whatsapp> <code>\n  keygate pairing pending [discord|slack|whatsapp]`);
}
