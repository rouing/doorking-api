// Single sign-on with OpenID Connect providers (Entra ID, Google Workspace, Okta, …; config.json sso.providers). A
// provider identity (provider id + the provider's permanent subject) is linked to a local account (user_identities);
// the app keeps deciding what each account may do (gate roles). A sign-in attempt is kept in memory for 10 minutes and
// tied to the browser that started it (a cookie holds its binding); it uses state, nonce and PKCE, and openid-client
// checks the ID token (issuer, audience, expiry, nonce).
//
// Session age: with maxAgeHours, the authentication at the provider (the ID token's auth_time) must be at most that
// old; linking from User Settings always needs a fresh one (made after the attempt started). Providers are asked with
// max_age; Entra with prompt=login for a fresh one (its max_age handling isn't dependable; its own limit is a
// Conditional Access sign-in frequency). auth_time is checked here either way, and a missing one is refused.
//
// Which account an identity signs in to: the one it is linked to; else, only for providers with allowedDomains and a
// trusted email from one of them (see trustedEmail), the invited account waiting on that email (the invitation is
// accepted), else the account with that confirmed email (linked), else a new account when autoCreate is on. Anyone
// else is told to ask a gate admin for an invitation. Linking from User Settings and accepting an invitation link
// with a provider work for any provider.
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import type { SsoProvider } from './config.ts';
import { all, one, run, type Store } from './db.ts';
import { useToken } from './email.ts';
import { acceptInviteWithSso, createSsoUser, getUser, recordSignIn, userKey } from './users.ts';
import { httpError } from './errors.ts';

export type SsoMode = 'signin' | 'link' | 'invite';
// email: '' when the provider gave none; emailVerified: null when it didn't say; hd: Google Workspace domain ('' none).
export interface SsoClaims { subject: string; email: string; emailVerified: boolean | null; name: string; hd: string }
export interface SsoResult { mode: SsoMode; username?: string; inviteToken?: string; identity: SsoClaims }
export interface SsoIdentity { provider: string; providerName: string; subject: string; email: string; linkedAt: string; lastUsedAt: string | null }
export type SsoOutcome = 'signed-in' | 'linked' | 'created' | 'invite-accepted';

const FLOW_MS = 10 * 60000;
const SKEW_MS = 2 * 60000;
const MAX_FLOWS = 500;

interface Flow { provider: string; nonce: string; verifier: string; binding: string; redirectUri: string; mode: SsoMode; username?: string; inviteToken?: string; at: number }
const flows = new Map<string, Flow>(); // by state
const configs = new Map<string, Promise<oidc.Configuration>>();

const isGoogle = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'accounts.google.com';
const isEntra = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'login.microsoftonline.com';
// Authorization parameters that make the provider ask for a fresh sign-in: always when linking (Entra ID has no
// max_age=0, so prompt=login), else after the provider's maxAgeHours.
function freshSignIn(provider: SsoProvider, mode: SsoMode): Record<string, string> {
  if (mode === 'link') return isEntra(provider) ? { prompt: 'login' } : { max_age: '0' };
  if (provider.maxAgeHours && !isEntra(provider)) return { max_age: String(provider.maxAgeHours * 3600) };
  return {};
}

// The provider's OpenID configuration, discovered once (a failed discovery is tried again next time). Plain http is
// allowed for localhost issuers only (config.ts refuses others).
function configOf(provider: SsoProvider): Promise<oidc.Configuration> {
  const key = `${provider.id}|${provider.issuer}|${provider.clientId}|${provider.clientSecret}`;
  let c = configs.get(key);
  if (!c) {
    const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(provider.issuer);
    c = oidc.discovery(new URL(provider.issuer), provider.clientId, undefined, provider.clientSecret ? oidc.ClientSecretPost(provider.clientSecret) : oidc.None(),
      local ? { execute: [oidc.allowInsecureRequests] } : undefined);
    c.catch(() => configs.delete(key));
    configs.set(key, c);
  }
  return c;
}

// Checks that the provider can be reached and returns its endpoints (for the CLI's sso-check).
// authTime: whether the discovery document lists auth_time among its claims (null when it lists none).
export async function discoverProvider(provider: SsoProvider): Promise<{ issuer: string; authorization: string; token: string; authTime: boolean | null }> {
  const m = (await configOf(provider)).serverMetadata();
  const claims = Array.isArray(m.claims_supported) ? m.claims_supported : null;
  return { issuer: m.issuer, authorization: String(m.authorization_endpoint || ''), token: String(m.token_endpoint || ''),
    authTime: claims ? claims.includes('auth_time') : null };
}

