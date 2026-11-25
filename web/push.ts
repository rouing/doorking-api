/**
 * @module web/push
 *
 * Push delivery module: Web Push (VAPID) + optional Firebase Cloud Messaging (FCM HTTP v1) for native Android devices.
 */
import * as dk from '../index.ts';
import type { ContextModule } from './context.ts';
import { logger, logMessages } from '../src/logging.ts';

/**
 * Creates the server's Push module (Web Push + optional FCM).
 *
 * @param deps - Shared server context.
 * @returns VAPID key loader, FCM status, gate-admin push alert sender, user notice sender, and test push helpers.
 */
export function createPush(deps: ContextModule) {
  const { APP, config, store } = deps;
  let vapidPromise: Promise<dk.VapidConfig> | null = null;
  let fcmSender: dk.FcmSender | null = null;
  if (config.push.fcmServiceAccountPath) {
    try {
      fcmSender = dk.createFcmSender(config.push.fcmServiceAccountPath);
      if (fcmSender) logger('server').info`FCM push enabled for project ${fcmSender.projectId}`;
    } catch (err) {
      logger('server').warn`FCM service account could not be loaded: ${(err as Error).message}`;
    }
  }

  /** Loads or auto-generates the server's VAPID keypair (cached for this server instance). */
  function vapid(): Promise<dk.VapidConfig> {
    if (!vapidPromise) {
      vapidPromise = dk.ensureVapidKeys(store, { ...config.push, appUrl: APP }).catch((err) => {
        vapidPromise = null;
        throw err;
      });
    }
    return vapidPromise;
  }

  /** Returns the public VAPID key (base64url) browsers pass to `pushManager.subscribe`. */
  async function publicKey(): Promise<string> {
    return (await vapid()).publicKey;
  }

  /** True when server-side FCM HTTP v1 credentials are configured and loaded. */
  function fcmEnabled(): boolean {
    return fcmSender !== null;
  }

  /** Fans out a push payload across Web Push (VAPID) and Android FCM for `users`. */
  async function deliverPush(
    users: string[],
    payload: { title: string; body: string; url: string; tag: string },
  ): Promise<{ sent: number; failed: number; removed: number }> {
    const [web, fcm] = await Promise.all([
      dk.sendPushToUsers(store, await vapid(), users, payload, { log: logMessages('server') }),
      dk.sendFcmToUsers(store, fcmSender, users, payload, { log: logMessages('server') }),
    ]);
    return { sent: web.sent + fcm.sent, failed: web.failed + fcm.failed, removed: web.removed + fcm.removed };
  }

  /**
   * Sends a push notification (Web Push + Android FCM) to all gate admins of `phone` with `notify_alerts` enabled.
   * Never throws (errors are logged).
   */
  async function pushGateAlert(phone: string, title: string, body: string): Promise<void> {
    try {
      const admins = await dk.pushAlertRecipients(store, phone);
      if (!admins.length) return;
      await deliverPush(admins, { title, body, url: '/', tag: `gate-${dk.phoneDigits(phone)}` });
    } catch (err) {
      logger('server').warn`Push gate alert failed: ${(err as Error).message}`;
    }
  }

  /**
   * Sends a test push notification to all of `username`'s subscribed Web Push + FCM devices.
   */
  async function sendTestPush(username: string): Promise<{ sent: number; failed: number; removed: number }> {
    return deliverPush([username], {
      title: 'DoorKing Gate Manager',
      body: 'Push notifications are working on this device.',
      url: '/',
      tag: 'doorking-test',
    });
  }

  /**
   * Sends a test push notification specifically to `username`'s registered Android FCM devices.
   */
  async function sendTestFcm(username: string): Promise<{ enabled: boolean; sent: number; failed: number; removed: number }> {
    if (!fcmSender) return { enabled: false, sent: 0, failed: 0, removed: 0 };
    const result = await dk.sendFcmToUsers(store, fcmSender, [username], {
      title: 'DoorKing Gate Manager',
      body: 'Android push notifications are working on this device.',
      url: '/',
      tag: 'doorking-test',
    }, { log: logMessages('server') });
    return { enabled: true, ...result };
  }

  /**
   * Sends a high-priority FCM push with custom `data` fields to `username`'s registered Android devices.
   */
  async function sendFcmDataToUser(
    username: string,
    payload: dk.FcmPayload,
  ): Promise<{ enabled: boolean; sent: number; failed: number; removed: number }> {
    if (!fcmSender) return { enabled: false, sent: 0, failed: 0, removed: 0 };
    const result = await dk.sendFcmToUsers(store, fcmSender, [username], payload, { log: logMessages('server') });
    return { enabled: true, ...result };
  }

  /**
   * Sends a push notification (Web Push + Android FCM) to one user's devices (never throws).
   */
  async function pushUserNotice(username: string, title: string, body: string, tag = 'doorking-notice'): Promise<void> {
    try {
      await deliverPush([username], { title, body, url: '/', tag });
    } catch (err) {
      logger('server').warn`Push user notice failed: ${(err as Error).message}`;
    }
  }

  return { publicKey, fcmEnabled, pushGateAlert, pushUserNotice, sendTestPush, sendTestFcm, sendFcmDataToUser };
}

export type PushModule = ReturnType<typeof createPush>;
