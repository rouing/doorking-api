// Scheduled transfers.
import * as dk from '../../index.ts';
import { G, type Route, route } from '../routing.ts';
import type { ContextModule } from '../context.ts';
import type { JobsModule } from '../jobs.ts';
import { logger } from '../../src/logging.ts';

export function schedulesRoutes(deps: ContextModule & JobsModule): Route[] {
  const { isScheduleQueued, queueSchedule, scheduleText, store } = deps;
  return [
    // Scheduled transfers for this gate, run with the gate's DKS login; saving an entry makes the user its owner
    // (shown as "Saved by"). Body: { days: [0-6], time: 'HH:MM', actions: ['send'|'residents'|'transactions'|'snapshots'], enabled }.
    route('GET', `${G}/schedules`, 'gate', async ({ gate }) => [200, {
      schedules: (await dk.listSchedules(store, gate.phoneNumber)).map((x) => ({ ...x, queued: isScheduleQueued(x.id) })),
    }]),

    route('POST', `${G}/schedules`, 'gate-admin', async ({ session, gate, body }) => {
      const out = await dk.saveSchedule(store, gate.phoneNumber, session.user, body);
      logger('schedule').info`Gate ${gate.phoneNumber}: schedule ${out!.id} added by ${session.user} (${scheduleText(out!)})`;
      return [201, out];
    }),

    route('PUT', `${G}/schedules/:id`, 'gate-admin', async ({ session, gate, params, body }) => {
      const out = await dk.saveSchedule(store, gate.phoneNumber, session.user, body, params.id);
      logger('schedule').info`Gate ${gate.phoneNumber}: schedule ${params.id} changed by ${session.user} (${scheduleText(out!)})`;
      return [200, out];
    }),

    route('DELETE', `${G}/schedules/:id`, 'gate-admin', async ({ session, gate, params }) => {
      await dk.deleteSchedule(store, gate.phoneNumber, params.id);
      logger('schedule').info`Gate ${gate.phoneNumber}: schedule ${params.id} deleted by ${session.user}`;
      return [200, { ok: true }];
    }),

    // Queues the entry to run now (after any running gate connection on its DKS login); its next scheduled time is unchanged.
    route('POST', `${G}/schedules/:id/run`, 'gate-admin', async ({ session, gate, params }) => {
      const sch = await dk.getSchedule(store, gate.phoneNumber, params.id);
      if (!sch) return [404, { error: 'Schedule not found' }];
      if (!await queueSchedule(sch)) return [409, { error: 'This schedule is already queued' }];
      logger('schedule').info`Gate ${gate.phoneNumber}: schedule ${sch.id} queued to run now by ${session.user}`;
      return [202, { ok: true }];
    }),
  ];
}
