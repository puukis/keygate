import { createVerify } from 'node:crypto';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { KeygateConfig } from '../types.js';
import { deleteTokens, getValidAccessToken, runOAuthFlow, writeTokens } from '../auth/index.js';
import { getConfigDir } from '../config/env.js';
import {
  GmailStore,
  type GmailAccountRecord,
  type GmailWatchCreateInput,
  type GmailWatchRecord,
  type GmailWatchUpdateInput,
} from './store.js';

const GMAIL_SCOPE = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const RENEW_LEEWAY_MS = 60 * 60 * 1000;
const RENEW_POLL_MS = 15 * 60 * 1000;

interface GmailWatchApiResponse {
  historyId?: string;
  expiration?: string;
}

interface GmailProfileResponse {
  emailAddress: string;
  historyId?: string;
}

interface GmailHistoryResponse {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{
      message?: {
        id?: string;
        threadId?: string;
        labelIds?: string[];
      };
    }>;
  }>;
  historyId?: string;
}

interface GmailMessageResponse {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
}

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface PubSubNotificationPayload {
  emailAddress?: string;
  historyId?: string | number;
}

interface GoogleJwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  sub?: string;
}

export interface GmailListResult {
  accounts: GmailAccountRecord[];
  watches: GmailWatchRecord[];
}

export interface GmailPushResult {
  accepted: boolean;
  statusCode: number;
  message: string;
  processed: number;
}

export interface GmailHealthSummary {
  accounts: number;
  watches: number;
  enabledWatches: number;
  expiredWatches: number;
  dueForRenewal: number;
}

