// Sign-in helpers: rate limits, sessions, step-up and re-confirmation, passkey relying party, single sign-on, allowed hosts.
import crypto from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import * as dk from '../index.ts';
import type { Reply, Session } from './context.ts';
import type { ContextModule } from './context.ts';
import { logger } from '../src/logging.ts';

export function createAuth(deps: ContextModule) {
  const { config, IDLE_MS, MAX_AGE_MS, MAX_FAILED_SIGN_INS, PORT, PUBLIC_HOST, SIGN_IN_WINDOW_MS, STEP_UP_MS, store } = deps;
  // Requests to public routes per key, within SIGN_IN_WINDOW_MS (pruned by sweepSessions): password resets per client
  // address and per account (so the form can't flood a mailbox, and one address can't use up everyone's resets), and
  // passkey and single sign-on starts per client address (so one address can't push out everyone's pending sign-ins).
  const requestTimes = new Map<string, number[]>();
  const RESET_PER_ACCOUNT = 3;
  const PER_ADDRESS = 30;
  const recentRequests = (key: string): number[] => (requestTimes.get(key) || []).filter((time) => Date.now() - time < SIGN_IN_WINDOW_MS);
  // Records a request; true when the key already had limit requests in the window (the request is refused).
  function overLimit(key: string, limit: number): boolean {
    const list = recentRequests(key);
    if (list.length >= limit) return true;
    requestTimes.set(key, [...list, Date.now()]);
    return false;
  }
  const clientIp = (req: IncomingMessage): string => dk.clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  // While no account exists, creating the first one needs this code, printed only to the server's console (journalctl),
  // so a stranger reaching a fresh public install can't claim it first.
  const setup = { code: '', running: false }; // the first-account setup code while no account exists; running: one being created
  // A new setup code (printed to the console by Application while no account exists).
  function newSetupCode(): string {
    setup.code = crypto.randomBytes(5).toString('hex');
    return setup.code;
  }
  const setupCodeMatches = (given: unknown): boolean => {
    const code = Buffer.from(String(given || '').trim().toLowerCase());
    return Boolean(setup.code) && code.length === Buffer.byteLength(setup.code) && crypto.timingSafeEqual(code, Buffer.from(setup.code));
  };
  const endSetup = () => { setup.code = ''; };
  // Runs the first-account setup one request at a time (null: one is already running).
  async function oneSetupAtATime<T>(fn: () => Promise<T>): Promise<T | null> {
    if (setup.running) return null;
    setup.running = true;
    try { return await fn(); } finally { setup.running = false; }
  }
  const approvals = new dk.PasskeyApprovals(); // codes from a signed-in device that let another device add a passkey
  const failedSignIns = new Map<string, number[]>(); // key (see signInKeys) -> times of recent failed password tries
  const recentFailures = (user: string): number[] => (failedSignIns.get(user) || []).filter((time) => Date.now() - time < SIGN_IN_WINDOW_MS);
  // Failed sign-in limits (dk.signInKeys); "me:<user>" counts the signed-in user's own password checks (confirmOwnPassword).
  const signInKeys = (user: string, ip: string) => dk.signInKeys(user, ip, MAX_FAILED_SIGN_INS);
  const blocked = (keys: [string, number][]) => keys.some(([k, limit]) => recentFailures(k).length >= limit);
  // Counts a password try as failed before it is checked, so tries sent at the same moment can't all pass the limit.
  // Returns a function that takes the try back (the password was right, or the check failed with an error).
  function countTry(keys: [string, number][]): () => void {
    const at = Date.now();
    for (const [k] of keys) failedSignIns.set(k, [...recentFailures(k), at]);
    return () => {
      for (const [k] of keys) {
        const list = failedSignIns.get(k) || [];
        const i = list.indexOf(at);
        if (i >= 0) list.splice(i, 1);
      }
    };
  }
  // Forgets the failed sign-ins of a user name from one address (after a sign-in that worked there).
  const clearFailedSignIn = (user: string, ip: string) => { failedSignIns.delete(`${user}|${ip}`); };
  // Forgets an account's failed sign-ins (after a password reset).
  function clearFailures(user: string): void {
    for (const k of [...failedSignIns.keys()]) if (k === user || k.startsWith(`${user}|`) || k === `me:${user}`) failedSignIns.delete(k);
  }
  // Ends idle sessions (they are kept in the database, so they survive a restart).
  async function sweepSessions() {
    try {
      for (const user of await dk.sweepSessions(store, IDLE_MS, MAX_AGE_MS)) logger('session').info`${user} signed out (idle or signed in too long ago)`;
    } catch (err) { logger('session').error`Session sweep failed: ${(err as Error).message}`; }
    for (const k of failedSignIns.keys()) if (!recentFailures(k).length) failedSignIns.delete(k);
    for (const k of requestTimes.keys()) if (!recentRequests(k).length) requestTimes.delete(k);
    approvals.sweep();
  }
  async function currentSession(req: IncomingMessage): Promise<Session | null> {
    const match = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (!match) return null;
    const found = await dk.findSession(store, match[1], IDLE_MS, MAX_AGE_MS);
    if (!found) return null;
    const user = await dk.getUser(store, found.username);
    if (!user) return null;
    // A linked provider that turns passwords off: the password can't be changed there, so it isn't asked for.
    let mustChangePassword = user.mustChangePassword;
    if (mustChangePassword && await passwordOff(user.username)) {
      await dk.clearMustChangePassword(store, user.username);
      mustChangePassword = false;
    }
    return { tokenHash: found.tokenHash, user: user.username, gate: found.gate, mustChangePassword, strongAt: found.strongAt, signedInAt: found.createdAt };
  }
  // Until when the session's passkey confirmation covers the sensitive actions (ms), or null.
  const strongUntil = (session: Session): number | null => (session.strongAt && session.strongAt + STEP_UP_MS > Date.now() ? session.strongAt + STEP_UP_MS : null);
  // The refusal of a sensitive action without a recent passkey confirmation (see STEP_UP).
  // extra: a sentence added to the error.
  async function stepUpRefusal(session: Session, extra = ''): Promise<Reply> {
    const hasPasskey = (await dk.listPasskeys(store, session.user)).length > 0;
    return [403, { stepUp: true, hasPasskey, error: (hasPasskey
      ? 'Confirm it\'s you with your passkey to do this.'
      : 'This needs a passkey. Add one in User Settings (Passkeys), then try again.') + extra }];
  }
  // Re-confirming who it is before a sensitive account change (email, adding or removing a passkey), so a stolen session
  // alone isn't enough; dk.reauthNeeded decides how. Returns the refusal, or null.
  const SIGN_IN_AGAIN = `For your security, sign out and sign in again, then make this change within ${STEP_UP_MS / 60000} minutes.`;
  const LOST_PASSKEY = ` Lost your passkey? Reset your password with the email link, sign in, and change your passkeys within ${STEP_UP_MS / 60000} minutes.`;
  async function reauthNeed(session: Session, change: dk.ReauthChange): Promise<dk.Reauth> {
    const user = (await dk.getUser(store, session.user))!;
    return dk.reauthNeeded({
      strong: Boolean(strongUntil(session)), hasPassword: user.hasPassword, passkeys: (await dk.listPasskeys(store, session.user)).length,
      signedInAt: session.signedInAt, resetAt: user.resetAt ? new Date(user.resetAt).getTime() : null, now: Date.now(), windowMs: STEP_UP_MS,
    }, change);
  }
  async function reauthRefusal(session: Session, change: dk.ReauthChange, given?: unknown): Promise<Reply | null> {
    const need = await reauthNeed(session, change);
    if (need === 'ok') return null;
    if (need === 'password') return confirmOwnPassword(session.user, given);
    if (need === 'step-up') return stepUpRefusal(session, change === 'email' ? '' : LOST_PASSKEY);
    return [403, { error: SIGN_IN_AGAIN }];
  }
  const meReply = (user: dk.User) => ({ username: user.username, email: user.email, pendingEmail: user.pendingEmail, phone: user.phone, dark: user.dark,
    notifyAccess: user.notifyAccess, notifyAlerts: user.notifyAlerts });
  // The site name passkeys are tied to for this request: the public name (over HTTPS), or localhost on the server
  // itself; null for any other host (such as 127.0.0.1, which WebAuthn doesn't accept).
  const challenges = new dk.PasskeyChallenges(); // this server's passkey challenges
  function relyingParty(req: IncomingMessage): dk.RelyingParty | null {
    const host = (req.headers.host || '').toLowerCase();
    if (PUBLIC_HOST && host === PUBLIC_HOST) return { rpID: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}`, challenges };
    if (host === `localhost:${PORT}`) return { rpID: 'localhost', origin: `http://localhost:${PORT}`, challenges };
    return null;
  }
  // Single sign-on providers (config.json sso.providers; src/sso.ts).
  const SSO = config.sso.providers;
  const ssoFlows = new dk.SsoFlows(); // this server's sign-ins in progress
  const SSO_LIST = SSO.map((provider) => ({ id: provider.id, name: provider.name }));
  const providerOf = (id: unknown) => SSO.find((provider) => provider.id === id);
  // Where a provider sends the browser back: like passkeys, the public name over HTTPS, or localhost on the server.
  const ssoRedirect = (req: IncomingMessage, provider: dk.SsoProvider): string | null => {
    const rp = relyingParty(req);
    return rp ? `${rp.origin}/api/sso/${provider.id}/callback` : null;
  };
  const NO_SSO_SITE = `Single sign-on works only at ${PUBLIC_HOST ? `https://${PUBLIC_HOST}` : 'this site\'s public name'} or http://localhost:${PORT}`;
  // The cookie tying a sign-in at a provider to this browser. The provider's redirect back is a cross-site navigation,
  // so it is SameSite=Lax (the session cookie stays Strict).
  const ssoCookie = (req: IncomingMessage, value: string, maxAge: number) =>
    `dk_sso=${value}; HttpOnly; SameSite=Lax; Path=/api/sso; Max-Age=${maxAge}${isPublic(req) ? '; Secure' : ''}`;
  const cookieValue = (req: IncomingMessage, name: string): string => (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '') || [])[1] || '';
  // Confirms a sensitive change with the current password, checked like a sign-in (5 wrong tries pause it); accounts with
  // no password (single sign-on) aren't asked. Returns the refusal, or null.
  async function confirmOwnPassword(username: string, given: unknown): Promise<Reply | null> {
    if (!(await dk.getUser(store, username))!.hasPassword) return null;
    const keys: [string, number][] = [[`me:${username}`, MAX_FAILED_SIGN_INS]];
    if (blocked(keys)) return [429, { error: `Too many wrong passwords. Try again in ${SIGN_IN_WINDOW_MS / 60000} minutes.` }];
    const takeBack = countTry(keys);
    let right: boolean;
    try { right = await dk.checkOwnPassword(store, username, given); } catch (err) { takeBack(); throw err; }
    if (!right) return [403, { error: 'Your password is wrong' }];
    takeBack();
    return null;
  }
  // Why the account can't use a password (linked to a provider with passwords: false), or null.
  async function passwordOff(username: string): Promise<string | null> {
    const by = await dk.passwordBlockers(store, username, SSO);
    return by.length ? `Your account signs in with ${by.join(' or ')}; password sign-in is turned off for it` : null;
  }
  const NO_PASSKEY_SITE = `Passkeys work only at ${PUBLIC_HOST ? `https://${PUBLIC_HOST}` : 'this site\'s public name'} or http://localhost:${PORT}`;
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])]);
  const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
    ...(PUBLIC_HOST ? [`https://${PUBLIC_HOST}`] : [])]);
  const isPublic = (req: http.IncomingMessage) => Boolean(PUBLIC_HOST) && (req.headers.host || '').toLowerCase() === PUBLIC_HOST;
  // Session cookie attributes; Secure when the page came through the public HTTPS name.
  const cookieAttrs = (req: http.IncomingMessage) => `; HttpOnly; SameSite=Strict; Path=/${isPublic(req) ? '; Secure' : ''}`;
  return { approvals, reauthNeed, RESET_PER_ACCOUNT, PER_ADDRESS, overLimit, clientIp, newSetupCode, setupCodeMatches, endSetup, oneSetupAtATime, clearFailedSignIn, signInKeys, blocked, countTry, clearFailures, sweepSessions, currentSession, strongUntil, stepUpRefusal, reauthRefusal, meReply, relyingParty, SSO, SSO_LIST, providerOf, ssoFlows, ssoRedirect, NO_SSO_SITE, ssoCookie, cookieValue, confirmOwnPassword, passwordOff, NO_PASSKEY_SITE, ALLOWED_HOSTS, ALLOWED_ORIGINS, cookieAttrs };
}

export type AuthModule = ReturnType<typeof createAuth>;
