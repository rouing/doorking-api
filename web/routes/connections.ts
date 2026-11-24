/**
 * @module web/routes/connections
 *
 * Gate connections (pull, send, login check) and the pulled data views.
 */
import { z } from 'zod';
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, parseInput, type Route, route } from '../routing.ts';

/**
 * Connections routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function connectionsRoutes(modules: Modules): Route[] {
  const { store } = modules.context;
  const { gateData, TX_PAGE, TX_PAGE_MAX, workingCopyDiff } = modules.editing;
  const { accountBusy, busy, currentJob, prepareGateSend, startPull, startSend } = modules.jobs;
  return [
    // The gate's current or last connection (one at a time per DKS account). While another gate on the same DKS login
    // has one running, an idle gate shows busyElsewhere.
    route('GET', `${G}/job`, 'gate', ({ gate }) => {
      const { account, ...job } = currentJob(gate.phoneNumber); // account: the DKS login, admin-only
      return [200, job.state !== 'idle' && !job.adding ? job : { state: 'idle', log: [], busyElsewhere: accountBusy(gate) }];
    }),

    route('POST', `${G}/pull`, 'gate', ({ gate, body }) => {
      const { what } = parseInput(
        z.object({ what: z.enum(['transactions', 'residents'], { message: 'what must be transactions or residents' }) }),
        body,
      );
      return busy(gate) || (startPull(gate, what), [202, { ok: true }]);
    }),

    route('GET', `${G}/send`, 'gate', async ({ gate }) => {
      const [{ changedBlocks, counts }, changes] = await Promise.all([prepareGateSend(gate), workingCopyDiff(gate.phoneNumber)]);
      return [200, { changedBlocks, residentCounts: counts, changes }];
    }),

    route('POST', `${G}/send`, 'gate-admin', async ({ gate, body }) => {
      parseInput(z.object({ confirm: z.literal(true, { message: 'Send must be confirmed' }) }), body);
      const prepared = await prepareGateSend(gate);
      return busy(gate) || (startSend(gate, prepared), [202, { ok: true }]);
    }),

    // Transactions and settings views from the pulled files.
    // ?limit= (default TX_PAGE, at most TX_PAGE_MAX) newest transactions, ?before= the previous reply's transactions.next.
    route('GET', `${G}/data`, 'gate', async ({ gate, req }) => {
      const query = req.query as Record<string, string | undefined>;
      const dataQuerySchema = z.object({
        limit: z.preprocess(
          (v) => (v === undefined ? TX_PAGE : Number(v)),
          z.number().int().min(1).max(TX_PAGE_MAX),
        ),
        before: z.preprocess(
          (v) => (v === undefined ? undefined : Number(v)),
          z.number().int().min(1).max(2147483647).optional(),
        ),
      });
      const parsed = dataQuerySchema.safeParse(query);
      if (!parsed.success) return [400, { error: `limit must be 1-${TX_PAGE_MAX} and before a positive whole number` }];
      return [200, await gateData(gate.phoneNumber, parsed.data)];
    }),

    // Access hygiene & traffic audit over the last ?days= (1-730, default 90).
    route('GET', `${G}/audit`, 'gate', async ({ gate, req }) => {
      const query = req.query as Record<string, string | undefined>;
      const { days } = parseInput(
        z.object({
          days: z.preprocess(
            (v) => (v === undefined ? 90 : Number(v)),
            z.number({ message: 'days must be 1-730' }).int('days must be 1-730').min(1, 'days must be 1-730').max(730, 'days must be 1-730'),
          ),
        }),
        query,
      );
      return [200, await dk.buildAccessAudit(store, gate.phoneNumber, { days })];
    }),
  ];
}