interface GmailServiceOptions {
  store?: GmailStore;
  dispatchToSession?: (sessionId: string, content: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class GmailAutomationService {
  private readonly store: GmailStore;
  private readonly dispatchToSession: (sessionId: string, content: string) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private renewTimer: NodeJS.Timeout | null = null;
  private certCache: { expiresAt: number; certs: Record<string, string> } | null = null;

  constructor(
    private readonly config: KeygateConfig,
    options: GmailServiceOptions = {},
  ) {
    this.store = options.store ?? new GmailStore();
    this.dispatchToSession = options.dispatchToSession ?? (async () => {});
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.renewTimer) {
      return;
    }

    this.renewTimer = setInterval(() => {
      void this.renewDueWatches().catch((error) => {
        console.warn('Failed Gmail watch renewal tick:', error);
      });
    }, RENEW_POLL_MS);
  }

  stop(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  async list(): Promise<GmailListResult> {
    const [accounts, watches] = await Promise.all([
      this.store.listAccounts(),
      this.store.listWatches(),
    ]);
    return { accounts, watches };
  }

  async getHealth(): Promise<GmailHealthSummary> {
    const watches = await this.store.listWatches();
    const nowMs = this.now().getTime();
    let expiredWatches = 0;
    let dueForRenewal = 0;

    for (const watch of watches) {
      if (!watch.enabled || !watch.expirationAt) {
        continue;
      }
      const expirationMs = Date.parse(watch.expirationAt);
      if (expirationMs <= nowMs) {
        expiredWatches += 1;
      }
      if (expirationMs <= nowMs + RENEW_LEEWAY_MS) {
        dueForRenewal += 1;
      }
    }

    return {
      accounts: (await this.store.listAccounts()).length,
      watches: watches.length,
      enabledWatches: watches.filter((watch) => watch.enabled).length,
      expiredWatches,
      dueForRenewal,
    };
  }

  async login(options: {
    openExternalUrl?: (url: string) => Promise<boolean>;
    readCallbackUrl?: () => Promise<string>;
    timeoutMs?: number;
  } = {}): Promise<GmailAccountRecord> {
    const oauthConfig = this.resolveOAuthConfig();
    const tempTokenFilePath = path.join(getConfigDir(), 'auth', 'gmail', 'pending-login.json');
    const flow = await runOAuthFlow(oauthConfig, {
      openExternalUrl: options.openExternalUrl,
      readCallbackUrl: options.readCallbackUrl,
      timeoutMs: options.timeoutMs,
      tokenStore: {
        namespace: 'gmail',
        tokenFilePath: tempTokenFilePath,
      },
    });

    try {
      const profile = await this.fetchProfile(flow.tokens.access_token);
      const accountId = sanitizeAccountId(profile.emailAddress);
      const tokenFilePath = this.getAccountTokenFilePath(accountId);

      await writeTokens(flow.tokens, {
        namespace: 'gmail',
        tokenFilePath,
      });
      await this.store.upsertAccount({
        id: accountId,
        email: profile.emailAddress,
        tokenFilePath,
        lastHistoryId: profile.historyId,
        lastValidatedAt: this.now().toISOString(),
        lastError: null,
      });

      return (await this.store.getAccount(accountId))!;
    } finally {
      await deleteTokens({
        namespace: 'gmail',
        tokenFilePath: tempTokenFilePath,
      }).catch(() => {});
    }
  }

  async createWatch(input: GmailWatchCreateInput): Promise<GmailWatchRecord> {
    const accounts = await this.store.listAccounts();
    const defaultAccountId = accounts[0]?.id;
    const watch = await this.store.createWatch({
      accountId: input.accountId || defaultAccountId || '',
      targetSessionId: input.targetSessionId || this.config.gmail?.defaults.targetSessionId || '',
      labelIds: input.labelIds ?? this.config.gmail?.defaults.labelIds ?? [],
      promptPrefix: input.promptPrefix ?? this.config.gmail?.defaults.promptPrefix ?? '[GMAIL WATCH EVENT]',
      enabled: input.enabled,
    });
    await this.renewAccountWatches(watch.accountId);
    return (await this.store.getWatch(watch.id)) ?? watch;
  }

  async updateWatch(watchId: string, patch: GmailWatchUpdateInput): Promise<GmailWatchRecord> {
    const existing = await this.store.getWatch(watchId);
    if (!existing) {
      throw new Error(`Gmail watch not found: ${watchId}`);
    }

    const watch = await this.store.updateWatch(watchId, patch);
    await this.renewAccountWatches(existing.accountId);
    return watch;
  }

  async deleteWatch(watchId: string): Promise<boolean> {
    const existing = await this.store.getWatch(watchId);
    const deleted = await this.store.deleteWatch(watchId);
    if (deleted && existing) {
      await this.renewAccountWatches(existing.accountId);
    }
    return deleted;
  }

  async testWatch(watchId: string): Promise<{ ok: boolean; message: string }> {
    const watch = await this.store.getWatch(watchId);
    if (!watch) {
      throw new Error(`Gmail watch not found: ${watchId}`);
    }

    const account = await this.store.getAccount(watch.accountId);
    if (!account) {
      throw new Error(`Gmail account not found: ${watch.accountId}`);
    }

    await this.dispatchToSession(watch.targetSessionId, [
      watch.promptPrefix,
      `account:${account.email}`,
      `watchId:${watch.id}`,
      `labels:${watch.labelIds.length > 0 ? watch.labelIds.join(', ') : '(all)'}`,
      'subject: Keygate Gmail watch test',
      'from: keygate@test.local',
      `date:${this.now().toISOString()}`,
      'snippet: This is a synthetic Gmail watch test event.',
    ].join('\n'));

    await this.store.updateWatch(watch.id, {
      lastProcessedAt: this.now().toISOString(),
      lastError: null,
    });

    return {
      ok: true,
      message: `Delivered test event to ${watch.targetSessionId}`,
    };
  }

  async renewDueWatches(): Promise<number> {
    const watches = await this.store.listWatches();
    const dueAccountIds = new Set<string>();
    const nowMs = this.now().getTime();

    for (const watch of watches) {
      if (!watch.enabled) {
        continue;
      }

      if (!watch.expirationAt) {
        dueAccountIds.add(watch.accountId);
        continue;
      }

      const expirationMs = Date.parse(watch.expirationAt);
      if (!Number.isFinite(expirationMs) || expirationMs <= nowMs + RENEW_LEEWAY_MS) {
        dueAccountIds.add(watch.accountId);
      }
    }

    for (const accountId of dueAccountIds) {
      await this.renewAccountWatches(accountId);
    }

    return dueAccountIds.size;
  }

  async renewAccountWatches(accountId: string): Promise<{ historyId?: string; expirationAt?: string }> {
    const account = await this.store.getAccount(accountId);
    if (!account) {
      throw new Error(`Gmail account not found: ${accountId}`);
    }

    const watches = (await this.store.listWatchesForAccount(accountId)).filter((watch) => watch.enabled);
    if (watches.length === 0) {
      return {};
    }

    const accessToken = await this.getAccountAccessToken(account);
    const response = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicName: this.requirePubsubTopic(),
        ...(collectAccountLabelIds(watches).length > 0
          ? {
            labelIds: collectAccountLabelIds(watches),
            labelFilterAction: 'include',
          }
          : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = `Gmail watch renewal failed (${response.status})${text ? `: ${text}` : ''}`;
      await this.store.updateAccount(accountId, { lastError: detail });
      for (const watch of watches) {
        await this.store.updateWatch(watch.id, { lastError: detail });
      }
      throw new Error(detail);
    }

    const payload = await response.json() as GmailWatchApiResponse;
    const lastHistoryId = payload.historyId?.trim();
    const expirationAt = parseExpiration(payload.expiration);
    const nowIso = this.now().toISOString();

    await this.store.updateAccount(accountId, {
      lastHistoryId: lastHistoryId ?? null,
      lastValidatedAt: nowIso,
      lastError: null,
    });

    for (const watch of watches) {
      await this.store.updateWatch(watch.id, {
        lastHistoryId: watch.lastHistoryId ?? lastHistoryId ?? null,
        expirationAt: expirationAt ?? null,
        lastRenewedAt: nowIso,
        lastError: null,
      });
    }

    return {
      historyId: lastHistoryId,
      expirationAt: expirationAt ?? undefined,
    };
  }

  async handlePushRequest(rawBody: string, authHeader: string | undefined, requestUrl: string): Promise<GmailPushResult> {
    const secret = this.config.gmail?.defaults.pushPathSecret?.trim();
    if (secret) {
      const url = new URL(requestUrl, 'http://localhost');
      if (url.searchParams.get('secret') !== secret) {
        return {
          accepted: false,
          statusCode: 401,
          message: 'Missing or invalid Gmail push secret',
          processed: 0,
        };
      }
    }

    if (authHeader?.startsWith('Bearer ')) {
      const aud = this.resolvePushAudience(requestUrl);
      const verified = await this.verifyGoogleOidcToken(authHeader.slice('Bearer '.length).trim(), aud);
      if (!verified.valid) {
        return {
          accepted: false,
          statusCode: 401,
          message: verified.error ?? 'Invalid Google OIDC token',
          processed: 0,
        };
      }
    } else if (!secret) {
      return {
        accepted: false,
        statusCode: 401,
        message: 'Missing Google OIDC bearer token',
        processed: 0,
      };
    }

    let envelope: PubSubEnvelope;
    try {
      envelope = JSON.parse(rawBody) as PubSubEnvelope;
    } catch {
      return { accepted: false, statusCode: 400, message: 'Invalid Gmail Pub/Sub payload', processed: 0 };
    }

    const messageId = envelope.message?.messageId?.trim();
    const encodedData = envelope.message?.data?.trim();
    if (!messageId || !encodedData) {
      return { accepted: false, statusCode: 400, message: 'Gmail Pub/Sub payload missing message data', processed: 0 };
    }

    const deduped = await this.store.recordNotification(messageId);
    if (!deduped) {
      return { accepted: true, statusCode: 202, message: 'Duplicate Gmail notification ignored', processed: 0 };
    }

    let decoded: PubSubNotificationPayload;
    try {
      decoded = JSON.parse(Buffer.from(encodedData, 'base64').toString('utf8')) as PubSubNotificationPayload;
    } catch {
      return { accepted: false, statusCode: 400, message: 'Gmail notification body was not valid JSON', processed: 0 };
    }

    const email = decoded.emailAddress?.trim().toLowerCase();
    const historyId = decoded.historyId != null ? String(decoded.historyId).trim() : undefined;
    if (!email || !historyId) {
      return { accepted: false, statusCode: 400, message: 'Gmail notification missing emailAddress or historyId', processed: 0 };
    }

    const account = await this.store.findAccountByEmail(email);
    if (!account) {
      return { accepted: true, statusCode: 202, message: `No Gmail account configured for ${email}`, processed: 0 };
    }

    const watches = (await this.store.listWatchesForAccount(account.id)).filter((watch) => watch.enabled);
    if (watches.length === 0) {
      return { accepted: true, statusCode: 202, message: `No enabled Gmail watches for ${email}`, processed: 0 };
    }

    let processed = 0;
    for (const watch of watches) {
      processed += await this.processWatchNotification(account, watch, historyId);
    }

    return {
      accepted: true,
      statusCode: 202,
      message: processed > 0 ? `Processed ${processed} Gmail events` : 'Gmail notification accepted',
      processed,
    };
  }

  private async processWatchNotification(
    account: GmailAccountRecord,
    watch: GmailWatchRecord,
    incomingHistoryId: string,
  ): Promise<number> {
    const startHistoryId = watch.lastHistoryId ?? account.lastHistoryId;
    if (!startHistoryId || compareHistoryIds(incomingHistoryId, startHistoryId) <= 0) {
      await this.store.updateWatch(watch.id, {
        lastHistoryId: incomingHistoryId,
        lastProcessedAt: this.now().toISOString(),
        lastError: null,
      });
      await this.store.updateAccount(account.id, {
        lastHistoryId: incomingHistoryId,
        lastValidatedAt: this.now().toISOString(),
        lastError: null,
      });
      return 0;
    }

    try {
      const accessToken = await this.getAccountAccessToken(account);
      const history = await this.fetchHistory(accessToken, startHistoryId);
      const messageIds = Array.from(new Set(
        (history.history ?? []).flatMap((entry) => (
          entry.messagesAdded?.map((item) => item.message?.id?.trim()).filter((value): value is string => Boolean(value)) ?? []
        ))
      ));

      let delivered = 0;
      for (const messageId of messageIds) {
        const dispatchKey = `msg:${watch.id}:${messageId}`;
        const isNew = await this.store.recordNotification(dispatchKey);
        if (!isNew) {
          continue;
        }

        const message = await this.fetchMessage(accessToken, messageId);
        if (!this.matchesWatchLabels(watch, message.labelIds ?? [])) {
          continue;
        }

        await this.dispatchToSession(watch.targetSessionId, formatGmailDispatchMessage({
          promptPrefix: watch.promptPrefix,
          accountEmail: account.email,
          watchId: watch.id,
          labels: message.labelIds ?? [],
          subject: getHeaderValue(message, 'subject') ?? '(no subject)',
          from: getHeaderValue(message, 'from') ?? '(unknown sender)',
          date: getHeaderValue(message, 'date') ?? message.internalDate ?? this.now().toISOString(),
          snippet: message.snippet ?? '',
          messageId: message.id,
          threadId: message.threadId,
        }));
        delivered += 1;
      }

      const nowIso = this.now().toISOString();
      await this.store.updateWatch(watch.id, {
        lastHistoryId: incomingHistoryId,
        lastProcessedAt: nowIso,
        lastError: null,
      });
      await this.store.updateAccount(account.id, {
        lastHistoryId: incomingHistoryId,
        lastValidatedAt: nowIso,
        lastError: null,
      });
      return delivered;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to process Gmail notification';
      await this.store.updateWatch(watch.id, { lastError: message });
      await this.store.updateAccount(account.id, { lastError: message });
      return 0;
    }
  }

  private resolveOAuthConfig() {
    const clientId = this.config.gmail?.clientId?.trim();
    if (!clientId) {
      throw new Error('Gmail OAuth clientId is missing. Set KEYGATE_GMAIL_CLIENT_ID or configure gmail.clientId.');
    }

    return {
      clientId,
      clientSecret: this.config.gmail?.clientSecret?.trim(),
      authorizationEndpoint: this.config.gmail?.authorizationEndpoint,
      tokenEndpoint: this.config.gmail?.tokenEndpoint,
      redirectUri: this.config.gmail?.redirectUri,
      redirectPort: this.config.gmail?.redirectPort,
      scope: GMAIL_SCOPE,
    };
  }

  private async getAccountAccessToken(account: GmailAccountRecord): Promise<string> {
    const tokenEndpoint = this.config.gmail?.tokenEndpoint?.trim() || 'https://oauth2.googleapis.com/token';
    const oauthConfig = this.resolveOAuthConfig();
    return getValidAccessToken(tokenEndpoint, oauthConfig.clientId, {
      namespace: 'gmail',
      tokenFilePath: account.tokenFilePath,
    }, oauthConfig.clientSecret);
  }

  private async fetchProfile(accessToken: string): Promise<GmailProfileResponse> {
    const response = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to load Gmail profile (${response.status})${text ? `: ${text}` : ''}`);
    }
    const payload = await response.json() as GmailProfileResponse;
    if (!payload.emailAddress?.trim()) {
      throw new Error('Gmail profile response missing emailAddress');
    }
    return payload;
  }

  private async fetchHistory(accessToken: string, startHistoryId: string): Promise<GmailHistoryResponse> {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to load Gmail history (${response.status})${text ? `: ${text}` : ''}`);
    }
    return await response.json() as GmailHistoryResponse;
  }

