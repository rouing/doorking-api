// The signed-in user's own settings, password, passkeys and linked sign-ins.
import * as dk from '../../index.ts';
import { type Route, route } from '../routing.ts';
import type { AuthModule } from '../auth.ts';
import type { ContextModule } from '../context.ts';
import type { MailModule } from '../mail.ts';
import { logger } from '../../src/logging.ts';

export function accountRoutes(deps: AuthModule & ContextModule & MailModule): Route[] {
  const { confirmOwnPassword, mailer, mailTo, meReply, NO_EMAIL, NO_PASSKEY_SITE, passwordOff, providerOf, reauthRefusal, relyingParty, securityAlert, sendVerification, SSO, store } = deps;
  return [
    // The signed-in user's own settings: GET { username, email, dark }; PUT { email?, dark? }.
    route('GET', '/api/me', 'user', async ({ session }) => [200, meReply((await dk.getUser(store, session.user))!)]),
    // { email?, phone?, dark?, notifyAccess?, notifyAlerts? }. A new email waits for its confirmation link (sent to it); the
    // old confirmed address is told about the change.
    route('PUT', '/api/me', 'user', async ({ session, body }) => {
      const was = (await dk.getUser(store, session.user))!;
      if (body.email !== undefined && ![was.email, was.pendingEmail].includes(String(body.email).trim().toLowerCase())) {
        const refused = await reauthRefusal(session, 'email', body.password); // a changed email could take over the account by password reset
        if (refused) return refused;
      }
      const user = await dk.updateUserSettings(store, session.user, { email: body.email, dark: body.dark, phone: body.phone, notifyAccess: body.notifyAccess, notifyAlerts: body.notifyAlerts });
      let warning = '';
      if (user.pendingEmail && user.pendingEmail !== was.pendingEmail) {
        // The new address is saved (waiting) either way; a failed confirmation email is reported, not refused.
        try { await sendVerification(user.username); } catch { warning = 'Saved, but the confirmation email couldn\'t be sent. Use Send the link again.'; }
        if (user.email) await mailTo(user.email, dk.messages.emailChanged(user.username, user.pendingEmail), 'security');
        logger('session')[!mailer || warning ? 'warn' : 'info']`${user.username} asked to change their email (confirmation ${!mailer ? 'not sent: email is off' : warning ? 'not queued' : 'sent'})`;
      }
      return [200, { ...meReply(user), ...(warning && { warning }) }];
    }),
    // Sends the confirmation link for the pending email again.
    route('POST', '/api/me/email/resend', 'user', async ({ session }) => {
      if (!mailer) return [503, { error: NO_EMAIL }];
      const user = (await dk.getUser(store, session.user))!;
      if (!user.pendingEmail) return [400, { error: 'There is no email waiting to be confirmed' }];
      await sendVerification(user.username);
      return [200, { ok: true }];
    }),

    // Changes the user's own password ({ current, password }); their other sessions end.
    route('PUT', '/api/me/password', 'user', async ({ session, body }) => {
      const off = await passwordOff(session.user);
      if (off) return [403, { error: off }];
      const refused = await confirmOwnPassword(session.user, body.current);
      if (refused) return refused;
      await dk.changeOwnPassword(store, session.user, body.current, body.password, session.tokenHash);
      await securityAlert(session.user, 'Your password was changed');
      logger('session').info`${session.user} changed their password`;
      return [200, { ok: true }];
    }),

    // Passkeys of the signed-in user (another way to sign in). Adding one: POST options { password } (the current
    // password, checked like a sign-in: 5 wrong tries pause it; not asked when the account has none, as when it signs in
    // with single sign-on), then POST { name, response } with the browser's answer.
    route('GET', '/api/me/passkeys', 'user', async ({ session }) => [200, { passkeys: await dk.listPasskeys(store, session.user) }]),
    route('POST', '/api/me/passkeys/options', 'user', async ({ session, req, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      const refused = await reauthRefusal(session, 'add-passkey', body.password);
      if (refused) return refused;
      return [200, await dk.registrationOptions(store, session.user, rp)];
    }),
    route('POST', '/api/me/passkeys', 'user', async ({ session, req, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      const passkey = await dk.addPasskey(store, session.user, body.response, body.name, rp);
      logger('session').info`${session.user} added passkey "${passkey.name}" for ${rp.rpID}`;
      await securityAlert(session.user, `A passkey ("${passkey.name}") was added`);
      return [201, { passkeys: await dk.listPasskeys(store, session.user) }];
    }),
    route('PUT', '/api/me/passkeys/:id', 'user', async ({ session, params, body }) => {
      await dk.renamePasskey(store, session.user, params.id, body.name);
      return [200, { passkeys: await dk.listPasskeys(store, session.user) }];
    }),
    route('DELETE', '/api/me/passkeys/:id', 'user', async ({ session, params }) => {
      const refused = await reauthRefusal(session, 'remove-passkey');
      if (refused) return refused;
      const name = await dk.removePasskey(store, session.user, params.id);
      logger('session').info`${session.user} removed passkey "${name}"`;
      await securityAlert(session.user, `A passkey ("${name}") was removed`);
      return [200, { passkeys: await dk.listPasskeys(store, session.user) }];
    }),

    // The signed-in account's linked sign-ins: { identities: [{ provider, providerName, subject, email, linkedAt,
    // lastUsedAt }] }; DELETE unlinks one (refused when it is the only way left to sign in).
    route('GET', '/api/me/sso', 'user', async ({ session }) => [200, { identities: await dk.listIdentities(store, session.user, SSO) }]),
    route('DELETE', '/api/me/sso/:provider/:subject', 'user', async ({ session, params }) => {
      await dk.unlinkIdentity(store, session.user, params.provider, params.subject, SSO);
      const name = providerOf(params.provider)?.name || params.provider;
      await securityAlert(session.user, `Sign-in with ${name} was unlinked from your account`);
      logger('session').info`${session.user} unlinked a ${name} sign-in`;
      return [200, { identities: await dk.listIdentities(store, session.user, SSO) }];
    }),
  ];
}
