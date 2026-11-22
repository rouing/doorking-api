/**
 * @module src/sso
 *
 * Single sign-on with OpenID Connect providers (Entra ID, Google Workspace, Okta, …; config.json sso.providers). A
 * provider identity (provider id + the provider's permanent subject) is linked to a local account (user_identities);
 * the app keeps deciding what each account may do (gate roles). A sign-in attempt is kept in memory for 10 minutes and
 * tied to the browser that started it (a cookie holds its binding); it uses state, nonce and PKCE, and openid-client
 * checks the ID token (issuer, audience, expiry, nonce).
 *
 * Session age: with maxAgeHours, the authentication at the provider (the ID token's auth_time) must be at most that
 * old; linking from User Settings always needs a fresh one (made after the attempt started). Providers are asked with
 * max_age; Entra with prompt=login for a fresh one (its max_age handling isn't dependable; its own limit is a
 * Conditional Access sign-in frequency). auth_time is checked here either way, and a missing one is refused.
 *
 * Which account an identity signs in to: the one it is linked to; else, only for providers with allowedDomains and a
 * trusted email from one of them (see trustedEmail), the invited account waiting on that email (the invitation is
 * accepted), else the account with that confirmed email (linked), else a new account when autoCreate is on. Anyone
 * else is told to ask a gate admin for an invitation. Linking from User Settings and accepting an invitation link
 * with a provider work for any provider.
 */
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import type { SsoProvider } from './config.ts';
import { all, one, run, transaction, type Store } from './db.ts';
import { peekToken, useToken } from './email.ts';
import { acceptInviteWithSso, createSsoUser, getUser, recordSignIn, userKey } from './users.ts';
import { httpError } from './errors.ts';

export type SsoMode = 'signin' | 'link' | 'invite';
/**
 * email: '' when the provider gave none; emailVerified: null when it didn't say; hd: Google Workspace domain ('' none).
 */
export interface SsoClaims { subject: string; email: string; emailVerified: boolean | null; name: string; hd: string }
export interface SsoResult { mode: SsoMode; username?: string; inviteToken?: string; identity: SsoClaims }
export interface SsoIdentity { provider: string; providerName: string; subject: string; email: string; linkedAt: string; lastUsedAt: string | null }
export type SsoOutcome = 'signed-in' | 'linked' | 'created' | 'invite-accepted';

const FLOW_MS = 10 * 60000;
const SKEW_MS = 2 * 60000;
const MAX_FLOWS = 500;

const CONFIG_MS = 24 * 3600000; // a provider's discovered configuration is fetched again after this

interface Flow { provider: string; nonce: string; verifier: string; binding: string; redirectUri: string; mode: SsoMode; username?: string; inviteToken?: string; at: number }

/**
 * The sign-ins in progress (by state) and the providers' discovered configurations; each server keeps its own.
 */
export class SsoFlows {
  readonly flows = new Map<string, Flow>();
  readonly configs = new Map<string, { config: Promise<oidc.Configuration>; at: number }>();
}

const isGoogle = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'accounts.google.com';
const isEntra = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'login.microsoftonline.com';
/**
 * Authorization parameters that make the provider ask for a fresh sign-in: always when linking (Entra ID has no
 * max_age=0, so prompt=login), else after the provider's maxAgeHours.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param mode - Operation or layout mode.
 * @returns `Record<string, string>` result.
 */
function freshSignIn(provider: SsoProvider, mode: SsoMode): Record<string, string> {
  if (mode === 'link') return isEntra(provider) ? { prompt: 'login' } : { max_age: '0' };
  if (provider.maxAgeHours && !isEntra(provider)) return { max_age: String(provider.maxAgeHours * 3600) };
  return {};
}

/**
 * The provider's OpenID configuration, discovered once a day (a failed discovery is tried again next time). Plain
 * http is allowed for localhost issuers only (config.ts refuses others).
 *
 * @param sso - Per-server SSO flow and discovery cache.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `oidc.Configuration`.
 */
