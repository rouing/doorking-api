/**
 * @module src/fcm
 *
 * Firebase Cloud Messaging (FCM) HTTP v1 delivery for native Android devices (`com.doorking.gate`).
 * Uses pure Node `crypto` RS256 service-account JWTs -> OAuth2 access tokens (zero extra npm dependencies)
 * and persists per-device FCM registration tokens in the `fcm_tokens` table.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { all, one, run, type Store } from './db.ts';
import { httpError } from './errors.ts';
import { userKey } from './users.ts';
import type { PushPayload } from './push.ts';

export interface FcmTokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface FcmTokenRow {
  id: string;
  username: string;
  token: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmPayload extends PushPayload {
  data?: Record<string, string>;
}

export interface FcmSender {
  readonly projectId: string;
  send(token: string, payload: FcmPayload): Promise<{ ok: true } | { ok: false; unregistered: boolean; error: string }>;
}

const fromRow = (row: FcmTokenRow): FcmTokenInfo => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/**
 * Loads a Firebase Service Account JSON file and returns a cached-token FCM HTTP v1 sender, or `null` if unconfigured.
 */
export function createFcmSender(
  serviceAccountPath: string,
  { fetchFn = fetch }: { fetchFn?: typeof fetch } = {},
): FcmSender | null {
  const trimmed = String(serviceAccountPath || '').trim();
  if (!trimmed || !fs.existsSync(trimmed)) return null;
  const raw = JSON.parse(fs.readFileSync(trimmed, 'utf8')) as Partial<ServiceAccountJson>;
  if (!raw.project_id || !raw.client_email || !raw.private_key) {
    throw new Error(`Invalid Firebase service account JSON at ${trimmed}: missing project_id, client_email, or private_key`);
  }
  const projectId = raw.project_id;
  const clientEmail = raw.client_email;
  const privateKey = raw.private_key;
  const tokenUri = raw.token_uri || 'https://oauth2.googleapis.com/token';

  let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

  async function getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    if (cachedToken && cachedToken.expiresAtMs - 60_000 > nowMs) {
      return cachedToken.accessToken;
    }
    const nowSec = Math.floor(nowMs / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    }));
    const signingInput = `${header}.${claims}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).end().sign(privateKey);
    const assertion = `${signingInput}.${b64url(signature)}`;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`FCM OAuth2 token exchange failed (HTTP ${res.status})`);
    }
    const json = await res.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('FCM OAuth2 response missing access_token');
    cachedToken = {
      accessToken: json.access_token,
      expiresAtMs: nowMs + Math.max(60, Number(json.expires_in) || 3600) * 1000,
    };
    return cachedToken.accessToken;
  }

  return {
    projectId,
    async send(token, payload) {
      const accessToken = await getAccessToken();
      const tag = payload.tag || 'doorking-alert';
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
      const extraData: Record<string, string> = {};
      if (payload.data) {
        for (const [k, v] of Object.entries(payload.data)) {
          if (v !== undefined && v !== null) extraData[k] = String(v);
        }
      }
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: payload.title,
              body: payload.body,
            },
            data: {
              url: payload.url || '/',
              tag,
              ...extraData,
            },
            android: {
              priority: 'HIGH',
              notification: {
                channel_id: 'doorking_alerts',
                tag,
              },
            },
          },
        }),
      });
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      const unregistered = res.status === 404 ||
        /UNREGISTERED|NOT_FOUND|Requested entity was not found|not a valid FCM registration token/i.test(text);
      return { ok: false, unregistered, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    },
  };
}

/**
 * Validates and saves (or updates) an Android FCM registration token for `username`.
 */
export async function saveFcmToken(
  store: Store,
  username: string,
  body: { token?: unknown; label?: unknown },
): Promise<FcmTokenInfo> {
  const token = String(body.token ?? '').trim();
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) {
    throw httpError('FCM device token is missing or invalid');
  }
  const label = String(body.label ?? '').trim().slice(0, 60) || 'Android';
  const name = userKey(username);
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  await run(store, `INSERT INTO fcm_tokens (id, username, token, label, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (token) DO UPDATE SET username = excluded.username, label = excluded.label`,
  [id, name, token, label, now]);
  const row = (await one<FcmTokenRow>(store, 'SELECT * FROM fcm_tokens WHERE token = $1', [token]))!;
  return fromRow(row);
}

/**
 * Lists the signed-in user's registered Android FCM devices.
 */
export async function listFcmTokens(store: Store, username: string): Promise<FcmTokenInfo[]> {
  return (await all<FcmTokenRow>(store, 'SELECT * FROM fcm_tokens WHERE username = $1 ORDER BY created_at DESC', [userKey(username)])).map(fromRow);
}

/**
 * Removes one FCM token belonging to `username` (by row `id` or raw `token`).
 */
export async function deleteFcmToken(store: Store, username: string, idOrToken: string): Promise<boolean> {
  const target = String(idOrToken ?? '').trim();
  if (!target) return false;
  return (await run(store, 'DELETE FROM fcm_tokens WHERE username = $1 AND (id = $2 OR token = $2)',
    [userKey(username), target])) > 0;
}

/**
 * Sends an FCM notification to all registered Android devices of `usernames`, pruning unregistered tokens.
 */
export async function sendFcmToUsers(
  store: Store,
  sender: FcmSender | null,
  usernames: string[],
  payload: FcmPayload,
  { log = () => {} }: { log?: (msg: string) => void } = {},
): Promise<{ sent: number; failed: number; removed: number }> {
  const out = { sent: 0, failed: 0, removed: 0 };
  if (!sender) return out;
  const unique = [...new Set(usernames.map(userKey).filter(Boolean))];
  if (!unique.length) return out;
  const rows = await all<FcmTokenRow>(store, 'SELECT * FROM fcm_tokens WHERE username = ANY($1::text[])', [unique]);
  for (const row of rows) {
    try {
      const result = await sender.send(row.token, payload);
      if (result.ok) {
        await run(store, 'UPDATE fcm_tokens SET last_used_at = $2 WHERE id = $1', [row.id, new Date().toISOString()]);
        out.sent++;
      } else if (result.unregistered) {
        await run(store, 'DELETE FROM fcm_tokens WHERE id = $1', [row.id]);
        out.removed++;
      } else {
        out.failed++;
        log(`FCM push to ${row.username} (${row.label}) failed: ${result.error}`);
      }
    } catch (err) {
      out.failed++;
      log(`FCM push to ${row.username} (${row.label}) failed: ${(err as Error).message}`);
    }
  }
  return out;
}
