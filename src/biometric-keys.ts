/**
 * @module src/biometric-keys
 *
 * Device-bound Android Keystore / StrongBox ECDSA P-256 public keys for hardware-backed biometric step-up.
 * Private keys never leave the device's secure hardware and require a live `BiometricPrompt` CryptoObject scan
 * before signing a single-use server challenge.
 */
import crypto from 'node:crypto';
import { all, one, run, type Store } from './db.ts';
import { httpError } from './errors.ts';
import { userKey } from './users.ts';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_KEYS_PER_USER = 10;

export interface BiometricKeyInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface BiometricKeyRow {
  id: string;
  username: string;
  public_key_spki: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** Validates a base64-encoded SPKI DER ECDSA P-256 (`prime256v1`) public key and returns a `crypto.KeyObject`. */
export function parseP256SpkiKey(publicKeySpkiBase64: unknown): { spkiBase64: string; keyObject: crypto.KeyObject } {
  const raw = String(publicKeySpkiBase64 ?? '').trim();
  if (!raw || raw.length > 512) throw httpError('Invalid biometric public key');
  let der: Buffer;
  try {
    der = Buffer.from(raw, 'base64');
    if (der.length < 40 || der.length > 256) throw new Error('length');
    const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (keyObject.asymmetricKeyType !== 'ec' || keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('curve');
    }
    return { spkiBase64: der.toString('base64'), keyObject };
  } catch {
    throw httpError('Biometric key must be a valid ECDSA P-256 SPKI public key');
  }
}

/** In-memory single-use challenge store (2-minute TTL) for hardware biometric step-up. */
export class BiometricChallenges {
  private readonly items = new Map<string, { username: string; keyId: string; expiresAt: number }>();

  issue(username: string, keyId: string, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const challenge = crypto.randomBytes(32).toString('base64url');
    this.items.set(challenge, { username: userKey(username), keyId, expiresAt: now + CHALLENGE_TTL_MS });
    return challenge;
  }

  consume(challenge: unknown, username: string, keyId: string, now = Date.now()): boolean {
    const c = String(challenge ?? '').trim();
    if (!c) return false;
    const entry = this.items.get(c);
    this.items.delete(c);
    if (!entry || entry.expiresAt <= now) return false;
    return entry.username === userKey(username) && entry.keyId === keyId;
  }
}

export async function registerBiometricKey(
  store: Store,
  username: string,
  params: { keyId?: unknown; publicKeySpki?: unknown; label?: unknown },
): Promise<BiometricKeyInfo> {
  const user = userKey(username);
  const { spkiBase64 } = parseP256SpkiKey(params.publicKeySpki);
  const keyId = String(params.keyId ?? '').trim() || crypto.randomUUID();
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(keyId)) throw httpError('Invalid biometric key ID');
  const label = String(params.label ?? 'Android').trim().slice(0, 80) || 'Android';
  const existing = await one<BiometricKeyRow>(store, 'SELECT * FROM biometric_keys WHERE id = $1', [keyId]);
  if (existing && existing.username !== user) throw httpError('Biometric key ID conflict', 409);
  if (!existing) {
    const countRow = await one<{ c: string }>(store, 'SELECT COUNT(*)::text AS c FROM biometric_keys WHERE username = $1', [user]);
    if (Number(countRow?.c || 0) >= MAX_KEYS_PER_USER) {
      await run(store, `DELETE FROM biometric_keys WHERE id IN (
        SELECT id FROM biometric_keys WHERE username = $1 ORDER BY COALESCE(last_used_at, created_at) ASC LIMIT 1
      )`, [user]);
    }
  }
  const now = new Date().toISOString();
  await run(store, `
    INSERT INTO biometric_keys (id, username, public_key_spki, label, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET public_key_spki = excluded.public_key_spki, label = excluded.label
  `, [keyId, user, spkiBase64, label, now]);
  return { id: keyId, label, createdAt: existing?.created_at || now, lastUsedAt: existing?.last_used_at || null };
}

export async function listBiometricKeys(store: Store, username: string): Promise<BiometricKeyInfo[]> {
  const rows = await all<BiometricKeyRow>(
    store,
    'SELECT id, label, created_at, last_used_at FROM biometric_keys WHERE username = $1 ORDER BY created_at DESC',
    [userKey(username)],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function deleteBiometricKey(store: Store, username: string, keyId: string): Promise<boolean> {
  return (await run(store, 'DELETE FROM biometric_keys WHERE username = $1 AND id = $2', [userKey(username), keyId])) > 0;
}

export async function issueBiometricChallenge(
  store: Store,
  challenges: BiometricChallenges,
  username: string,
  keyId: unknown,
): Promise<{ challenge: string; keyId: string }> {
  const id = String(keyId ?? '').trim();
  if (!id) throw httpError('Biometric key ID is required');
  const row = await one<BiometricKeyRow>(
    store,
    'SELECT id, username FROM biometric_keys WHERE id = $1 AND username = $2',
    [id, userKey(username)],
  );
  if (!row) throw httpError('Biometric key not registered for this account', 404);
  return { challenge: challenges.issue(username, id), keyId: id };
}

export async function verifyBiometricStepUp(
  store: Store,
  challenges: BiometricChallenges,
  username: string,
  params: { keyId?: unknown; challenge?: unknown; signature?: unknown },
): Promise<void> {
  const id = String(params.keyId ?? '').trim();
  const challenge = String(params.challenge ?? '').trim();
  const sigB64 = String(params.signature ?? '').trim();
  if (!id || !challenge || !sigB64) throw httpError('Missing biometric signature fields');
  if (!challenges.consume(challenge, username, id)) {
    throw httpError('Biometric challenge expired or invalid. Try again.', 403);
  }
  const row = await one<BiometricKeyRow>(
    store,
    'SELECT * FROM biometric_keys WHERE id = $1 AND username = $2',
    [id, userKey(username)],
  );
  if (!row) throw httpError('Biometric key not registered for this account', 403);
  const { keyObject } = parseP256SpkiKey(row.public_key_spki);
  const sigBuf = Buffer.from(sigB64, 'base64');
  const verified = sigBuf.length > 0 && crypto.verify('sha256', Buffer.from(challenge, 'utf8'), keyObject, sigBuf);
  if (!verified) throw httpError('Biometric signature verification failed', 403);
  await run(store, 'UPDATE biometric_keys SET last_used_at = $2 WHERE id = $1', [id, new Date().toISOString()]);
}
