/**
 * @module web/webhooks
 *
 * Outbound webhook dispatcher backed by the `webhook_deliveries` outbox (`src/webhooks.ts`).
 */
import * as dk from '../index.ts';
import type { WebhookEvent } from '../src/types.ts';
import type { ContextModule } from './context.ts';
import { logger, logMessages } from '../src/logging.ts';

/**
 * Creates the server's outbound webhook module.
 *
 * @param deps - Shared context dependencies.
 * @returns Webhook emission, delivery tick, and graceful-shutdown helpers.
 */
export function createWebhooks(deps: ContextModule) {
  const { store } = deps;
  let delivering: Promise<unknown> | null = null;

  /** Processes due queued webhook deliveries (one batch runner at a time). */
  function deliverWebhooks(): void {
    if (delivering) return;
    delivering = dk.deliverQueuedWebhooks(store, { log: logMessages('server') })
      .catch((err) => logger('server').error`Webhook outbox failed: ${(err as Error).message}`)
      .finally(() => { delivering = null; });
  }

  /**
   * Queues a webhook event for a gate and triggers immediate delivery; never throws to callers.
   *
   * @param phone - Gate system phone number.
   * @param event - Webhook event type.
   * @param data - Event data payload.
   */
  function emitWebhook(phone: string, event: WebhookEvent, data: Record<string, unknown>): void {
    dk.queueWebhookEvent(store, phone, event, data)
      .then((count) => { if (count > 0) deliverWebhooks(); })
      .catch((err) => logger('server').warn`Webhook enqueue failed (${event}): ${(err as Error).message}`);
  }

  /** Resolves when no webhook delivery batch is in flight (waited for during shutdown). */
  const webhooksIdle = () => delivering ?? Promise.resolve();
  return { deliverWebhooks, emitWebhook, webhooksIdle };
}

export type WebhooksModule = ReturnType<typeof createWebhooks>;
