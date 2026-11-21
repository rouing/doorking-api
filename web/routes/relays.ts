// Live relays.
import * as dk from '../../index.ts';
import { G, type Route, route } from '../routing.ts';
import type { ContextModule, Reply } from '../context.ts';
import type { EditingModule } from '../editing.ts';
import type { JobsModule } from '../jobs.ts';
import { logger } from '../../src/logging.ts';

export function relaysRoutes(deps: ContextModule & EditingModule & JobsModule): Route[] {
  const { client, commandRelays, liveRelays, prefsOf, store, withAccount } = deps;
  return [
    // Live relays: GET reads the current state (GetRelays); PUT { '0'|'1'|'2': boolean } sets relays 0-2
    // Active/Inactive (SetRelays). Active holds the gate open. PUT changes the gate immediately. Both use the gate's DKS
    // login, so they are refused (409) while a connection runs on it.
    route('GET', `${G}/relays`, 'gate', ({ gate }) => withAccount(gate, async (): Promise<Reply> => {
      try {
        const relays = await dk.checkRelays(client(), gate);
        return [200, { checkedAt: new Date(), relays: relays.map((relay) => ({ ...relay, name: '' })) }];
      } catch (err) { return [502, { error: (err as Error).message }]; }
    })),

    // Recorded in the history; not revertible (it changed the gate, not the working copy).
    route('PUT', `${G}/relays`, 'gate-admin', async ({ session, gate, body }) => {
      const desired: Record<string, boolean> = {};
      const prefs = await prefsOf(gate.phoneNumber);
      const cmd = await commandRelays(gate.phoneNumber);
      const allowed = liveRelays(cmd);
      for (const k of Object.keys(body)) {
        if (typeof body[k] !== 'boolean') continue;
        if (!allowed.includes(Number(k)) || !/^\d{1,2}$/.test(k)) {
          return [400, { error: cmd.includes(Number(k))
            ? `Relay ${k} is a Tracker command relay; use relays ${Number(k) === 1 ? '11-18' : '3-10'} instead`
            : `Relay ${k} is not available (relays 3-18 need their Tracker box on the Relays page)` }];
        }
        desired[k] = body[k];
      }
      if (!Object.keys(desired).length) return [400, { error: 'No relay states given' }];
      const labels: Record<string, string | undefined> = prefs.relayLabels || {};
      const summary = Object.entries(desired)
        .map(([k, on]) => `${labels[k] || `Relay ${k}`} ${on ? 'held open' : 'released'}`).join(', ');
      const record = async (result: string, error?: string) => {
        logger('gate')[error ? 'error' : 'info']`Gate ${gate.phoneNumber}: ${summary} by ${session.user}: ${result}${error ? ` (${error})` : ''}`;
        await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'relay', summary, result, ...(error && { error }) });
      };
      return withAccount(gate, async (): Promise<Reply> => {
        let out;
        try {
          out = await dk.controlRelays(client(), gate, desired);
        } catch (err) { await record('failed', (err as Error).message); return [502, { error: (err as Error).message }]; }
        await record('done');
        return [200, { checkedAt: new Date(), ...out }];
      });
    }),
  ];
}
