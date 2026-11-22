/**
 * @module web/routes/connections
 *
 * Gate connections (pull, send, login check) and the pulled data views.
 */
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route } from '../routing.ts';

/**
 * Connections routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function connectionsRoutes(modules: Modules): Route[] {
  const { gateData, TX_PAGE, TX_PAGE_MAX } = modules.editing;
  const { accountBusy, busy, currentJob, prepareGateSend, startPull, startSend } = modules.jobs;
  return [
    // The gate's current or last connection (one at a time per DKS account). While another gate on the same DKS login
    // has one running, an idle gate shows busyElsewhere.
    route('GET', `${G}/job`, 'gate', ({ gate }) => {
      const { account, ...job } = currentJob(gate.phoneNumber); // account: the DKS login, admin-only
      return [200, job.state !== 'idle' && !job.adding ? job : { state: 'idle', log: [], busyElsewhere: accountBusy(gate) }];
    }),

    route('POST', `${G}/pull`, 'gate', ({ gate, body }) => {
      const what = body.what as dk.PullKind;
      if (!dk.PULL_FILES[what]) return [400, { error: 'what must be transactions or residents' }];
      return busy(gate) || (startPull(gate, what), [202, { ok: true }]);
    }),

    route('GET', `${G}/send`, 'gate', async ({ gate }) => {
      const { changedBlocks, counts } = await prepareGateSend(gate);
      return [200, { changedBlocks, residentCounts: counts }];
    }),

    route('POST', `${G}/send`, 'gate-admin', async ({ gate, body }) => {
      if (body.confirm !== true) return [400, { error: 'Send must be confirmed' }];
      const prepared = await prepareGateSend(gate);
      return busy(gate) || (startSend(gate, prepared), [202, { ok: true }]);
    }),

    // Transactions and settings views from the pulled files.
    // ?limit= (default TX_PAGE, at most TX_PAGE_MAX) newest transactions, ?before= the previous reply's transactions.next.
    route('GET', `${G}/data`, 'gate', async ({ gate, req }) => {
      const query = req.query as Record<string, string | undefined>;
      const limit = query.limit !== undefined ? Number(query.limit) : TX_PAGE;
      const before = query.before !== undefined ? Number(query.before) : undefined;
      if (!Number.isInteger(limit) || limit < 1 || limit > TX_PAGE_MAX || (before !== undefined && !(Number.isInteger(before) && before >= 1 && before <= 2147483647))) {
        return [400, { error: `limit must be 1-${TX_PAGE_MAX} and before a positive whole number` }];
      }
      return [200, await gateData(gate.phoneNumber, { before, limit })];
    }),
  ];
}
