// Sign-in: password, first account, email links, passkeys, step-up and single sign-on.
import * as dk from '../../index.ts';
import { type Route, route } from '../routing.ts';
import type { Modules } from '../modules.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Body, Reply } from '../context.ts';
import { logger } from '../../src/logging.ts';

export function authRoutes(modules: Modules): Route[] {
  return [...sessionRoutes(modules), ...emailLinkRoutes(modules), ...passkeyRoutes(modules), ...ssoRoutes(modules)];
}

// Signing in and out with a password, and the first account.
function sessionRoutes(modules: Modules): Route[] {
  const { config, defaults, gateInfo, mailer, SIGN_IN_WINDOW_MS, store } = modules.context;
  const {
    blocked, clearFailedSignIn, clientIp, cookieAttrs, countTry, endSetup, oneSetupAtATime, passwordOff,
    setupCodeMatches, signInKeys, SSO_LIST, strongUntil
  } = modules.auth;
  // The first account (see POST /api/setup).
  async function createFirstAccount(body: Body, req: IncomingMessage, res: ServerResponse): Promise<Reply> {
    if (await dk.userCount(store) > 0) return [409, { error: 'Setup is already done. Sign in instead.' }];
    if (!setupCodeMatches(body.setupCode)) {
      logger('session').warn('First-account setup refused: wrong setup code');
      return [403, { error: 'Wrong setup code. It is printed in the server\'s log (journalctl -u doorking) when the server starts.' }];
    }
    const user = await dk.createUser(store, { username: body.username, password: body.password, email: body.email, createdBy: 'setup', mustChangePassword: false });
    const adopted = await dk.adoptAdminlessGates(store, user.username);
    const tok = await dk.createSession(store, user.username);
    endSetup();
    logger('session').info`First account ${user.username} created (admin of ${adopted.length} gate(s))`;
    res.setHeader('Set-Cookie', `sid=${tok}${cookieAttrs(req)}`);
    return [201, { ok: true, gates: adopted.length }];
  }


  return [
    // Session: sign in with a local account; the sid cookie authenticates every later call. setup: no account exists
    // yet (POST /api/setup creates the first one).
    route('GET', '/api/session', 'public', async ({ session }) => {
      if (!session) return [200, { loggedIn: false, emailEnabled: Boolean(mailer), sso: SSO_LIST, ...(await dk.userCount(store) === 0 && { setup: true }) }];
      const user = (await dk.getUser(store, session.user))!;
      const open = session.gate ? await dk.accessOf(store, session.gate, session.user) : null;
      const rec = open && session.gate ? await dk.getGate(store, session.gate) : null;
      return [200, { loggedIn: true, user: user.username, email: user.email, pendingEmail: user.pendingEmail, phone: user.phone, dark: user.dark,
        notifyAccess: user.notifyAccess, notifyAlerts: user.notifyAlerts, mustChangePassword: session.mustChangePassword, emailEnabled: Boolean(mailer),
        sso: SSO_LIST, hasPassword: user.hasPassword, passwordAllowed: !await passwordOff(user.username),
        hasPasskey: (await dk.listPasskeys(store, user.username)).length > 0, stepUpMinutes: config.security.stepUpMinutes,
        strongUntil: strongUntil(session) ? new Date(strongUntil(session)!).toISOString() : null,
        gate: rec && open ? await gateInfo({ ...rec, role: open }) : null, defaults, holidayList: dk.FIXED_HOLIDAYS }];
    }),

    route('POST', '/api/session', 'public', async ({ body, req, res }) => {
      const user = String(body.user || '').trim();
      const password = String(body.password || '');
      if (!user || !password) return [400, { error: 'Username and password are required' }];
      const key = user.toLowerCase();
      const ip = clientIp(req);
      const keys = signInKeys(key, ip);
      // The typed username is logged only when it is an account (people sometimes type their password there).
      const who = async () => ((await dk.getUser(store, key)) ? key : 'an unknown username');
      if (blocked(keys)) {
        logger('session').warn`Sign-in for ${await who()} refused after too many failed tries (${ip})`;
        return [429, { error: `Too many failed sign-ins. Try again in ${SIGN_IN_WINDOW_MS / 60000} minutes.` }];
      }
      const takeBack = countTry(keys);
      let account: dk.User | null;
      try { account = await dk.authenticate(store, user, password, passwordOff); } catch (err) { takeBack(); throw err; }
      if (!account) {
        logger('session').warn`Sign-in for ${await who()} refused: wrong username or password (${ip})`;
        return [401, { error: `Wrong username or password${SSO_LIST.length ? '. Accounts that sign in with a work account use its button.' : ''}` }];
      }
      takeBack();
      clearFailedSignIn(key, ip);
      const tok = await dk.createSession(store, account.username);
      logger('session').info`${account.username} signed in`;
      res.setHeader('Set-Cookie', `sid=${tok}${cookieAttrs(req)}`);
      return [200, { ok: true }];
    }),

    route('DELETE', '/api/session', 'public', async ({ session, req, res }) => {
      if (session) { await dk.deleteSession(store, session.tokenHash); logger('session').info`${session.user} signed out`; }
      res.setHeader('Set-Cookie', `sid=${cookieAttrs(req)}; Max-Age=0`);
      return [200, { ok: true }];
    }),

    // First start only (no account yet): creates the first account, which becomes admin of every gate that has no
    // admin (gates moved over from DKS sign-in), and signs it in. { setupCode, username, password, email? }.
    route('POST', '/api/setup', 'public', async ({ body, req, res }) => {
      return await oneSetupAtATime(() => createFirstAccount(body, req, res)) ?? [409, { error: 'Setup is already running. Try again in a moment.' }];
    }),
  ];
}

