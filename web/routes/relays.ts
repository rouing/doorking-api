/**
 * @module web/routes/relays
 *
 * Live relays and timed "Safe Hold-Open" auto-release timers.
 */
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route } from '../routing.ts';
import type { Reply } from '../context.ts';
import { logger } from '../../src/logging.ts';

/**
 * Relays routes (`GET/PUT /relays`, `DELETE /relays/:relay/timer`).
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function relaysRoutes(modules: Modules): Route[] {
  const { client, prefsOf, store } = modules.context;
  const { commandRelays, liveRelays } = modules.editing;
  const { withAccount } = modules.jobs;
  const { emitWebhook } = modules.webhooks;
  return [
    // Live relays: GET reads the current state (GetRelays) plus active auto-release timers.
    // PUT { '0'|'1'|'2': boolean, holdMinutes?: 1-1440, releaseAt?: ISO } sets relays Active/Inactive (SetRelays).
    // Active holds the gate open; with holdMinutes/releaseAt, the server automatically releases when time expires.
    route('GET', `${G}/relays`, 'gate', ({ gate }) => withAccount(gate, async (): Promise<Reply> => {
      try {
        const [relays, timers] = await Promise.all([dk.checkRelays(client(), gate), dk.listRelayTimers(store, gate.phoneNumber)]);
        return [200, { checkedAt: new Date(), relays: relays.map((relay) => ({ ...relay, name: '' })), timers }];
      } catch (err) { return [502, { error: (err as Error).message }]; }
    })),

    // Recorded in the history; not revertible (it changed the gate, not the working copy).
    route('PUT', `${G}/relays`, 'gate-admin', async ({ session, gate, body }) => {
      const desired: Record<string, boolean> = {};
      const prefs = await prefsOf(gate.phoneNumber);
      const cmd = await commandRelays(gate.phoneNumber);
      const allowed = liveRelays(cmd);
      for (const key of Object.keys(body)) {
        if (typeof body[key] !== 'boolean') continue;
        if (!allowed.includes(Number(key)) || !/^\d{1,2}$/.test(key)) {
          return [400, { error: cmd.includes(Number(key))
            ? `Relay ${key} is a Tracker command relay; use relays ${Number(key) === 1 ? '11-18' : '3-10'} instead`
            : `Relay ${key} is not available (relays 3-18 need their Tracker box on the Relays page)` }];
        }
        desired[key] = body[key];
      }
      if (!Object.keys(desired).length) return [400, { error: 'No relay states given' }];
      const releaseAt = dk.parseHoldDuration({ holdMinutes: body.holdMinutes, releaseAt: body.releaseAt });
      const labels: Record<string, string | undefined> = prefs.relayLabels || {};
      const untilText = releaseAt ? ` (auto-release ${releaseAt.toLocaleTimeString('en-US')})` : '';
      const summary = Object.entries(desired)
        .map(([key, on]) => `${labels[key] || `Relay ${key}`} ${on ? `held open${untilText}` : 'released'}`).join(', ');
      const record = async (result: string, error?: string) => {
        logger('gate')[error ? 'error' : 'info']`Gate ${gate.phoneNumber}: ${summary} by ${session.user}: ${result}${error ? ` (${error})` : ''}`;
        await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'relay', summary, result, ...(error && { error }) });
      };
      return withAccount(gate, async (): Promise<Reply> => {
        let out;
        try {
          out = await dk.controlRelays(client(), gate, desired);
        } catch (err) { await record('failed', (err as Error).message); return [502, { error: (err as Error).message }]; }
        for (const [key, on] of Object.entries(desired)) {
          const relayNum = Number(key);
          if (on && releaseAt) await dk.setRelayTimer(store, gate.phoneNumber, relayNum, releaseAt, session.user);
          else await dk.clearRelayTimer(store, gate.phoneNumber, relayNum);
        }
        await record('done');
        emitWebhook(gate.phoneNumber, 'relay.changed', { actor: session.user, desired, releaseAt: releaseAt?.toISOString() || null });
        return [200, { checkedAt: new Date(), ...out, timers: await dk.listRelayTimers(store, gate.phoneNumber) }];
      });
    }),

    // Cancels an active auto-release timer without changing the physical relay state.
    route('DELETE', `${G}/relays/:relay/timer`, 'gate-admin', async ({ session, gate, params }) => {
      const relay = Number(params.relay);
      if (!Number.isInteger(relay) || relay < 0 || relay > 18) return [400, { error: 'Relay must be 0-18' }];
      const removed = await dk.clearRelayTimer(store, gate.phoneNumber, relay);
      if (!removed) return [404, { error: 'No timer set for this relay' }];
      const labels: Record<string, string | undefined> = (await prefsOf(gate.phoneNumber)).relayLabels || {};
      const summary = `Cancelled auto-release timer on ${labels[relay] || `Relay ${relay}`}`;
      logger('gate').info`Gate ${gate.phoneNumber}: ${summary} by ${session.user}`;
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'relay', summary, result: 'done' });
      return [200, { timers: await dk.listRelayTimers(store, gate.phoneNumber) }];
    }),
  ];
}