function configOf(sso: SsoFlows, provider: SsoProvider, now = Date.now()): Promise<oidc.Configuration> {
  const key = `${provider.id}|${provider.issuer}|${provider.clientId}|${provider.clientSecret}`;
  const cached = sso.configs.get(key);
  if (cached && now - cached.at < CONFIG_MS) return cached.config;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(provider.issuer);
  const config = oidc.discovery(new URL(provider.issuer), provider.clientId, undefined, provider.clientSecret ? oidc.ClientSecretPost(provider.clientSecret) : oidc.None(),
    local ? { execute: [oidc.allowInsecureRequests] } : undefined);
  config.catch(() => { if (sso.configs.get(key)?.config === config) sso.configs.delete(key); });
  sso.configs.set(key, { config, at: now });
  return config;
}

/**
 * Checks that the provider can be reached and returns its endpoints (for the CLI's sso-check).
 * authTime: whether the discovery document lists auth_time among its claims (null when it lists none).
 *
 * @param sso - Per-server SSO flow and discovery cache.
 * @param provider - Configured OpenID Connect SSO provider.
 * @returns Promise resolving to `{ issuer: string; authorization: string; token: string; authTime: boolean | null }`.
 */
export async function discoverProvider(sso: SsoFlows, provider: SsoProvider): Promise<{ issuer: string; authorization: string; token: string; authTime: boolean | null }> {
  const metadata = (await configOf(sso, provider)).serverMetadata();
  const claims = Array.isArray(metadata.claims_supported) ? metadata.claims_supported : null;
  return { issuer: metadata.issuer, authorization: String(metadata.authorization_endpoint || ''), token: String(metadata.token_endpoint || ''),
    authTime: claims ? claims.includes('auth_time') : null };
}

/**
 * Starts a sign-in: returns the provider's URL to send the browser to, and the binding the browser must keep (a
 * cookie) for the callback. redirectUri: <public address>/api/sso/<id>/callback, registered at the provider. mode:
 * signin, link (username: the signed-in account) or invite (inviteToken: the invitation link's token).
 *
 * @param sso - Per-server SSO flow and discovery cache.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param options - Options object.
 * @param options.mode - Flow mode (`signin`, `link`, or `invite`).
 * @param options.redirectUri - <public address>/api/sso/<id>/callback, registered at the provider.
 * @param options.username - The signed-in account.
 * @param options.inviteToken - The invitation link's token.
 * @param [options.now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `{ url: string; binding: string }`.
 * @throws HTTP 429 error on invalid input or conflict.
 */
