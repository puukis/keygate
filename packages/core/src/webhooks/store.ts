import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { getConfigDir } from '../config/env.js';

export interface WebhookRoute {
  id: string;
  name: string;
  sessionId: string;
  secret: string;
  enabled: boolean;
  promptPrefix: string;
  createdAt: string;
  updatedAt: string;
}

interface WebhookStorePayload {
  version: 1;
  routes: WebhookRoute[];
}

export interface WebhookCreateInput {
  name: string;
  sessionId: string;
  promptPrefix?: string;
  enabled?: boolean;
  secret?: string;
}

export interface WebhookUpdateInput {
  sessionId?: string;
  promptPrefix?: string;
  enabled?: boolean;
}

const MAX_NAME_CHARS = 120;
const MAX_SESSION_ID_CHARS = 256;
const MAX_PREFIX_CHARS = 200;

function storePath(): string {
  return path.join(getConfigDir(), 'webhooks.json');
}

function defaultPayload(): WebhookStorePayload {
  return { version: 1, routes: [] };
}

function generateSecret(): string {
  return randomBytes(24).toString('hex');
}

async function loadPayload(): Promise<WebhookStorePayload> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WebhookStorePayload>;
    return {
      version: 1,
      routes: Array.isArray(parsed.routes) ? parsed.routes.filter((route): route is WebhookRoute => typeof route?.id === 'string') : [],
    };
  } catch {
    return defaultPayload();
  }
}

async function savePayload(payload: WebhookStorePayload): Promise<void> {
  const target = storePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

export class WebhookStore {
  async listRoutes(): Promise<WebhookRoute[]> {
    const payload = await loadPayload();
    return payload.routes.map((route) => ({ ...route })).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async getRoute(id: string): Promise<WebhookRoute | null> {
    const payload = await loadPayload();
    const route = payload.routes.find((item) => item.id === id);
    return route ? { ...route } : null;
  }

  async createRoute(input: WebhookCreateInput): Promise<WebhookRoute> {
    const name = input.name.trim();
    const sessionId = input.sessionId.trim();
    const promptPrefix = input.promptPrefix?.trim() || '[WEBHOOK EVENT]';
    const secret = input.secret?.trim() || generateSecret();

    if (!name || !sessionId) {
      throw new Error('name and sessionId are required');
    }
    if (name.length > MAX_NAME_CHARS) {
      throw new Error(`name exceeds ${MAX_NAME_CHARS} characters`);
    }
    if (sessionId.length > MAX_SESSION_ID_CHARS) {
      throw new Error(`sessionId exceeds ${MAX_SESSION_ID_CHARS} characters`);
    }
    if (promptPrefix.length > MAX_PREFIX_CHARS) {
      throw new Error(`promptPrefix exceeds ${MAX_PREFIX_CHARS} characters`);
    }
    if (!/^[a-fA-F0-9]{16,}$/.test(secret)) {
      throw new Error('secret must be a hex string with at least 16 characters');
    }

    const now = new Date().toISOString();
    const route: WebhookRoute = {
      id: randomUUID(),
      name,
      sessionId,
      secret,
      enabled: input.enabled ?? true,
      promptPrefix,
      createdAt: now,
      updatedAt: now,
    };

    const payload = await loadPayload();
    payload.routes.push(route);
    await savePayload(payload);
    return { ...route };
  }

  async updateRoute(id: string, patch: WebhookUpdateInput): Promise<WebhookRoute> {
    const payload = await loadPayload();
    const route = payload.routes.find((item) => item.id === id);
    if (!route) {
      throw new Error(`Webhook route not found: ${id}`);
    }

    if (typeof patch.sessionId === 'string') {
      const sessionId = patch.sessionId.trim();
      if (!sessionId) {
        throw new Error('sessionId cannot be empty');
      }
      if (sessionId.length > MAX_SESSION_ID_CHARS) {
        throw new Error(`sessionId exceeds ${MAX_SESSION_ID_CHARS} characters`);
      }
      route.sessionId = sessionId;
    }

    if (typeof patch.promptPrefix === 'string') {
      const prefix = patch.promptPrefix.trim();
      if (!prefix) {
        throw new Error('promptPrefix cannot be empty');
      }
      if (prefix.length > MAX_PREFIX_CHARS) {
        throw new Error(`promptPrefix exceeds ${MAX_PREFIX_CHARS} characters`);
      }
      route.promptPrefix = prefix;
    }

    if (typeof patch.enabled === 'boolean') {
      route.enabled = patch.enabled;
    }

    route.updatedAt = new Date().toISOString();
    await savePayload(payload);
    return { ...route };
  }

  async deleteRoute(id: string): Promise<boolean> {
    const payload = await loadPayload();
    const before = payload.routes.length;
    payload.routes = payload.routes.filter((route) => route.id !== id);
    const changed = payload.routes.length !== before;
    if (changed) {
      await savePayload(payload);
    }
    return changed;
  }

  async rotateSecret(id: string): Promise<WebhookRoute> {
    const payload = await loadPayload();
    const route = payload.routes.find((item) => item.id === id);
    if (!route) {
      throw new Error(`Webhook route not found: ${id}`);
    }
    route.secret = generateSecret();
    route.updatedAt = new Date().toISOString();
    await savePayload(payload);
    return { ...route };
  }
}
