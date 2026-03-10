import {
  createOrGetPairingCode,
  isDmAllowedByPolicy,
  isUserPaired,
} from '@puukis/core';
import type { TelegramConfig } from '@puukis/core';

export interface DmAccessResult {
  allowed: boolean;
  pairingCode?: string;
  expiresAt?: string;
}

/**
 * Check whether an inbound DM from userId is allowed by the configured policy.
 * If policy is 'pairing' and user is unknown, generates a pairing code.
 */
export async function checkDmAccess(
  config: TelegramConfig,
  userId: number,
): Promise<DmAccessResult> {
  const userIdStr = String(userId);
  const policy = config.dmPolicy;
  const allowFrom = config.allowFrom;

  const paired = await isUserPaired('telegram', userIdStr);
  const allowed = isDmAllowedByPolicy({ policy, userId: userIdStr, allowFrom, paired });

  if (allowed) {
    return { allowed: true };
  }

  if (policy === 'pairing') {
    const request = await createOrGetPairingCode('telegram', userIdStr);
    return {
      allowed: false,
      pairingCode: request.code,
      expiresAt: request.expiresAt,
    };
  }

  return { allowed: false };
}