export async function startSso(sso: SsoFlows, provider: SsoProvider, { mode, redirectUri, username, inviteToken, now = Date.now() }:
  { mode: SsoMode; redirectUri: string; username?: string; inviteToken?: string; now?: number }): Promise<{ url: string; binding: string }> {
  const config = await configOf(sso, provider, now);
  const { flows } = sso;
  for (const [k, flow] of flows) if (now - flow.at > FLOW_MS) flows.delete(k);
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

/**
 * The identity in checked ID token claims. The email is the email claim, else (Entra) preferred_username when it is
 * an address.
 *
 * @param claims - Verified ID token claims.
 * @returns `SsoClaims` result.
 */
export function claimsOf(claims: Record<string, unknown>): SsoClaims {
  const address = (value: unknown) => (typeof value === 'string' && value.includes('@') ? value : '');
  const email = address(claims.email) || address(claims.preferred_username);
  const v = claims.email_verified;
  return {
    subject: String(claims.sub ?? ''), email: userKey(email),
    emailVerified: !address(claims.email) || v === undefined ? null : v === true || v === 'true',
    name: typeof claims.name === 'string' ? claims.name : '', hd: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '',
  };
}

/**
 * Checks the session age (see the top): link needs an authentication made after the attempt started; otherwise
 * maxAgeHours, when set, bounds it. A small clock skew is allowed.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param authTime - `unknown` value.
 * @param flow - `Flow` value.
 * @param now - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @throws HTTP 400 error on invalid input or conflict.
 */
function checkAuthTime(provider: SsoProvider, authTime: unknown, flow: Flow, now: number): void {
  if (flow.mode !== 'link' && !provider.maxAgeHours) return;
  if (typeof authTime !== 'number') {
    throw httpError(`${provider.name} didn't say when you signed in (auth_time), which this server requires.${isEntra(provider)
      ? ' An administrator must add the auth_time optional claim to the ID token in the Entra app registration.' : ''}`);
  }
  const ms = authTime * 1000;
  if (flow.mode === 'link' && ms < flow.at - SKEW_MS) throw httpError(`Sign in to ${provider.name} again to link it: linking needs a fresh sign-in. Try again.`);
  if (flow.mode !== 'link' && ms < now - provider.maxAgeHours * 3600000 - SKEW_MS) {
    throw httpError(`Your ${provider.name} sign-in is more than ${provider.maxAgeHours} hours old. Sign out of ${provider.name}, then sign in again.`);
  }
}

/**
 * Finishes a sign-in from the provider's answer (query: the callback's query string; binding: from the browser's
 * cookie). The attempt must exist, be unexpired, belong to this provider and browser, and is used up either way; the
 * code is exchanged with the PKCE verifier and the ID token checked against the nonce.
 *
 * @param sso - Per-server SSO flow and discovery cache.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param query - The callback's query string.
 * @param binding - From the browser's cookie.
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `SsoResult`.
 * @throws HTTP 200/400 error on invalid input or conflict.
 */
export async function finishSso(sso: SsoFlows, provider: SsoProvider, query: URLSearchParams, binding: string, now = Date.now()): Promise<SsoResult> {
  const state = query.get('state') || '';
  const flow = sso.flows.get(state);
  if (flow) sso.flows.delete(state);
  const error = query.get('error');
  if (error) throw httpError(`${provider.name} didn't sign you in: ${(query.get('error_description') || error).slice(0, 200)}`);
  if (!flow || flow.provider !== provider.id || now - flow.at > FLOW_MS) throw httpError('This sign-in has expired or was already used. Try again.');
  if (!binding || !sameText(binding, flow.binding)) throw httpError('This sign-in was started in another browser or tab. Try again.');
  const url = new URL(flow.redirectUri);
  url.search = query.toString();
  const tokens = await oidc.authorizationCodeGrant(await configOf(sso, provider, now), url,
    { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || !claims.sub) throw httpError(`${provider.name} didn't say who you are`);
  checkAuthTime(provider, claims.auth_time, flow, now);
  return { mode: flow.mode, username: flow.username, inviteToken: flow.inviteToken, identity: claimsOf(claims as Record<string, unknown>) };
}

/**
 * The identity's email when it can be matched to accounts for this provider: not marked unverified and, when the
 * provider has allowedDomains, from one of them (Google: also its Workspace domain, so a personal Google account made
 * with a work address doesn't count). '' when it can't.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param id - Unique record identifier.
 * @returns `string` result.
 */
export function trustedEmail(provider: SsoProvider, id: SsoClaims): string {
  if (!id.email || id.emailVerified === false) return '';
  if (!provider.allowedDomains.length) return id.email;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return '';
  if (isGoogle(provider) && !provider.allowedDomains.includes(id.hd)) return '';
  return id.email;
}

/**
 * Why an identity's email can't be matched to accounts (trustedEmail gave ''), for the person signing in.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param id - Unique record identifier.
 * @returns `string` result.
 */
function untrustedReason(provider: SsoProvider, id: SsoClaims): string {
  const ask = `Ask a gate admin to invite you, then accept the invitation with ${provider.name}; or sign in another way and link it in User Settings.`;
  if (!id.email) return `${provider.name} didn't give an email address, and this ${provider.name} account isn't linked to an account here. ${ask}`;
  if (id.emailVerified === false) return `${provider.name} says ${id.email} isn't verified, so it can't be matched to an account here. ${ask}`;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return `${id.email} can't sign in here: only accounts from ${provider.allowedDomains.join(', ')} can.`;
  return `${id.email} isn't a ${provider.allowedDomains.join(' or ')} Google Workspace account. Sign in with your Workspace account.`;
}

/**
 * The account an identity is linked to, or null.
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param subject - Provider subject identifier (`sub` claim).
 * @returns Promise resolving to `string | null`.
 */
async function linkedUser(store: Store, provider: string, subject: string): Promise<string | null> {
  const row = await one<{ username: string }>(store, 'SELECT username FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
  return row ? row.username : null;
}

/**
 * Links an identity to an account (409 when it belongs to another one).
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param username - Local account username.
 * @param id - Unique record identifier.
 * @throws HTTP 409 error on invalid input or conflict.
 */
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

/**
 * Linking a provider account to the signed-in account (from User Settings).
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param result - Verified operation result.
 * @returns Promise resolving to `{ username: string; outcome: SsoOutcome }`.
 * @throws HTTP 400 error on invalid input or conflict.
 */
async function completeLink(store: Store, provider: SsoProvider, result: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const name = userKey(result.username);
  if (!name || !await getUser(store, name)) throw httpError('Sign in again, then link the account from User Settings', 401);
  checkTrusted(provider, result.identity);
  await link(store, provider, name, result.identity);
  return { username: name, outcome: 'linked' };
}

/**
 * Accepting an invitation link with the provider: the invited account gets the provider account linked.
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param result - Verified operation result.
 * @param touch - `(username: string) => Promise<unknown>` value.
 * @returns Promise resolving to `{ username: string; outcome: SsoOutcome }`.
 * @throws HTTP 400/409 error on invalid input or conflict.
 */
async function completeInvite(store: Store, provider: SsoProvider, result: SsoResult, touch: (username: string) => Promise<unknown>):
  Promise<{ username: string; outcome: SsoOutcome }> {
  const id = result.identity;
  const invalid = 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.';
  const token = await peekToken(store, 'invite', result.inviteToken);
  if (!token) throw httpError(invalid);
  const user = await getUser(store, token.username);
  if (!user || !user.invited) throw httpError('This invitation was already used. Sign in instead.', 409);
  checkTrusted(provider, id);
  if (await linkedUser(store, provider.id, id.subject)) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
  // One transaction: if linking fails, the invitation stays unused (the account would otherwise be left with no way in).
  await transaction(store, async (tx) => {
    if (!await useToken(tx, 'invite', result.inviteToken)) throw httpError(invalid);
    await acceptInviteWithSso(tx, user.username);
    await link(tx, provider, user.username, id);
  });
  await touch(user.username);
  return { username: user.username, outcome: 'invite-accepted' };
}

/**
 * What a finished sign-in means for the accounts (see the module comment). Sign-ins and accepted invitations are
 * recorded as sign-ins. Returns the account and what happened; throws (403/409) with a message for the user.
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param result - Verified operation result.
 * @returns Promise resolving to `{ username: string; outcome: SsoOutcome }`.
 * @throws HTTP 400/403 error on invalid input or conflict.
 */
export async function completeSso(store: Store, provider: SsoProvider, result: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const id = result.identity;
  const touch = (username: string) => run(store, 'UPDATE user_identities SET last_used_at = $3, email = $4 WHERE provider = $1 AND subject = $2',
    [provider.id, id.subject, new Date().toISOString(), id.email || '']).then(() => recordSignIn(store, username));
  if (result.mode === 'link') return completeLink(store, provider, result);
  if (result.mode === 'invite') return completeInvite(store, provider, result, touch);
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
    await transaction(store, async (tx) => {
      await acceptInviteWithSso(tx, invited.username);
      await link(tx, provider, invited.username, id);
    });
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
    const user = await transaction(store, async (tx) => {
      const created = await createSsoUser(tx, { email, createdBy: `sso:${provider.id}` });
      await link(tx, provider, created.username, id);
      return created;
    });
    await touch(user.username);
    return { username: user.username, outcome: 'created' };
  }
  throw httpError(`There is no account for ${email} here. Ask a gate admin to invite you.`, 403);
}

/**
 * The account's linked identities (providerName: the configured name, or the id when the provider was removed).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `SsoIdentity[]`.
 */
export async function listIdentities(store: Store, username: string, providers: SsoProvider[]): Promise<SsoIdentity[]> {
  return (await all<{ provider: string; subject: string; email: string; linked_at: string; last_used_at: string | null }>(store,
    'SELECT provider, subject, email, linked_at, last_used_at FROM user_identities WHERE username = $1 ORDER BY linked_at', [userKey(username)]))
    .map((row) => ({ provider: row.provider, providerName: providers.find((provider) => provider.id === row.provider)?.name || row.provider, subject: row.subject,
      email: row.email, linkedAt: row.linked_at, lastUsedAt: row.last_used_at }));
}

/**
 * False when the account is linked to a provider set to passwords: false (it must sign in with that provider).
 * Whether the account keeps a way to sign in once passkey `passkeyId` is removed: another passkey, a linked provider
 * that is configured, or a password (a provider that turns passwords off is linked, so that counts already).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param passkeyId - `string` value.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function signInLeftWithoutPasskey(store: Store, username: string, passkeyId: string, providers: SsoProvider[]): Promise<boolean> {
  const name = userKey(username);
  if (await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1 AND id <> $2', [name, String(passkeyId)])) return true;
  const linked = await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [name]);
  if (linked.some((row) => providers.some((provider) => provider.id === row.provider))) return true;
  return Boolean((await getUser(store, name))?.hasPassword);
}

/**
 * The providers that keep the account from using a password (their names), [] when none.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `string[]`.
 */
export async function passwordBlockers(store: Store, username: string, providers: SsoProvider[]): Promise<string[]> {
  const ids = new Set((await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [userKey(username)])).map((row) => row.provider));
  return providers.filter((provider) => !provider.passwords && ids.has(provider.id)).map((provider) => provider.name);
}

/**
 * Unlinks one identity; refused (409) when the account would be left with no way to sign in: another identity of a
 * configured provider, a passkey, or a usable password (one it has and may still use).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param options - Options object.
 * @param options.provider - Configured OpenID Connect SSO provider.
 * @param options.subject - Provider subject identifier (`sub` claim).
 * @param providers - List of configured OpenID Connect SSO providers.
 * @throws HTTP 400/404 error on invalid input or conflict.
 */
export async function unlinkIdentity(store: Store, username: string, { provider, subject }: { provider: unknown; subject: unknown }, providers: SsoProvider[]): Promise<void> {
  const name = userKey(username);
  const rest = (await all<{ provider: string; subject: string }>(store, 'SELECT provider, subject FROM user_identities WHERE username = $1', [name]));
  if (!rest.some((row) => row.provider === provider && row.subject === subject)) throw httpError('That sign-in is not linked to your account', 404);
  const others = rest.filter((row) => !(row.provider === provider && row.subject === subject));
  const user = (await getUser(store, name))!;
  const passwordsOff = new Set(providers.filter((configured) => !configured.passwords).map((configured) => configured.id));
  const canPassword = user.hasPassword && !others.some((other) => passwordsOff.has(other.provider));
  const passkeys = await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1', [name]);
  if (!canPassword && !passkeys && !others.some((other) => providers.some((configured) => configured.id === other.provider))) {
    throw httpError('This is your only way to sign in. Add a passkey, set a password or link another account first.', 409);
  }
  await run(store, 'DELETE FROM user_identities WHERE username = $1 AND provider = $2 AND subject = $3', [name, provider, subject]);
}