  private async fetchMessage(accessToken: string, messageId: string): Promise<GmailMessageResponse> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('format', 'metadata');
    url.searchParams.append('metadataHeaders', 'Subject');
    url.searchParams.append('metadataHeaders', 'From');
    url.searchParams.append('metadataHeaders', 'Date');
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to load Gmail message ${messageId} (${response.status})${text ? `: ${text}` : ''}`);
    }
    return await response.json() as GmailMessageResponse;
  }

  private matchesWatchLabels(watch: GmailWatchRecord, labels: string[]): boolean {
    if (watch.labelIds.length === 0) {
      return true;
    }
    const current = new Set(labels.map((value) => value.trim()));
    return watch.labelIds.some((label) => current.has(label));
  }

  private requirePubsubTopic(): string {
    const topic = this.config.gmail?.defaults.pubsubTopic?.trim();
    if (!topic) {
      throw new Error('gmail.defaults.pubsubTopic is required to create Gmail watches.');
    }
    return topic;
  }

  private resolvePushAudience(requestUrl: string): string {
    const configured = this.config.gmail?.defaults.pushBaseUrl?.trim();
    if (configured) {
      const base = configured.replace(/\/+$/g, '');
      const secret = this.config.gmail?.defaults.pushPathSecret?.trim();
      return `${base}/api/gmail/push${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`;
    }

    const url = new URL(requestUrl, 'http://localhost');
    return url.toString();
  }

  private getAccountTokenFilePath(accountId: string): string {
    return path.join(getConfigDir(), 'auth', 'gmail', `${accountId}.json`);
  }

  private async verifyGoogleOidcToken(token: string, audience: string): Promise<{ valid: boolean; error?: string; payload?: GoogleJwtPayload }> {
    const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      return { valid: false, error: 'Malformed JWT' };
    }

    let header: { alg?: string; kid?: string };
    let payload: GoogleJwtPayload;
    try {
      header = JSON.parse(base64UrlDecode(headerSegment).toString('utf8')) as { alg?: string; kid?: string };
      payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8')) as GoogleJwtPayload;
    } catch {
      return { valid: false, error: 'Invalid JWT encoding' };
    }

    if (header.alg !== 'RS256' || !header.kid) {
      return { valid: false, error: 'Unsupported JWT algorithm or missing kid' };
    }

    const certs = await this.getGoogleSigningCerts();
    const cert = certs[header.kid];
    if (!cert) {
      return { valid: false, error: 'Google signing certificate not found for token kid' };
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();
    const validSignature = verifier.verify(cert, base64UrlDecode(signatureSegment));
    if (!validSignature) {
      return { valid: false, error: 'JWT signature verification failed' };
    }

    if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
      return { valid: false, error: 'Unexpected JWT issuer' };
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
      return { valid: false, error: 'JWT expired' };
    }
    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + 60) {
      return { valid: false, error: 'JWT iat is in the future' };
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter((value): value is string => typeof value === 'string');
    if (!audiences.includes(audience)) {
      return { valid: false, error: 'JWT audience mismatch' };
    }

    return { valid: true, payload };
  }

  private async getGoogleSigningCerts(): Promise<Record<string, string>> {
    const nowMs = this.now().getTime();
    if (this.certCache && this.certCache.expiresAt > nowMs) {
      return this.certCache.certs;
    }

    const response = await this.fetchImpl(GOOGLE_CERTS_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google signing certs (${response.status})`);
    }

    const cacheControl = response.headers.get('cache-control') ?? '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const maxAgeSeconds = maxAgeMatch ? Number.parseInt(maxAgeMatch[1] ?? '300', 10) : 300;
    const certs = await response.json() as Record<string, string>;
    this.certCache = {
      expiresAt: nowMs + Math.max(60, maxAgeSeconds) * 1000,
      certs,
    };
    return certs;
  }
}

function sanitizeAccountId(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function parseExpiration(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric).toISOString();
}

function compareHistoryIds(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function collectAccountLabelIds(watches: GmailWatchRecord[]): string[] {
  return Array.from(new Set(watches.flatMap((watch) => watch.labelIds))).sort();
}

function getHeaderValue(message: GmailMessageResponse, name: string): string | undefined {
  const target = name.trim().toLowerCase();
  const headers = message.payload?.headers ?? [];
  const entry = headers.find((header) => header.name?.trim().toLowerCase() === target);
  return entry?.value?.trim();
}

function formatGmailDispatchMessage(input: {
  promptPrefix: string;
  accountEmail: string;
  watchId: string;
  labels: string[];
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageId: string;
  threadId?: string;
}): string {
  return [
    input.promptPrefix,
    `account:${input.accountEmail}`,
    `watchId:${input.watchId}`,
    `messageId:${input.messageId}`,
    `threadId:${input.threadId ?? ''}`,
    `labels:${input.labels.length > 0 ? input.labels.join(', ') : '(none)'}`,
    `subject:${input.subject}`,
    `from:${input.from}`,
    `date:${input.date}`,
    `snippet:${input.snippet}`,
  ].join('\n');
}

function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