// The email links: confirming an address, password reset and accepting an invitation.
function emailLinkRoutes(modules: Modules): Route[] {
  const { APP, mailer, NO_EMAIL, store } = modules.context;
  const { clearFailures, clientIp, cookieAttrs, overLimit, passwordOff, PER_ADDRESS, RESET_PER_ACCOUNT } = modules.auth;
  const { mailTo, securityAlert } = modules.mail;
  return [
    // Email links (public: they work without being signed in). verify { token }: confirms the address. Password reset:
    // request { identifier } (username or confirmed email; the reply is the same whether or not it exists), then
    // { token, password }. Invitation: check { token } -> { username }, then { token, password } (sets the password, confirms
    // the email and signs in).
    route('POST', '/api/email/verify', 'public', async ({ body }) => {
      const token = await dk.useToken(store, 'verify', body.token);
      if (!token) return [400, { error: 'This confirmation link is invalid, used or expired. Ask for a new one in User Settings.' }];
      const user = await dk.confirmEmail(store, token.username, token.data);
      logger('session').info`${user.username} confirmed their email`;
      return [200, { username: user.username, email: user.email }];
    }),
    // The reply is the same whether or not the account exists, and when a limit is reached (per client address, then per
    // account), so it can't be used to find accounts.
    route('POST', '/api/password-reset/request', 'public', async ({ req, body }) => {
      if (!mailer) return [503, { error: NO_EMAIL }];
      const id = String(body.identifier || '').trim().toLowerCase();
      if (!id) return [400, { error: 'Enter your username or email' }];
      const reply: Reply = [200, { ok: true, message: 'If that account exists and has a confirmed email, a reset link is on its way. It works for 1 hour.' }];
      const ip = clientIp(req);
      if (overLimit(`reset:${ip}`, PER_ADDRESS)) { logger('session').warn`Password reset not sent: too many requests from ${ip}`; return reply; }
      const found = await dk.userForReset(store, id);
      const user = found && !await passwordOff(found.username) ? found : null;
      if (user && overLimit(`reset-account:${user.username}`, RESET_PER_ACCOUNT)) { logger('session').warn`Password reset for ${user.username} not sent: too many requests`; return reply; }
      if (!user) {
        logger('session').info`Password reset for "${id}": no account with a confirmed email`;
        return reply;
      }
      await mailTo(user.email, dk.messages.reset(APP, user.username, await dk.createToken(store, 'reset', user.username)), 'reset');
      logger('session').info`Password reset link sent to ${user.username}`;
      return reply;
    }),
    route('POST', '/api/password-reset', 'public', async ({ body }) => {
      dk.checkPassword(body.password);
      const token = await dk.useToken(store, 'reset', body.token);
      if (!token) return [400, { error: 'This reset link is invalid, used or expired. Ask for a new one.' }];
      const off = await passwordOff(token.username);
      if (off) return [403, { error: off }];
      await dk.setPassword(store, token.username, body.password, { byEmail: true });
      clearFailures(token.username);
      await securityAlert(token.username, 'Your password was reset');
      logger('session').info`${token.username} reset their password with an email link`;
      return [200, { username: token.username }];
    }),
    route('POST', '/api/invite/check', 'public', async ({ body }) => {
      const token = await dk.peekToken(store, 'invite', body.token);
      return token ? [200, { username: token.username }] : [400, { error: 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.' }];
    }),
    route('POST', '/api/invite', 'public', async ({ req, res, body }) => {
      dk.checkPassword(body.password);
      const token = await dk.useToken(store, 'invite', body.token);
      if (!token) return [400, { error: 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.' }];
      const user = await dk.acceptInvite(store, token.username, body.password);
      await dk.recordSignIn(store, user.username);
      const tok = await dk.createSession(store, user.username);
      logger('session').info`${user.username} accepted their invitation and signed in`;
      res.setHeader('Set-Cookie', `sid=${tok}${cookieAttrs(req)}`);
      return [200, { ok: true }];
    }),
  ];
}

// Signing in with a passkey, and confirming with one (step-up).
function passkeyRoutes(modules: Modules): Route[] {
  const { STEP_UP_MS, store } = modules.context;
  const { clientIp, cookieAttrs, NO_PASSKEY_SITE, overLimit, PER_ADDRESS, relyingParty } = modules.auth;
  return [
    // Passkey sign-in: POST options (no username: the browser offers this site's passkeys, also in the username box's
    // suggestions), then POST session { response }; sets the sid cookie like a password sign-in. A passkey not
    // registered here: 401 { unknownCredential: true }.
    route('POST', '/api/passkey/options', 'public', async ({ req }) => {
      if (overLimit(`passkey:${clientIp(req)}`, PER_ADDRESS)) return [429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }];
      const rp = relyingParty(req);
      return rp ? [200, await dk.authenticationOptions(rp)] : [400, { error: NO_PASSKEY_SITE }];
    }),
    route('POST', '/api/passkey/session', 'public', async ({ req, res, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      let username: string;
      try { username = await dk.signInWithPasskey(store, body.response, rp); } catch (err) {
        logger('session').warn`Passkey sign-in refused: ${(err as Error).message}`;
        if (err instanceof dk.UnknownPasskeyError) return [401, { error: err.message, unknownCredential: true }];
        throw err;
      }
      await dk.recordSignIn(store, username);
      const tok = await dk.createSession(store, username, { strong: true });
      logger('session').info`${username} signed in with a passkey`;
      res.setHeader('Set-Cookie', `sid=${tok}${cookieAttrs(req)}`);
      return [200, { ok: true }];
    }),

    // Step-up (see STEP_UP): POST options (the signed-in user's passkeys for this site; 409 none), then POST
    // { response } with the browser's answer: the session is confirmed for security.stepUpMinutes { strongUntil }.
    route('POST', '/api/me/step-up/options', 'user', async ({ session, req }) => {
      const rp = relyingParty(req);
      return rp ? [200, await dk.confirmationOptions(store, session.user, rp)] : [400, { error: NO_PASSKEY_SITE }];
    }),
    route('POST', '/api/me/step-up', 'user', async ({ session, req, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      try { await dk.confirmWithPasskey(store, session.user, body.response, rp); } catch (err) {
        logger('session').warn`${session.user}: passkey confirmation refused: ${(err as Error).message}`;
        throw err;
      }
      const at = await dk.markSessionStrong(store, session.tokenHash);
      logger('session').info`${session.user} confirmed with a passkey`;
      return [200, { strongUntil: new Date(at + STEP_UP_MS).toISOString() }];
    }),
  ];
}

// Single sign-on: starting a sign-in or a link, and the provider's callback.
function ssoRoutes(modules: Modules): Route[] {
  const { store } = modules.context;
  const {
    clientIp, confirmOwnPassword, cookieAttrs, cookieValue, NO_SSO_SITE, overLimit, PER_ADDRESS, providerOf,
    ssoCookie, ssoFlows, ssoRedirect
  } = modules.auth;
  const { securityAlert } = modules.mail;
  return [
    // Single sign-on (src/sso.ts). Start { provider, invite? } -> { url }: the provider's address to open; the response
    // sets the cookie tying the attempt to this browser. With an invitation link's token, the invitation is accepted
    // with the provider. Linking to the signed-in account: { provider, password } (the current password; not asked when the
    // account has none). The provider sends the browser back to the callback, which signs in (or links) and goes to the
    // page: / signed in, /#sso=linked, or /#sso-error=<message>.
    route('POST', '/api/sso/start', 'public', async ({ req, res, body }) => {
      if (overLimit(`sso:${clientIp(req)}`, PER_ADDRESS)) return [429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }];
      const provider = providerOf(body.provider);
      if (!provider) return [404, { error: 'Unknown sign-in provider' }];
      const redirectUri = ssoRedirect(req, provider);
      if (!redirectUri) return [400, { error: NO_SSO_SITE }];
      const invite = body.invite ? String(body.invite) : undefined;
      const { url, binding } = await dk.startSso(ssoFlows, provider, { mode: invite ? 'invite' : 'signin', redirectUri, inviteToken: invite });
      res.setHeader('Set-Cookie', ssoCookie(req, binding, 600));
      return [200, { url }];
    }),
    route('POST', '/api/me/sso/start', 'user', async ({ session, req, res, body }) => {
      const provider = providerOf(body.provider);
      if (!provider) return [404, { error: 'Unknown sign-in provider' }];
      const redirectUri = ssoRedirect(req, provider);
      if (!redirectUri) return [400, { error: NO_SSO_SITE }];
      const refused = await confirmOwnPassword(session.user, body.password);
      if (refused) return refused;
      const { url, binding } = await dk.startSso(ssoFlows, provider, { mode: 'link', redirectUri, username: session.user });
      res.setHeader('Set-Cookie', ssoCookie(req, binding, 600));
      return [200, { url }];
    }),
    route('GET', '/api/sso/:provider/callback', 'public', async ({ req, res, params }) => {
      const cookies = [ssoCookie(req, '', 0)];
      const go = (location: string) => { res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' }); res.end(); };
      const provider = providerOf(params.provider);
      try {
        if (!provider) throw dk.httpError('Unknown sign-in provider', 404);
        const result = await dk.finishSso(ssoFlows, provider, new URL(req.url!, 'http://local').searchParams, cookieValue(req, 'dk_sso'));
        const done = await dk.completeSso(store, provider, result);
        logger('session').info`${done.username}: ${provider.name} single sign-on (${done.outcome})`;
        if (done.outcome === 'linked') await securityAlert(done.username, `Sign-in with ${provider.name} was linked to your account`);
        if (result.mode === 'link') return go('/#sso=linked');
        cookies.push(`sid=${await dk.createSession(store, done.username)}${cookieAttrs(req)}`);
        return go('/');
      } catch (caught) {
        const err = caught as Error & { status?: number };
        logger('session').warn`Single sign-on${provider ? ` with ${provider.name}` : ''} refused: ${err.message}`;
        return go(`/#sso-error=${encodeURIComponent(err.status ? err.message : `The ${provider ? provider.name : ''} sign-in couldn't be checked. Try again.`)}`);
      }
    }),
  ];
}