// Starts a sign-in: returns the provider's URL to send the browser to, and the binding the browser must keep (a
// cookie) for the callback. redirectUri: <public address>/api/sso/<id>/callback, registered at the provider. mode:
// signin, link (username: the signed-in account) or invite (inviteToken: the invitation link's token).
export async function startSso(provider: SsoProvider, { mode, redirectUri, username, inviteToken, now = Date.now() }:
  { mode: SsoMode; redirectUri: string; username?: string; inviteToken?: string; now?: number }): Promise<{ url: string; binding: string }> {
  const config = await configOf(provider);
  for (const [k, f] of flows) if (now - f.at > FLOW_MS) flows.delete(k);
  if (flows.size >= MAX_FLOWS) throw httpError('Too many sign-ins are in progress. Try again in a few minutes.', 429);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const binding = crypto.randomBytes(32).toString('base64url');
  const params: Record<string, string> = {
    redirect_uri: redirectUri, scope: 'openid email profile', state, nonce, prompt: 'select_account',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  };
  if (isGoogle(provider) && provider.allowedDomains.length === 1) params.hd = provider.allowedDomains[0];
  Object.assign(params, freshSignIn(provider, mode));
  flows.set(state, { provider: provider.id, nonce, verifier, binding, redirectUri, mode, username, inviteToken, at: now });
  return { url: oidc.buildAuthorizationUrl(config, params).href, binding };
}

const sameText = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// The identity in checked ID token claims. The email is the email claim, else (Entra) preferred_username when it is
// an address.
export function claimsOf(c: Record<string, unknown>): SsoClaims {
  const address = (v: unknown) => (typeof v === 'string' && v.includes('@') ? v : '');
  const email = address(c.email) || address(c.preferred_username);
  const v = c.email_verified;
  return {
    subject: String(c.sub ?? ''), email: userKey(email),
    emailVerified: !address(c.email) || v === undefined ? null : v === true || v === 'true',
    name: typeof c.name === 'string' ? c.name : '', hd: typeof c.hd === 'string' ? c.hd.toLowerCase() : '',
  };
}

// Checks the session age (see the top): link needs an authentication made after the attempt started; otherwise
// maxAgeHours, when set, bounds it. A small clock skew is allowed.
function checkAuthTime(provider: SsoProvider, authTime: unknown, f: Flow, now: number): void {
  if (f.mode !== 'link' && !provider.maxAgeHours) return;
  if (typeof authTime !== 'number') {
    throw httpError(`${provider.name} didn't say when you signed in (auth_time), which this server requires.${isEntra(provider)
      ? ' An administrator must add the auth_time optional claim to the ID token in the Entra app registration.' : ''}`);
  }
  const ms = authTime * 1000;
  if (f.mode === 'link' && ms < f.at - SKEW_MS) throw httpError(`Sign in to ${provider.name} again to link it: linking needs a fresh sign-in. Try again.`);
  if (f.mode !== 'link' && ms < now - provider.maxAgeHours * 3600000 - SKEW_MS) {
    throw httpError(`Your ${provider.name} sign-in is more than ${provider.maxAgeHours} hours old. Sign out of ${provider.name}, then sign in again.`);
  }
}

