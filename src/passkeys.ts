// Passkeys (WebAuthn) as another way to sign in, through @simplewebauthn/server. Table passkeys (see db.ts) keeps
// each credential's id, public key and signature counter; nothing in it is secret. Passkeys belong to the site name
// they were made on (the relying party id): the public HTTPS name, or "localhost" when the page is opened on the
// server itself. Challenges live in memory for 5 minutes and are used once.
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { all, one, run, type Store } from './db.ts';
import { userKey } from './users.ts';
import type { PasskeyInfo } from './types.ts';
import { httpError } from './errors.ts';

export type { PasskeyInfo };
// rpID: the site name passkeys are tied to; origin: the page's origin (https://<name>, or http://localhost:<port>).
export interface RelyingParty { rpID: string; origin: string }

const RP_NAME = 'DoorKing Gate Manager';
const CHALLENGE_MS = 5 * 60000;
const MAX_CHALLENGES = 1000;
const NAME_MAX = 40;

interface PasskeyRow {
  id: string; username: string; rp_id: string; public_key: Buffer; counter: number; transports: string[] | null; name: string;
  device_type: string; backed_up: boolean; created_at: string; last_used_at: string | null;
}

const fromRow = (r: PasskeyRow): PasskeyInfo => ({
  id: r.id, name: r.name, site: r.rp_id, synced: r.device_type === 'multiDevice' && r.backed_up, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

// challenge -> { expires, purpose, username (registration, confirmation; null for sign-in), rpID }
type Purpose = 'register' | 'signin' | 'confirm';
const challenges = new Map<string, { expires: number; purpose: Purpose; username: string | null; rpID: string }>();
function remember(challenge: string, purpose: Purpose, username: string | null, rpID: string): void {
  const now = Date.now();
  for (const [c, v] of challenges) if (v.expires < now) challenges.delete(c);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  challenges.set(challenge, { expires: now + CHALLENGE_MS, purpose, username, rpID });
}
// True (and forgets it) when the challenge was issued for this purpose, user and site, and hasn't expired.
function takeChallenge(challenge: string, purpose: Purpose, username: string | null, rpID: string): boolean {
  const c = challenges.get(challenge);
  challenges.delete(challenge);
  return Boolean(c && c.expires >= Date.now() && c.purpose === purpose && c.username === username && c.rpID === rpID);
}

// The user's WebAuthn user handle (random, so the username isn't stored on the authenticator), created when missing.
async function userHandle(store: Store, username: string): Promise<Uint8Array> {
  const r = await one<{ webauthn_id: string | null }>(store, 'SELECT webauthn_id FROM users WHERE username = $1', [username]);
  if (!r) throw httpError(`No user "${username}"`, 404);
  if (r.webauthn_id) return new Uint8Array(Buffer.from(r.webauthn_id, 'base64url'));
  const id = crypto.randomBytes(32);
  await run(store, 'UPDATE users SET webauthn_id = $2 WHERE username = $1 AND webauthn_id IS NULL', [username, id.toString('base64url')]);
  return userHandle(store, username);
}

export async function listPasskeys(store: Store, username: unknown): Promise<PasskeyInfo[]> {
  return (await all<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE username = $1 ORDER BY created_at',
    [userKey(username)])).map(fromRow);
}

// Options for adding a passkey to the user's account (the caller has checked their password).
export async function registrationOptions(store: Store, username: unknown, relyingParty: RelyingParty) {
  const name = userKey(username);
  const existing = await all<{ id: string; transports: string[] | null }>(store, 'SELECT id, transports FROM passkeys WHERE username = $1 AND rp_id = $2',
    [name, relyingParty.rpID]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: relyingParty.rpID, userName: name, userID: await userHandle(store, name) as never, attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports || undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(options.challenge, 'register', name, relyingParty.rpID);
  return options;
}

// Checks the browser's answer to registrationOptions and saves the passkey under `label`.
export async function addPasskey(store: Store, username: unknown, response: unknown, label: unknown, relyingParty: RelyingParty): Promise<PasskeyInfo> {
  const name = userKey(username);
  const title = String(label ?? '').trim() || 'Passkey';
  if (title.length > NAME_MAX) throw httpError(`The passkey name must be at most ${NAME_MAX} characters`);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: (c) => takeChallenge(c, 'register', name, relyingParty.rpID),
      expectedOrigin: relyingParty.origin, expectedRPID: relyingParty.rpID, requireUserVerification: true,
    });
  } catch (err) { throw httpError(`The passkey could not be added: ${(err as Error).message}`); }
  if (!v.verified) throw httpError('The passkey could not be added');
  const { credential: cred, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const added = await run(store, `INSERT INTO passkeys (id, username, rp_id, public_key, counter, transports, name, device_type, backed_up, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
  [cred.id, name, relyingParty.rpID, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []), title, credentialDeviceType,
    credentialBackedUp, new Date().toISOString()]);
  if (!added) throw httpError('This passkey is already registered', 409);
  return fromRow((await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1', [cred.id]))!);
}

// Options for signing in with any passkey made for this site (discoverable passkeys: no username needed).
export async function authenticationOptions(relyingParty: RelyingParty) {
  const options = await generateAuthenticationOptions({ rpID: relyingParty.rpID, userVerification: 'required' });
  remember(options.challenge, 'signin', null, relyingParty.rpID);
  return options;
}

// Options for the signed-in user to confirm it's them with one of their passkeys for this site (step-up). 409 when
// they have none here.
export async function confirmationOptions(store: Store, username: unknown, relyingParty: RelyingParty) {
  const name = userKey(username);
  const mine = await all<{ id: string; transports: string[] | null }>(store, 'SELECT id, transports FROM passkeys WHERE username = $1 AND rp_id = $2',
    [name, relyingParty.rpID]);
  if (!mine.length) throw httpError(`You have no passkey for ${relyingParty.rpID}. Add one in User Settings.`, 409);
  const options = await generateAuthenticationOptions({ rpID: relyingParty.rpID, userVerification: 'required',
    allowCredentials: mine.map((c) => ({ id: c.id, transports: (c.transports || undefined) as never })) });
  remember(options.challenge, 'confirm', name, relyingParty.rpID);
  return options;
}

// Checks a passkey answer to authenticationOptions; returns the passkey's username. Throws 401 on anything wrong
// (unknown passkey, bad signature, expired challenge, counter gone backwards: a possible copy of the key).
async function checkPasskey(store: Store, response: unknown, relyingParty: RelyingParty, username: string | null, refused: (why: string) => Error): Promise<string> {
  const res = response as AuthenticationResponseJSON;
  const row = res && typeof res.id === 'string'
    ? await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1 AND rp_id = $2', [res.id, relyingParty.rpID]) : undefined;
  if (!row) throw refused('this passkey is not registered here (it may have been removed)');
  if (username !== null && row.username !== username) throw refused('this passkey belongs to another account');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: res, expectedChallenge: (c) => takeChallenge(c, username === null ? 'signin' : 'confirm', username, relyingParty.rpID),
      expectedOrigin: relyingParty.origin, expectedRPID: relyingParty.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports || undefined },
      requireUserVerification: true,
    });
  } catch (err) { throw refused((err as Error).message); }
  if (!v.verified) throw refused('the signature did not match');
  await run(store, 'UPDATE passkeys SET counter = $2, last_used_at = $3, backed_up = $4 WHERE id = $1',
    [row.id, v.authenticationInfo.newCounter, new Date().toISOString(), v.authenticationInfo.credentialBackedUp]);
  return row.username;
}

// Checks a passkey sign-in; returns the username.
export function signInWithPasskey(store: Store, response: unknown, relyingParty: RelyingParty): Promise<string> {
  return checkPasskey(store, response, relyingParty, null, (why) => httpError(`Passkey sign-in failed: ${why}`, 401));
}

// Checks that the signed-in user confirmed with one of their own passkeys (step-up; see authenticationOptions).
export async function confirmWithPasskey(store: Store, username: unknown, response: unknown, relyingParty: RelyingParty): Promise<void> {
  await checkPasskey(store, response, relyingParty, userKey(username), (why) => httpError(`The passkey confirmation failed: ${why}`, 401));
}

export async function renamePasskey(store: Store, username: unknown, id: unknown, label: unknown): Promise<void> {
  const title = String(label ?? '').trim();
  if (!title || title.length > NAME_MAX) throw httpError(`Give the passkey a name of 1-${NAME_MAX} characters`);
  if (!await run(store, 'UPDATE passkeys SET name = $3 WHERE username = $1 AND id = $2', [userKey(username), String(id), title])) {
    throw httpError('Passkey not found', 404);
  }
}

export async function removePasskey(store: Store, username: unknown, id: unknown): Promise<string> {
  const r = await one<{ name: string }>(store, 'DELETE FROM passkeys WHERE username = $1 AND id = $2 RETURNING name', [userKey(username), String(id)]);
  if (!r) throw httpError('Passkey not found', 404);
  return r.name;
}
