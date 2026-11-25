/**
 * @module web/routes/account
 *
 * The signed-in user's own settings, password, passkeys and linked sign-ins.
 */
import * as dk from '../../index.ts';
import { type Route, route } from '../routing.ts';
import type { Modules } from '../modules.ts';
import { logger } from '../../src/logging.ts';

/**
 * Account routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function accountRoutes(modules: Modules): Route[] {
  const { asGate, logged, mailer, NO_EMAIL, prefsOf, siteNameOf, store } = modules.context;
  const {
    approvals, clientIp, confirmOwnPassword, meReply, NO_PASSKEY_SITE, overLimit, passwordOff, providerOf, pushApprovals,
    reauthNeed, reauthRefusal, relyingParty, SSO
  } = modules.auth;
  const { editOpts, editResidentInCache, editorResidents, withHistory } = modules.editing;
  const { gateAlert, mailTo, securityAlert, sendVerification } = modules.mail;
  const passkeysReply = async (user: string) => {
    const fcmOn = modules.push.fcmEnabled();
    const [passkeys, userHandle, fcmTokens, bioKeys] = await Promise.all([
      dk.listPasskeys(store, user),
      dk.passkeyUserHandle(store, user),
      fcmOn ? dk.listFcmTokens(store, user) : Promise.resolve([]),
      fcmOn ? dk.listBiometricKeys(store, user) : Promise.resolve([]),
    ]);
    return {
      passkeys,
      userHandle,
      pushApprovalAvailable: fcmOn && fcmTokens.length > 0 && bioKeys.length > 0,
    };
  };
  const fcmReply = async (user: string) => ({ enabled: modules.push.fcmEnabled(), tokens: await dk.listFcmTokens(store, user) });
  const aiClientsReply = async (user: string) => {
    const sessions = await dk.listMcpSessions(store, user);
    const enriched = await Promise.all(sessions.map(async (s) => {
      const relaySummary: Array<{ phone: string; siteName: string; relays: Array<{ relay: number; name: string }> }> = [];
      for (const [phone, relayList] of Object.entries(s.relays)) {
        const [prefs, siteName] = await Promise.all([prefsOf(phone), siteNameOf(phone)]);
        const labels = prefs.relayLabels || {};
        relaySummary.push({
          phone,
          siteName: siteName || `Gate ${phone}`,
          relays: relayList.map((r) => ({ relay: r, name: labels[String(r)] || `Relay ${r}` })),
        });
      }
      return { ...s, relaySummary };
    }));
    return { clients: enriched };
  };

  function deviceLabelFrom(given: unknown, userAgent: unknown): string {
    const custom = String(given ?? '').trim().slice(0, 80);
    if (custom) return custom;
    const ua = String(userAgent ?? '');
    if (!ua) return 'Another device';
    const browser = /Edg\//i.test(ua) ? 'Edge'
      : /Firefox\//i.test(ua) ? 'Firefox'
        : /Chrome\//i.test(ua) ? 'Chrome'
          : /Safari\//i.test(ua) ? 'Safari' : '';
    const os = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad/i.test(ua) ? 'iOS'
        : /Mac OS X/i.test(ua) ? 'macOS'
          : /Windows/i.test(ua) ? 'Windows'
            : /Linux/i.test(ua) ? 'Linux' : '';
    if (browser && os) return `${browser} on ${os}`;
    return browser || os || 'Another device';
  }

  /** Resolves enabled resident portal units for `username` along with their current directory call-box phone. */
  async function linkedResidentUnits(username: string) {
    const owned = await dk.ownedPortalUnitsAllGates(store, username);
    if (!owned.length) return [];
    const byGate = new Map<string, string[]>();
    for (const row of owned) byGate.set(row.phone, [...(byGate.get(row.phone) || []), row.code]);
    const out: Array<{ gatePhone: string; directoryCode: string; phone: string }> = [];
    for (const [gatePhone, codes] of byGate) {
      const rec = await dk.getGate(store, gatePhone);
      if (!rec) continue;
      const portal = dk.normalizeResidentPortalPrefs((await prefsOf(gatePhone)).residentPortal);
      if (!portal.enabled) continue;
      const working = await dk.loadWorkingState(store, gatePhone);
      const residents = working?.state.residents || [];
      for (const codeKey of codes) {
        const unit = residents.find((r) => dk.noteKey(r.directoryCode) === codeKey);
        if (!unit) continue;
        const digits = `${unit.areaCode || ''}${unit.phone || ''}`.replace(/\D/g, '');
        out.push({ gatePhone, directoryCode: unit.directoryCode, phone: digits });
      }
    }
    return out;
  }

  /** Syncs a resident's updated US/Canada phone directly into their linked gate directory unit(s). */
  async function syncLinkedUnitPhones(
    session: Parameters<typeof withHistory>[0],
    e164Phone: string,
  ): Promise<{ updatedUnits: string[]; nextScheduledSend: string | null } | undefined> {
    const nanp = dk.parseNanpPhone(e164Phone);
    const linked = nanp ? await linkedResidentUnits(session.user) : [];
    if (!nanp || !linked.length) return undefined;
    const updatedUnits: string[] = [];
    const nextSends: string[] = [];
    const byGate = new Map<string, typeof linked>();
    for (const item of linked) byGate.set(item.gatePhone, [...(byGate.get(item.gatePhone) || []), item]);
    const targetDigits = `${nanp.areaCode}${nanp.phone}`;
    for (const [gatePhone, units] of byGate) {
      const rec = await dk.getGate(store, gatePhone);
      if (!rec) continue;
      const gate = asGate(rec, 'resident', session.user);
      const opts = await editOpts(gate);
      for (const unit of units) {
        if (unit.phone === targetDigits) continue;
        const editReply = await withHistory(
          session,
          gate,
          { summary: `Resident ${session.user} (unit ${unit.directoryCode}) updated call-box phone number` },
          (ctx) => editResidentInCache(gate.phoneNumber, unit.directoryCode, nanp, opts, ctx),
        );
        if (editReply[0] >= 300) continue;
        updatedUnits.push(unit.directoryCode);
        const nextSend = await dk.nextScheduledSend(store, gate.phoneNumber);
        if (nextSend) nextSends.push(nextSend);
        await gateAlert(
          gate.phoneNumber,
          `Resident updated call-box phone (Unit ${unit.directoryCode})`,
          `${session.user} (directory code ${unit.directoryCode}) updated their call-box phone number to ${dk.fmtPhone(targetDigits)} in the working copy.${nextSend ? ` Next scheduled send: ${new Date(nextSend).toLocaleString('en-US')}.` : ' Please review and click Send to gate.'}`,
        ).catch(logged('gate', `Gate ${gate.phoneNumber}: phone-update admin alert failed`));
      }
    }
    return updatedUnits.length ? { updatedUnits, nextScheduledSend: nextSends.sort()[0] || null } : undefined;
  }

  /** Resolves all buzz-openable relays per gate accessible to `username`, with each relay's current hidden state. */
  async function accessiblePortalRelays(username: string, hiddenRelays: Record<string, number[]>) {
    const gates = await dk.userGates(store, username);
    const out: Array<{ phone: string; siteName: string; relays: Array<{ relay: number; name: string; hidden: boolean }> }> = [];
    for (const g of gates) {
      const prefs = await prefsOf(g.phoneNumber);
      const portal = dk.normalizeResidentPortalPrefs(prefs.residentPortal);
      const isAdmin = g.role === 'admin';
      let allowed: number[] = [];
      if (isAdmin) {
        allowed = dk.allOpenableRelays(prefs);
      } else if (portal.enabled && portal.buzzEnabled) {
        const owned = await dk.ownedPortalUnits(store, g.phoneNumber, username);
        if (owned.length) allowed = portal.buzzRelays;
      }
      if (!allowed.length) continue;
      const labels = prefs.relayLabels || {};
      const hidden = new Set(hiddenRelays[g.phoneNumber] || []);
      const siteName = (await siteNameOf(g.phoneNumber)) || `Gate ${g.phoneNumber}`;
      out.push({
        phone: g.phoneNumber,
        siteName,
        relays: allowed.map((relay) => ({
          relay,
          name: labels[String(relay)] || `Relay ${relay}`,
          hidden: hidden.has(relay),
        })),
      });
    }
    return out;
  }

  return [
    // The signed-in user's own settings: GET { username, email, pendingEmail, phone, dark, notifyAccess, notifyAlerts, hiddenRelays, portalRelays };
    // PUT changes any of email (needs the current password), phone, dark, notifyAccess, notifyAlerts, hiddenRelays.
    route('GET', '/api/me', 'user', async ({ session }) => {
      const user = (await dk.getUser(store, session.user))!;
      const base = meReply(user);
      const [linkedUnits, portalRelays] = await Promise.all([
        linkedResidentUnits(session.user),
        accessiblePortalRelays(session.user, user.hiddenRelays),
      ]);
      const fallbackPhone = !base.phone && linkedUnits.length
        ? linkedUnits.map((u) => u.phone).find(Boolean) || ''
        : '';
      const displayPhone = base.phone || (fallbackPhone.length === 10 ? `+1${fallbackPhone}` : fallbackPhone);
      return [200, { ...base, phone: displayPhone, portalRelays, ...(linkedUnits.length && { linkedUnits }) }];
    }),
    // { email?, phone?, dark?, notifyAccess?, notifyAlerts?, hiddenRelays? }. A new email waits for its confirmation link (sent to it); the
    // old confirmed address is told about the change. For residents with portal units, updating phone also updates their
    // unit's call-box phone in the gate working copy so they can self-serve update it.
    route('PUT', '/api/me', 'user', async ({ session, body }) => {
      const was = (await dk.getUser(store, session.user))!;
      if (body.email !== undefined && ![was.email, was.pendingEmail].includes(String(body.email).trim().toLowerCase())) {
        const refused = await reauthRefusal(session, 'email', body.password); // a changed email could take over the account by password reset
        if (refused) return refused;
      }
      const user = await dk.updateUserSettings(store, session.user, {
        email: body.email,
        dark: body.dark,
        phone: body.phone,
        notifyAccess: body.notifyAccess,
        notifyAlerts: body.notifyAlerts,
        hiddenRelays: body.hiddenRelays,
      });
      let warning = '';
      if (user.pendingEmail && user.pendingEmail !== was.pendingEmail) {
        // The new address is saved (waiting) either way; a failed confirmation email is reported, not refused.
        try { await sendVerification(user.username); } catch { warning = 'Saved, but the confirmation email couldn\'t be sent. Use Send the link again.'; }
        if (user.email) await mailTo(user.email, dk.messages.emailChanged(user.username, user.pendingEmail), 'security');
        logger('session')[!mailer || warning ? 'warn' : 'info']`${user.username} asked to change their email (confirmation ${!mailer ? 'not sent: email is off' : warning ? 'not queued' : 'sent'})`;
      }

      const gatePhoneSync = body.phone !== undefined && user.phone
        ? await syncLinkedUnitPhones(session, user.phone)
        : undefined;

      return [200, { ...meReply(user), ...(warning && { warning }), ...(gatePhoneSync && { gatePhoneSync }) }];
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
      await dk.changeOwnPassword(store, session.user, { current: body.current, next: body.password, keepSession: session.tokenHash });
      await securityAlert(session.user, 'Your password was changed');
      logger('session').info`${session.user} changed their password`;
      return [200, { ok: true }];
    }),

    // Passkeys of the signed-in user (another way to sign in): { passkeys, userHandle } (userHandle: the account's
    // WebAuthn user handle, null before its first passkey). Adding one: POST options { password } (the current
    // password, checked like a sign-in: 5 wrong tries pause it; not asked when the account has none, as when it signs in
    // with single sign-on, or for the first passkey within 2 minutes of signing in), then POST { name, response } with
    // the browser's answer. { auto: true } in both: the browser saving a passkey by itself right after a password sign-in
    // (no prompt, so the device may not check the user; their passkey sign-ins still must): only for the first passkey
    // within 2 minutes of signing in, else 409 (the password is not asked, so a refused try isn't counted).
    route('GET', '/api/me/passkeys', 'user', async ({ session }) => [200, await passkeysReply(session.user)]),
    route('POST', '/api/me/passkeys/options', 'user', async ({ session, req, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      if (body.auto === true) {
        if (await reauthNeed(session, 'add-passkey') !== 'ok') return [409, { error: 'A passkey is saved automatically only right after signing in, for the first one' }];
        return [200, await dk.autoRegistrationOptions(store, session.user, rp)];
      }
      if (body.approval) {
        if (!approvals.accepts(session.user, body.approval)) return [403, { error: 'That approval code is wrong or has expired. Create a new one on the other device.' }];
        return [200, await dk.registrationOptions(store, session.user, rp)];
      }
      const refused = await reauthRefusal(session, 'add-passkey', body.password);
      if (refused) return refused;
      return [200, await dk.registrationOptions(store, session.user, rp)];
    }),
    route('POST', '/api/me/passkeys', 'user', async ({ session, req, body }) => {
      const rp = relyingParty(req);
      if (!rp) return [400, { error: NO_PASSKEY_SITE }];
      const add = body.auto === true ? dk.addAutoPasskey : dk.addPasskey;
      const passkey = await add(store, session.user, body.response, body.name, rp);
      approvals.drop(session.user);
      logger('session').info`${session.user} added passkey "${passkey.name}" for ${rp.rpID}${body.auto === true ? ' (saved by the browser after a password sign-in)' : ''}`;
      await securityAlert(session.user, `A passkey ("${passkey.name}") was added`);
      return [201, await passkeysReply(session.user)];
    }),
    // Approving another device (needs a passkey confirmation, see STEP_UP): a one-time code that lets another session of
    // this account add a passkey without confirming with one, for 10 minutes: { code, expiresAt }. That session sends
    // it as { approval } to POST options above (5 wrong codes drop it).
    route('POST', '/api/me/passkeys/approval', 'user', async ({ session }) => {
      const out = approvals.create(session.user);
      logger('session').info`${session.user} created a code to add a passkey on another device`;
      await securityAlert(session.user, 'A code to add a passkey on another device was created');
      return [201, out];
    }),
    // Push-notification passkey approval (2-digit number match + hardware ECDSA P-256 verification on Android).
    route('POST', '/api/me/passkey-approval-requests', 'user', async ({ session, req, body }) => {
      if (await overLimit(`push-approval:${session.user}`, 5)) {
        return [429, { error: 'Too many approval requests. Try again in a few minutes.' }];
      }
      if (!modules.push.fcmEnabled()) {
        return [503, { error: 'Push approval is not available on this server.' }];
      }
      const [fcmTokens, bioKeys] = await Promise.all([
        dk.listFcmTokens(store, session.user),
        dk.listBiometricKeys(store, session.user),
      ]);
      if (!fcmTokens.length || !bioKeys.length) {
        return [409, { error: 'Push approval requires a registered Android device with notifications and biometric approval enabled.' }];
      }
      const deviceLabel = deviceLabelFrom(body.deviceLabel, req.headers['user-agent']);
      const ip = clientIp(req);
      const created = pushApprovals.create(session.user, session.tokenHash, { deviceLabel, ip });
      await modules.push.sendFcmDataToUser(session.user, {
        title: 'Approve passkey request',
        body: `${deviceLabel}${ip ? ` (${ip})` : ''} wants to add a passkey to your account.`,
        url: '/',
        tag: `passkey-approval-${created.id}`,
        data: {
          type: 'passkey_approval',
          requestId: created.id,
          deviceLabel,
          ip,
          choices: JSON.stringify(created.choices),
          expiresAt: created.expiresAt,
        },
      });
      logger('session').info`${session.user} requested push passkey approval (${deviceLabel}, ${ip})`;
      return [201, { id: created.id, numberMatch: created.numberMatch, expiresAt: created.expiresAt }];
    }),
    route('GET', '/api/me/passkey-approval-requests/pending', 'user', async ({ session }) => [
      200,
      { requests: pushApprovals.listPendingForUser(session.user) },
    ]),
    route('GET', '/api/me/passkey-approval-requests/:id', 'user', async ({ session, params }) => {
      const result = pushApprovals.getForRequester(session.user, session.tokenHash, params.id);
      if (!result) return [404, { error: 'Approval request not found' }];
      return [200, result];
    }),
    route('POST', '/api/me/passkey-approval-requests/:id/respond', 'user', async ({ session, params, body }) => {
      const decision = String(body.decision ?? '').trim().toLowerCase();
      if (decision !== 'approve' && decision !== 'deny') {
        return [400, { error: 'Decision must be "approve" or "deny"' }];
      }
      if (decision === 'deny') {
        const res = pushApprovals.deny(session.user, params.id);
        if (!res.ok) {
          if (res.status === 'not_found') return [404, { error: 'Approval request not found' }];
          return [409, { error: res.status === 'expired' ? 'Approval request has expired' : 'Approval request was already handled', status: res.status }];
        }
        logger('session').info`${session.user} denied push passkey approval request ${params.id}`;
        return [200, { ok: true, status: 'denied' }];
      }
      const pending = pushApprovals.getPending(session.user, params.id);
      if (!pending) {
        return [404, { error: 'Approval request not found, expired, or already handled' }];
      }
      const pickedNumber = Number(body.pickedNumber);
      if (!Number.isInteger(pickedNumber)) {
        return [400, { error: 'A 2-digit confirmation number is required' }];
      }
      await dk.verifyBiometricSignature(store, session.user, {
        keyId: body.biometricKeyId,
        challenge: pending.challenge,
        signature: body.signature,
      });
      if (pickedNumber !== pending.numberMatch) {
        pushApprovals.approve(session.user, params.id, pickedNumber, '');
        logger('session').warn`${session.user} chose the wrong number for push passkey approval ${params.id} (marked denied)`;
        return [403, { error: 'The selected number did not match. The request has been denied.', status: 'denied' }];
      }
      const { code } = approvals.create(session.user);
      const approved = pushApprovals.approve(session.user, params.id, pickedNumber, code);
      if (!approved.ok) {
        approvals.drop(session.user);
        return [409, { error: approved.status === 'expired' ? 'Approval request has expired' : 'Approval request was already handled', status: approved.status }];
      }
      logger('session').info`${session.user} approved push passkey request ${params.id} with hardware biometric key`;
      await securityAlert(session.user, 'A passkey addition on another device was approved via push notification');
      return [200, { ok: true, status: 'approved' }];
    }),
    route('PUT', '/api/me/passkeys/:id', 'user', async ({ session, params, body }) => {
      await dk.renamePasskey(store, session.user, params.id, body.name);
      return [200, await passkeysReply(session.user)];
    }),
    route('DELETE', '/api/me/passkeys/:id', 'user', async ({ session, params }) => {
      const refused = await reauthRefusal(session, 'remove-passkey');
      if (refused) return refused;
      if (!await dk.signInLeftWithoutPasskey(store, session.user, params.id, SSO)) {
        return [409, { error: 'This is your only way to sign in. Set a password, add another passkey or link another account first.' }];
      }
      const name = await dk.removePasskey(store, session.user, params.id);
      logger('session').info`${session.user} removed passkey "${name}"`;
      await securityAlert(session.user, `A passkey ("${name}") was removed`);
      return [200, await passkeysReply(session.user)];
    }),

    // The signed-in account's linked sign-ins: { identities: [{ provider, providerName, subject, email, linkedAt,
    // lastUsedAt }] }; DELETE unlinks one (refused when it is the only way left to sign in).
    route('GET', '/api/me/sso', 'user', async ({ session }) => [200, { identities: await dk.listIdentities(store, session.user, SSO) }]),
    route('DELETE', '/api/me/sso/:provider/:subject', 'user', async ({ session, params }) => {
      await dk.unlinkIdentity(store, session.user, { provider: params.provider, subject: params.subject }, SSO);
      const name = providerOf(params.provider)?.name || params.provider;
      await securityAlert(session.user, `Sign-in with ${name} was unlinked from your account`);
      logger('session').info`${session.user} unlinked a ${name} sign-in`;
      return [200, { identities: await dk.listIdentities(store, session.user, SSO) }];
    }),

    // Web Push subscriptions for the signed-in user (installed PWA / browser alerts).
    route('GET', '/api/me/push', 'user', async ({ session }) => [200, {
      publicKey: await modules.push.publicKey(),
      subscriptions: await dk.listPushSubscriptions(store, session.user),
    }]),
    route('POST', '/api/me/push', 'user', async ({ session, body }) => {
      await dk.savePushSubscription(store, session.user, body);
      return [200, { subscriptions: await dk.listPushSubscriptions(store, session.user) }];
    }),
    route('DELETE', '/api/me/push/:id', 'user', async ({ session, params }) => {
      await dk.deletePushSubscription(store, session.user, params.id);
      return [200, { subscriptions: await dk.listPushSubscriptions(store, session.user) }];
    }),
    route('POST', '/api/me/push/test', 'user', async ({ session }) => [200, await modules.push.sendTestPush(session.user)]),

    // Android Firebase Cloud Messaging (FCM) device tokens for the signed-in user.
    route('GET', '/api/me/fcm', 'user', async ({ session }) => [200, await fcmReply(session.user)]),
    route('POST', '/api/me/fcm', 'user', async ({ session, body }) => {
      await dk.saveFcmToken(store, session.user, body);
      return [200, await fcmReply(session.user)];
    }),
    route('POST', '/api/me/fcm/unregister', 'user', async ({ session, body }) => {
      await dk.deleteFcmToken(store, session.user, String(body.token ?? body.id ?? ''));
      return [200, await fcmReply(session.user)];
    }),
    route('DELETE', '/api/me/fcm/:id', 'user', async ({ session, params }) => {
      await dk.deleteFcmToken(store, session.user, params.id);
      return [200, await fcmReply(session.user)];
    }),
    route('POST', '/api/me/fcm/test', 'user', async ({ session }) => [200, await modules.push.sendTestFcm(session.user)]),

    // Device-bound Android Keystore ECDSA P-256 public keys for hardware-backed biometric step-up.
    route('GET', '/api/me/biometric-keys', 'user', async ({ session }) => [200, {
      keys: await dk.listBiometricKeys(store, session.user),
    }]),
    route('POST', '/api/me/biometric-keys', 'user', async ({ session, body }) => {
      const refused = await reauthRefusal(session, 'add-passkey', body.password);
      if (refused) return refused;
      const key = await dk.registerBiometricKey(store, session.user, {
        keyId: body.keyId,
        publicKeySpki: body.publicKeySpki,
        label: body.label,
      });
      logger('session').info`${session.user} registered hardware biometric key (${key.label})`;
      return [201, { key, keys: await dk.listBiometricKeys(store, session.user) }];
    }),
    route('DELETE', '/api/me/biometric-keys/:id', 'user', async ({ session, params }) => {
      await dk.deleteBiometricKey(store, session.user, params.id);
      return [200, { keys: await dk.listBiometricKeys(store, session.user) }];
    }),

    // Connected AI / MCP clients (list and revoke delegated MCP sessions).
    route('GET', '/api/me/ai-clients', 'user', async ({ session }) => [200, await aiClientsReply(session.user)]),
    route('DELETE', '/api/me/ai-clients/:id', 'user', async ({ session, params }) => {
      const revoked = await dk.revokeMcpSession(store, session.user, params.id);
      if (revoked) logger('session').info`${session.user} revoked AI client session ${params.id}`;
      return [200, await aiClientsReply(session.user)];
    }),
  ];
}