// Finishes a sign-in from the provider's answer (query: the callback's query string; binding: from the browser's
// cookie). The attempt must exist, be unexpired, belong to this provider and browser, and is used up either way; the
// code is exchanged with the PKCE verifier and the ID token checked against the nonce.
export async function finishSso(provider: SsoProvider, query: URLSearchParams, binding: string, now = Date.now()): Promise<SsoResult> {
  const state = query.get('state') || '';
  const f = flows.get(state);
  if (f) flows.delete(state);
  const error = query.get('error');
  if (error) throw httpError(`${provider.name} didn't sign you in: ${(query.get('error_description') || error).slice(0, 200)}`);
  if (!f || f.provider !== provider.id || now - f.at > FLOW_MS) throw httpError('This sign-in has expired or was already used. Try again.');
  if (!binding || !sameText(binding, f.binding)) throw httpError('This sign-in was started in another browser or tab. Try again.');
  const url = new URL(f.redirectUri);
  url.search = query.toString();
  const tokens = await oidc.authorizationCodeGrant(await configOf(provider), url,
    { pkceCodeVerifier: f.verifier, expectedState: state, expectedNonce: f.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || !claims.sub) throw httpError(`${provider.name} didn't say who you are`);
  checkAuthTime(provider, claims.auth_time, f, now);
  return { mode: f.mode, username: f.username, inviteToken: f.inviteToken, identity: claimsOf(claims as Record<string, unknown>) };
}

// The identity's email when it can be matched to accounts for this provider: not marked unverified and, when the
// provider has allowedDomains, from one of them (Google: also its Workspace domain, so a personal Google account made
// with a work address doesn't count). '' when it can't.
export function trustedEmail(provider: SsoProvider, id: SsoClaims): string {
  if (!id.email || id.emailVerified === false) return '';
  if (!provider.allowedDomains.length) return id.email;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return '';
  if (isGoogle(provider) && !provider.allowedDomains.includes(id.hd)) return '';
  return id.email;
}

// Why an identity's email can't be matched to accounts (trustedEmail gave ''), for the person signing in.
function untrustedReason(provider: SsoProvider, id: SsoClaims): string {
  const ask = `Ask a gate admin to invite you, then accept the invitation with ${provider.name}; or sign in another way and link it in User Settings.`;
  if (!id.email) return `${provider.name} didn't give an email address, and this ${provider.name} account isn't linked to an account here. ${ask}`;
  if (id.emailVerified === false) return `${provider.name} says ${id.email} isn't verified, so it can't be matched to an account here. ${ask}`;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return `${id.email} can't sign in here: only accounts from ${provider.allowedDomains.join(', ')} can.`;
  return `${id.email} isn't a ${provider.allowedDomains.join(' or ')} Google Workspace account. Sign in with your Workspace account.`;
}

// The account an identity is linked to, or null.
async function linkedUser(store: Store, provider: string, subject: string): Promise<string | null> {
  const r = await one<{ username: string }>(store, 'SELECT username FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
  return r ? r.username : null;
}

// Links an identity to an account (409 when it belongs to another one).
async function link(store: Store, provider: SsoProvider, username: string, id: SsoClaims): Promise<void> {
  const owner = await linkedUser(store, provider.id, id.subject);
  if (owner && owner !== username) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
  if (owner) return;
  await run(store, `INSERT INTO user_identities (provider, subject, username, email, linked_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, subject) DO NOTHING`, [provider.id, id.subject, userKey(username), id.email, new Date().toISOString()]);
  if (await linkedUser(store, provider.id, id.subject) !== userKey(username)) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
}

const checkTrusted = (provider: SsoProvider, id: SsoClaims): void => {
  if (provider.allowedDomains.length && !trustedEmail(provider, id)) throw httpError(untrustedReason(provider, id), 403);
};

// Linking a provider account to the signed-in account (from User Settings).
async function completeLink(store: Store, provider: SsoProvider, r: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const name = userKey(r.username);
  if (!name || !await getUser(store, name)) throw httpError('Sign in again, then link the account from User Settings', 401);
  checkTrusted(provider, r.identity);
  await link(store, provider, name, r.identity);
  return { username: name, outcome: 'linked' };
}

// Accepting an invitation link with the provider: the invited account gets the provider account linked.
async function completeInvite(store: Store, provider: SsoProvider, r: SsoResult, touch: (username: string) => Promise<unknown>):
  Promise<{ username: string; outcome: SsoOutcome }> {
  const id = r.identity;
  const invalid = 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.';
  const token = await useToken(store, 'invite', r.inviteToken, { peek: true });
  if (!token) throw httpError(invalid);
  const user = await getUser(store, token.username);
  if (!user || !user.invited) throw httpError('This invitation was already used. Sign in instead.', 409);
  checkTrusted(provider, id);
  if (await linkedUser(store, provider.id, id.subject)) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
  if (!await useToken(store, 'invite', r.inviteToken)) throw httpError(invalid);
  await acceptInviteWithSso(store, user.username);
  await link(store, provider, user.username, id);
  await touch(user.username);
  return { username: user.username, outcome: 'invite-accepted' };
}

// What a finished sign-in means for the accounts (see the module comment). Sign-ins and accepted invitations are
// recorded as sign-ins. Returns the account and what happened; throws (403/409) with a message for the user.
export async function completeSso(store: Store, provider: SsoProvider, r: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const id = r.identity;
  const touch = (username: string) => run(store, 'UPDATE user_identities SET last_used_at = $3, email = $4 WHERE provider = $1 AND subject = $2',
    [provider.id, id.subject, new Date().toISOString(), id.email || '']).then(() => recordSignIn(store, username));
  if (r.mode === 'link') return completeLink(store, provider, r);
  if (r.mode === 'invite') return completeInvite(store, provider, r, touch);
  const linked = await linkedUser(store, provider.id, id.subject);
  if (linked) {
    await touch(linked);
    return { username: linked, outcome: 'signed-in' };
  }
  const email = trustedEmail(provider, id);
  if (!email || !provider.allowedDomains.length) {
    throw httpError(!email ? untrustedReason(provider, id) : `There is no account linked to this ${provider.name} account. Ask a gate admin to invite you, then accept the invitation with ${provider.name}; or sign in another way and link it in User Settings.`, 403);
  }
  const invited = await one<{ username: string }>(store, "SELECT username FROM users WHERE pending_email = $1 AND password_hash = '!'", [email]);
  if (invited) {
    await acceptInviteWithSso(store, invited.username);
    await link(store, provider, invited.username, id);
    await touch(invited.username);
    return { username: invited.username, outcome: 'invite-accepted' };
  }
  const owner = await one<{ username: string }>(store, 'SELECT username FROM users WHERE email = $1', [email]);
  if (owner) {
    await link(store, provider, owner.username, id);
    await touch(owner.username);
    return { username: owner.username, outcome: 'linked' };
  }
  if (provider.autoCreate) {
    const user = await createSsoUser(store, { email, createdBy: `sso:${provider.id}` });
    await link(store, provider, user.username, id);
    await touch(user.username);
    return { username: user.username, outcome: 'created' };
  }
  throw httpError(`There is no account for ${email} here. Ask a gate admin to invite you.`, 403);
}

// The account's linked identities (providerName: the configured name, or the id when the provider was removed).
export async function listIdentities(store: Store, username: unknown, providers: SsoProvider[]): Promise<SsoIdentity[]> {
  return (await all<{ provider: string; subject: string; email: string; linked_at: string; last_used_at: string | null }>(store,
    'SELECT provider, subject, email, linked_at, last_used_at FROM user_identities WHERE username = $1 ORDER BY linked_at', [userKey(username)]))
    .map((r) => ({ provider: r.provider, providerName: providers.find((provider) => provider.id === r.provider)?.name || r.provider, subject: r.subject,
      email: r.email, linkedAt: r.linked_at, lastUsedAt: r.last_used_at }));
}

// False when the account is linked to a provider set to passwords: false (it must sign in with that provider).
export async function passwordAllowed(store: Store, username: unknown, providers: SsoProvider[]): Promise<boolean> {
  const off = providers.filter((provider) => !provider.passwords).map((provider) => provider.id);
  if (!off.length) return true;
  return !await one(store, 'SELECT 1 AS x FROM user_identities WHERE username = $1 AND provider = ANY($2)', [userKey(username), off]);
}

// The providers that keep the account from using a password (their names), [] when none.
export async function passwordBlockers(store: Store, username: unknown, providers: SsoProvider[]): Promise<string[]> {
  const ids = new Set((await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [userKey(username)])).map((r) => r.provider));
  return providers.filter((provider) => !provider.passwords && ids.has(provider.id)).map((provider) => provider.name);
}

// Unlinks one identity; refused (409) when the account would be left with no way to sign in: another identity of a
// configured provider, a passkey, or a usable password (one it has and may still use).
export async function unlinkIdentity(store: Store, username: unknown, provider: unknown, subject: unknown, providers: SsoProvider[]): Promise<void> {
  const name = userKey(username);
  const rest = (await all<{ provider: string; subject: string }>(store, 'SELECT provider, subject FROM user_identities WHERE username = $1', [name]));
  if (!rest.some((r) => r.provider === provider && r.subject === subject)) throw httpError('That sign-in is not linked to your account', 404);
  const others = rest.filter((r) => !(r.provider === provider && r.subject === subject));
  const user = (await getUser(store, name))!;
  const passwordsOff = new Set(providers.filter((p) => !p.passwords).map((p) => p.id));
  const canPassword = user.hasPassword && !others.some((other) => passwordsOff.has(other.provider));
  const passkeys = await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1', [name]);
  if (!canPassword && !passkeys && !others.some((other) => providers.some((p) => p.id === other.provider))) {
    throw httpError('This is your only way to sign in. Add a passkey, set a password or link another account first.', 409);
  }
  await run(store, 'DELETE FROM user_identities WHERE username = $1 AND provider = $2 AND subject = $3', [name, provider, subject]);
}
