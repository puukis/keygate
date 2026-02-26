import { verifyWebhookSignature } from './signature.js';
import type { WebhookRoute, WebhookStore } from './store.js';

export interface WebhookDispatchResult {
  accepted: boolean;
  statusCode: number;
  message: string;
  route?: WebhookRoute;
}

export class WebhookService {
  constructor(
    private readonly store: WebhookStore,
    private readonly dispatchToSession: (sessionId: string, content: string) => Promise<void>,
  ) {}

  async listRoutes() {
    return this.store.listRoutes();
  }

  async createRoute(input: Parameters<WebhookStore['createRoute']>[0]) {
    return this.store.createRoute(input);
  }

  async updateRoute(id: string, patch: Parameters<WebhookStore['updateRoute']>[1]) {
    return this.store.updateRoute(id, patch);
  }

  async deleteRoute(id: string) {
    return this.store.deleteRoute(id);
  }

  async rotateSecret(id: string) {
    return this.store.rotateSecret(id);
  }

  async handleIncoming(routeId: string, rawBody: string, signatureHeader?: string): Promise<WebhookDispatchResult> {
    const route = await this.store.getRoute(routeId);
    if (!route) {
      return { accepted: false, statusCode: 404, message: 'Webhook route not found' };
    }

    if (!route.enabled) {
      return { accepted: false, statusCode: 403, message: 'Webhook route disabled', route };
    }

    if (!verifyWebhookSignature(route.secret, rawBody, signatureHeader)) {
      return { accepted: false, statusCode: 401, message: 'Invalid webhook signature', route };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { accepted: false, statusCode: 400, message: 'Webhook body must be valid JSON', route };
    }

    const message = `${route.promptPrefix}\nroute:${route.name}\nwebhookId:${route.id}\npayload:\n${JSON.stringify(parsed, null, 2)}`;
    await this.dispatchToSession(route.sessionId, message);

    return {
      accepted: true,
      statusCode: 202,
      message: 'Webhook accepted',
      route,
    };
  }
}
