/**
 * @module web/routes/webhooks
 *
 * Admin routes for managing per-gate outbound webhooks (web-only; mutations require passkey step-up).
 */
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route, webOnly } from '../routing.ts';
import { logger } from '../../src/logging.ts';

/**
 * Outbound webhook routes for a gate.
 *
 * @param modules - Composed server modules.
 * @returns Registered route definitions.
 */
export function webhooksRoutes(modules: Modules): Route[] {
  const { store } = modules.context;
  return [
    webOnly(route('GET', `${G}/webhooks`, 'gate-admin', async ({ gate }) => [200, {
      webhooks: await dk.listWebhooks(store, gate.phoneNumber),
      deliveries: await dk.listWebhookDeliveries(store, gate.phoneNumber),
      availableEvents: dk.WEBHOOK_EVENTS,
    }])),
    webOnly(route('POST', `${G}/webhooks`, 'gate-admin', async ({ session, gate, body }) => {
      const created = await dk.createWebhook(store, gate.phoneNumber, body, session.user);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'webhook', summary: `Added webhook "${created.webhook.name}"` });
      logger('gates').info`Gate ${gate.phoneNumber}: webhook "${created.webhook.name}" created by ${session.user}`;
      return [201, created];
    })),
    webOnly(route('PUT', `${G}/webhooks/:id`, 'gate-admin', async ({ session, gate, params, body }) => {
      const webhook = await dk.updateWebhook(store, gate.phoneNumber, params.id, body);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'webhook', summary: `Updated webhook "${webhook.name}"` });
      return [200, { webhook }];
    })),
    webOnly(route('DELETE', `${G}/webhooks/:id`, 'gate-admin', async ({ session, gate, params }) => {
      const name = await dk.deleteWebhook(store, gate.phoneNumber, params.id);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'webhook', summary: `Removed webhook "${name}"` });
      logger('gates').info`Gate ${gate.phoneNumber}: webhook "${name}" deleted by ${session.user}`;
      return [200, { ok: true }];
    })),
    webOnly(route('POST', `${G}/webhooks/:id/test`, 'gate-admin', async ({ gate, params }) => {
      const result = await dk.sendTestWebhook(store, gate.phoneNumber, params.id);
      return [result.ok ? 200 : 502, result];
    })),
  ];
}
