import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { KeygateConfig } from '../types.js';

export interface WebChatGuestTokenPayload {
  linkId: string;
  sessionId: string;
  displayName: string;
  expiresAt: string;
  capabilities: Record<string, unknown>;
}

export interface WebChatLinkView extends WebChatGuestTokenPayload {
  createdAt: string;
  revokedAt?: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export class WebChatService {
  private readonly resolvedConfig: Required<KeygateConfig>['webchat'];

  constructor(
    private readonly db: Database,
    config: KeygateConfig['webchat'],
  ) {
    this.resolvedConfig = config ?? {
      enabled: true,
      tokenSecret: 'keygate-webchat',
      guestPath: '/webchat',
      websocketPath: '/webchat/ws',
      defaultExpiryMinutes: 60,
      maxExpiryMinutes: 60 * 24 * 7,
      maxConnectionsPerLink: 2,
      maxMessagesPerMinute: 60,
      maxUploadsPerLink: 25,
      capabilities: {
        canCancelRun: true,
        canUploadAttachments: true,
        canVotePolls: true,
      },
    };
  }

  createGuestLink(params: {
    sessionId: string;
    displayName: string;
    expiresAt: string;
    capabilities?: Record<string, unknown>;
    createdBy?: string;
  }): { token: string; link: WebChatLinkView } {
    const linkId = randomUUID();
    const capabilities = {
      ...this.resolvedConfig.capabilities,
      ...(params.capabilities ?? {}),
    };
    const payload: WebChatGuestTokenPayload = {
      linkId,
      sessionId: params.sessionId,
      displayName: params.displayName,
      expiresAt: params.expiresAt,
      capabilities,
    };
    const token = this.signPayload(payload);
    const link = this.db.createWebChatLink({
      id: linkId,
      sessionId: params.sessionId,
      displayName: params.displayName,
      tokenHash: this.hashToken(token),
      capabilities,
      expiresAt: params.expiresAt,
      createdBy: params.createdBy,
    });
    return {
      token,
      link: {
        linkId: link.id,
        sessionId: link.sessionId,
        displayName: link.displayName,
        expiresAt: link.expiresAt,
        capabilities: link.capabilities,
        createdAt: link.createdAt,
        revokedAt: link.revokedAt,
      },
    };
  }

  listGuestLinks(sessionId?: string): WebChatLinkView[] {
    return this.db.listWebChatLinks(sessionId).map((link) => ({
      linkId: link.id,
      sessionId: link.sessionId,
      displayName: link.displayName,
      expiresAt: link.expiresAt,
      capabilities: link.capabilities,
      createdAt: link.createdAt,
      revokedAt: link.revokedAt,
    }));
  }

  revokeGuestLink(linkId: string): boolean {
    return this.db.revokeWebChatLink(linkId);
  }

  verifyGuestToken(token: string): WebChatGuestTokenPayload | null {
    const payload = this.parseAndVerifyPayload(token);
    if (!payload) {
      return null;
    }

    const link = this.db.getWebChatLink(payload.linkId);
    if (!link || link.revokedAt) {
      return null;
    }

    if (new Date(link.expiresAt).getTime() < Date.now()) {
      return null;
    }

    if (link.tokenHash !== this.hashToken(token)) {
      return null;
    }

    return payload;
  }

  private hashToken(token: string): string {
    return createHmac('sha256', this.resolvedConfig.tokenSecret).update(token).digest('hex');
  }

  private signPayload(payload: WebChatGuestTokenPayload): string {
    const serialized = JSON.stringify(payload);
    const body = base64UrlEncode(serialized);
    const signature = createHmac('sha256', this.resolvedConfig.tokenSecret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private parseAndVerifyPayload(token: string): WebChatGuestTokenPayload | null {
    const [body, signature] = token.split('.', 2);
    if (!body || !signature) {
      return null;
    }

    const expected = createHmac('sha256', this.resolvedConfig.tokenSecret).update(body).digest();
    const received = Buffer.from(signature, 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return null;
    }

    try {
      const parsed = JSON.parse(base64UrlDecode(body)) as Partial<WebChatGuestTokenPayload>;
      if (
        typeof parsed.linkId !== 'string'
        || typeof parsed.sessionId !== 'string'
        || typeof parsed.displayName !== 'string'
        || typeof parsed.expiresAt !== 'string'
        || !parsed.capabilities
        || typeof parsed.capabilities !== 'object'
        || Array.isArray(parsed.capabilities)
      ) {
        return null;
      }

      return {
        linkId: parsed.linkId,
        sessionId: parsed.sessionId,
        displayName: parsed.displayName,
        expiresAt: parsed.expiresAt,
        capabilities: parsed.capabilities as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
}
