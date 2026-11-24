/**
 * @module web/routes/gates
 *
 * Gates a user can open: adding, leaving, DKS login, gate users and API keys.
 */
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route, webOnly } from '../routing.ts';
import type { Gate, Reply } from '../context.ts';
import { logger } from '../../src/logging.ts';

/**
 * Gates routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function gatesRoutes(modules: Modules): Route[] {
  const { APP, asGate, client, gateFor, gateInfo, mailer, NO_EMAIL, objectField, store } = modules.context;
  const { accessEmail, gateName, sendInvite, sendVerification } = modules.mail;
  const { gateConfigFrom } = modules.editing;
  const { accountBusy, addingJobOf, busy, currentJob, roleText, startLoginCheck, startPull } = modules.jobs;
  /**
   * Asks DKS Cloud whether a DKS login works: null when it does, else the reply to send (502: DKS Cloud failed).
   *
   * @param dksUser - DKS Cloud account username.
   * @param dksPassword - DKS Cloud account password.
   * @returns Promise resolving to `Reply | null`.
   */
  async function dksLoginRefusal(dksUser: string, dksPassword: string): Promise<Reply | null> {
    let reply;
    try { reply = String(await client().checkLogin(dksUser, dksPassword)).trim(); } catch (err) {
      return [502, { error: `DKS Cloud: ${(err as Error).message}` }];
    }
    return reply === 'OK' ? null : [400, { error: `DKS Cloud refused that DKS user and password: ${reply || 'no reply'}` }];
  }

  return [
    // The gate the web UI has open (restored on page reload). API clients can ignore it.
    route('PUT', '/api/session/gate', 'user', async ({ session, body }) => {
      const gate = await gateFor(session, dk.checkPhone(body.phoneNumber));
      if (session.gate !== gate.phoneNumber) logger('session').info`${session.user} opened gate ${gate.phoneNumber}`;
      await dk.setSessionGate(store, session.tokenHash, gate.phoneNumber);
      return [200, { gate: await gateInfo(gate) }];
    }),

    route('DELETE', '/api/session/gate', 'user', async ({ session }) => { await dk.setSessionGate(store, session.tokenHash, null); return [200, { ok: true }]; }),

    // The gates the signed-in user may open, with their role (never master codes or DKS logins).
    route('GET', '/api/gates', 'user', async ({ session }) => [200, { gates: await Promise.all((await dk.userGates(store, session.user)).map(gateInfo)) }]),

    // Adds a gate: { phoneNumber, masterCode, dksUser, dksPassword, gateConfig }. Refused (409) when it is managed here
    // already. The DKS login is checked first, then a residents pull with these values runs; only when it succeeds is
    // the gate saved, with the user as its admin. Progress: GET /api/gate-add.
    route('POST', '/api/gates', 'user', async ({ session, body }) => {
      const phoneNumber = dk.checkPhone(body.phoneNumber);
      const masterCode = dk.checkMasterCode(body.masterCode);
      const dksUser = String(body.dksUser || '').trim();
      const dksPassword = String(body.dksPassword || '');
      if (!dksUser || !dksPassword) return [400, { error: 'The gate\'s DKS user and password are required' }];
      const gateConfig = gateConfigFrom(objectField(body, 'gateConfig') || {});
      if (await dk.gateExists(store, phoneNumber)) return [409, { error: dk.ALREADY_ADDED }];
      const adding = asGate({ phoneNumber, masterCode, dksUser, dksPassword, addedBy: session.user, addedAt: new Date().toISOString() }, 'admin', session.user);
      if (accountBusy(adding)) return [409, { error: 'A gate connection is running with this DKS login. Try again when it finishes.' }];
      const refused = await dksLoginRefusal(dksUser, dksPassword);
      if (refused) return refused;
      if (await dk.gateExists(store, phoneNumber)) return [409, { error: dk.ALREADY_ADDED }];
      // Checked and claimed with nothing in between, so two adds at once can't both start.
      if (accountBusy(adding) || currentJob(phoneNumber).state === 'running') return [409, { error: 'Try again in a moment.' }];
      logger('gates').info`${session.user} is adding gate ${phoneNumber}`;
      startPull(adding, 'residents', { adding: true }, { prepare: () => dk.setPrefs(store, phoneNumber, { gateConfig }) });
      return [202, { ok: true }];
    }),

    // The connection that checks the gate the user is adding (or the last one, once finished): { job } or { job: null }.
    route('GET', '/api/gate-add', 'user', ({ session }) => {
      const found = addingJobOf(session.user);
      if (!found) return [200, { job: null }];
      const { account, ...job } = found; // account: the DKS login
      return [200, { job }];
    }),

    route('GET', G, 'gate', async ({ gate }) => [200, await gateInfo(gate)]),

    // Leaves the gate (removes the user's own access). The last admin can't leave.
    webOnly(route('DELETE', G, 'gate', async ({ session, gate }) => {
      await dk.revokeAccess(store, gate.phoneNumber, session.user);
      if (session.gate === gate.phoneNumber) await dk.setSessionGate(store, session.tokenHash, null);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'access', summary: `${session.user} left the gate` });
      logger('gates').info`${session.user} left gate ${gate.phoneNumber}`;
      return [200, { ok: true }];
    })),

    // The gate's DKS login: GET { dksUser, dksPasswordSet }. PUT { dksUser?, dksPassword? (blank keeps), masterCode? }:
    // a new DKS login is checked with DKS Cloud and saved at once (200); a new master code is checked by a residents
    // pull and saved only when it succeeds (202; progress via G/job).
    webOnly(route('GET', `${G}/login`, 'gate-admin', ({ gate }) => [200, { dksUser: gate.dksUser, dksPasswordSet: Boolean(gate.dksPassword) }])),
    webOnly(route('PUT', `${G}/login`, 'gate-admin', async ({ session, gate, body }) => {
      const dksUser = body.dksUser === undefined ? gate.dksUser : String(body.dksUser).trim();
      const dksPassword = body.dksPassword ? String(body.dksPassword) : gate.dksPassword;
      const masterCode = body.masterCode ? dk.checkMasterCode(body.masterCode) : gate.masterCode;
      if (!dksUser || !dksPassword) return [400, { error: 'The gate\'s DKS user and password are required' }];
      const loginChanged = dksUser !== gate.dksUser || dksPassword !== gate.dksPassword;
      if (loginChanged) {
        const refused = await dksLoginRefusal(dksUser, dksPassword);
        if (refused) return refused;
      }
      if (masterCode === gate.masterCode) {
        if (!loginChanged) return [200, { dksUser, dksPasswordSet: true, changed: false }];
        await dk.updateGateLogin(store, gate.phoneNumber, { dksUser, dksPassword });
        await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'login', summary: 'Changed the gate\'s DKS login' });
        logger('gates').info`${session.user} changed the DKS login of gate ${gate.phoneNumber}`;
        return [200, { dksUser, dksPasswordSet: true, changed: true }];
      }
      const trial: Gate = { ...gate, masterCode, dksUser, dksPassword, user: dksUser, password: dksPassword };
      return busy(trial) || (startLoginCheck(trial), [202, { checking: true }]);
    })),

    // Gate users (admins only): GET the list; POST { username, password, role } creates an account with access to this
    // gate (409 { exists: true } when the username is taken: share instead); POST share { username, role } gives an
    // existing account access; PUT { role } changes a role; DELETE takes the user off this gate. A gate always keeps
    // at least one admin.
    webOnly(route('GET', `${G}/users`, 'gate-admin', async ({ gate }) => [200, { users: await dk.gateUsers(store, gate.phoneNumber) }])),
    webOnly(route('POST', `${G}/users`, 'gate-admin', async ({ session, gate, body }) => {
      const role = dk.checkRole(body.role || 'readonly');
      if (await dk.getUser(store, String(body.username ?? ''))) {
        return [409, { error: `The username "${dk.userKey(body.username)}" already exists. Share this gate with them instead.`, exists: true }];
      }
      /**
       * With an email (and email set up) and no password: an invitation link; otherwise a temporary password (and a
       * confirmation link to the email, if one is given).
       */
      const invite = Boolean(mailer && body.email && !body.password);
      const user = await dk.createUser(store, { username: body.username, password: body.password, email: body.email, createdBy: session.user, invite });
      await dk.grantAccess(store, gate.phoneNumber, user.username, role, session.user);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'access', summary: `${invite ? 'Invited' : 'Created'} user ${user.username} (${roleText(role)})` });
      logger('gates').info`${session.user} ${invite ? 'invited' : 'created'} user ${user.username} with ${role} access to gate ${gate.phoneNumber}`;
      try {
        await (invite ? sendInvite(user.username, session.user, gate.phoneNumber) : sendVerification(user.username));
      } catch (err) {
        return [502, { error: `Account ${user.username} was created, but ${(err as Error).message.replace(/^The/, 'the')}${invite ? ' Use Send again in the list.' : ''}`,
          users: await dk.gateUsers(store, gate.phoneNumber) }];
      }
      return [201, { users: await dk.gateUsers(store, gate.phoneNumber), invited: invite }];
    })),
    // Sends a user's invitation again (new link; the old one stops working).
    webOnly(route('POST', `${G}/users/:username/invite`, 'gate-admin', async ({ session, gate, params }) => {
      if (!mailer) return [503, { error: NO_EMAIL }];
      const user = await dk.getUser(store, params.username);
      if (!user || !await dk.accessOf(store, gate.phoneNumber, user.username)) return [404, { error: `"${dk.userKey(params.username)}" has no access to this gate` }];
      if (!user.invited) return [409, { error: `${user.username} has already accepted their invitation` }];
      await sendInvite(user.username, session.user, gate.phoneNumber);
      return [200, { users: await dk.gateUsers(store, gate.phoneNumber) }];
    })),
    webOnly(route('POST', `${G}/share`, 'gate-admin', async ({ session, gate, body }) => {
      const role = dk.checkRole(body.role || 'readonly');
      await dk.grantAccess(store, gate.phoneNumber, String(body.username ?? ''), role, session.user);
      const name = await gateName(gate.phoneNumber);
      await accessEmail(dk.userKey(body.username), (user) => dk.messages.accessGranted(APP, user.username, session.user, name, roleText(role)));
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'access', summary: `Shared the gate with ${dk.userKey(body.username)} (${roleText(role)})` });
      logger('gates').info`${session.user} shared gate ${gate.phoneNumber} with ${dk.userKey(body.username)} (${role})`;
      return [200, { users: await dk.gateUsers(store, gate.phoneNumber) }];
    })),
    webOnly(route('PUT', `${G}/users/:username`, 'gate-admin', async ({ session, gate, params, body }) => {
      const role = dk.checkRole(body.role);
      await dk.setRole(store, gate.phoneNumber, params.username, role);
      const name = await gateName(gate.phoneNumber);
      if (dk.userKey(params.username) !== session.user) await accessEmail(dk.userKey(params.username), (user) => dk.messages.roleChanged(APP, user.username, session.user, name, roleText(role)));
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'access', summary: `Changed ${dk.userKey(params.username)} to ${roleText(role)}` });
      return [200, { users: await dk.gateUsers(store, gate.phoneNumber) }];
    })),
    webOnly(route('DELETE', `${G}/users/:username`, 'gate-admin', async ({ session, gate, params }) => {
      await dk.revokeAccess(store, gate.phoneNumber, params.username);
      const name = await gateName(gate.phoneNumber);
      if (dk.userKey(params.username) !== session.user) await accessEmail(dk.userKey(params.username), (user) => dk.messages.accessRemoved(user.username, session.user, name));
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'access', summary: `Removed ${dk.userKey(params.username)} from the gate` });
      logger('gates').info`${session.user} removed ${dk.userKey(params.username)} from gate ${gate.phoneNumber}`;
      return [200, { users: await dk.gateUsers(store, gate.phoneNumber) }];
    })),

    // API keys of this gate (admins, web only): GET the list (never the keys); POST { name, role, expiresDays (0 never,
    // 30, 90, 365) } creates one and returns it once as `key`; DELETE revokes one at once.
    webOnly(route('GET', `${G}/api-keys`, 'gate-admin', async ({ gate }) => [200, { apiKeys: await dk.listApiKeys(store, gate.phoneNumber) }])),
    webOnly(route('POST', `${G}/api-keys`, 'gate-admin', async ({ session, gate, body }) => {
      const out = await dk.createApiKey(store, gate.phoneNumber, { name: body.name, role: body.role || 'readonly', expiresDays: body.expiresDays, scopes: body.scopes }, session.user);
      const scopeSuffix = out.apiKey.scopes ? `, scopes: ${out.apiKey.scopes.join(', ')}` : '';
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'apikey', summary: `Created API key "${out.apiKey.name}" (${roleText(out.apiKey.role)}${scopeSuffix})` });
      logger('api').info`Gate ${gate.phoneNumber}: API key ${out.apiKey.id} "${out.apiKey.name}" (${out.apiKey.role}${scopeSuffix}) created by ${session.user}`;
      return [201, out];
    })),
    webOnly(route('DELETE', `${G}/api-keys/:id`, 'gate-admin', async ({ session, gate, params }) => {
      const name = await dk.revokeApiKey(store, gate.phoneNumber, params.id);
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'apikey', summary: `Revoked API key "${name}"` });
      logger('api').info`Gate ${gate.phoneNumber}: API key ${params.id} "${name}" revoked by ${session.user}`;
      return [200, { apiKeys: await dk.listApiKeys(store, gate.phoneNumber) }];
    })),
  ];
}
