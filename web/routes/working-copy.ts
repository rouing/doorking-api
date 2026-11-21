// Gate settings, the working copy itself, preferences, History and deleting stored data.
import fs from 'node:fs';
import * as dk from '../../index.ts';
import type { GatePrefs } from '../../src/types.ts';
import { G, type Route, route, webOnly } from '../routing.ts';
import type { ContextModule } from '../context.ts';
import type { EditingModule } from '../editing.ts';
import type { JobsModule } from '../jobs.ts';
import type { SnapshotsModule } from '../snapshots.ts';
import { logger } from '../../src/logging.ts';

export function workingCopyRoutes(deps: ContextModule & EditingModule & JobsModule & SnapshotsModule): Route[] {
  const { commandRelays, currentJob, dropQueuedSchedules, forgetJob, gateSettings, logChange, pick, PREF_LABELS, prefsOf, revertEvent, same, savePrefs, scheduleRunningFor, saveSettings, sendFile, serial, snapRuns, store, withHistory, workingBuffers } = deps;
  return [
    // Gate settings in the working copy's names.bin. PUT body: { <field key>: value, ... }.
    route('GET', `${G}/settings`, 'gate', ({ gate }) => gateSettings(gate.phoneNumber)),
    route('PUT', `${G}/settings`, 'gate-admin', ({ session, gate, body }) => withHistory(session, gate,
      { summary: 'Changed gate settings' }, async () => saveSettings(gate, body, await commandRelays(gate.phoneNumber)))),

    // The working copy: status (with the conflicts to decide), reset to the gate (drops unsent changes), deciding a
    // conflict ({ kind: resident|card|setting, key, choice: mine|gate }), and file downloads (.bin / .map).
    route('GET', `${G}/working-copy`, 'gate', async ({ gate }) => [200, await dk.cacheStatus(store, gate.phoneNumber)]),
    route('DELETE', `${G}/working-copy`, 'gate-admin', ({ session, gate }) => withHistory(session, gate,
      { summary: 'Reset the working copy to the gate (unsent changes dropped)' }, async () => [200, await dk.resetCache(store, gate.phoneNumber)])),
    route('POST', `${G}/working-copy/conflicts`, 'gate-admin', ({ session, gate, body }) => withHistory(session, gate,
      { summary: `${body.choice === 'gate' ? 'Took the gate\'s value' : 'Kept my change'} for a conflict (${String(body.kind)} ${String(body.key)})` },
      async () => [200, await dk.resolveConflict(store, gate.phoneNumber, body.kind, body.key, body.choice)])),
    route('GET', `${G}/files/:name`, 'gate-admin', async ({ gate, params, res }) => { await sendFile(res, gate.phoneNumber, params.name); }),

    // Gate-scoped local preferences (relay labels, Device Association, gate config), keyed by phone number.
    route('GET', `${G}/prefs`, 'gate', async ({ gate }) => [200, await prefsOf(gate.phoneNumber)]),

    // Changing the area-code setting also converts the working copy; both are one history entry.
    route('PUT', `${G}/prefs`, 'gate-admin', ({ session, gate, body }) => serial(gate.phoneNumber, async () => {
      const saved = await prefsOf(gate.phoneNumber);
      const before = await workingBuffers(gate.phoneNumber);
      const was: Record<string, unknown> = { ...saved };
      const out = await savePrefs(gate, body, saved);
      if (out[0] < 300) {
        const merged: Record<string, unknown> = { ...(out[1] as GatePrefs) };
        const keys = Object.keys(PREF_LABELS).filter((k) => !same(was[k], merged[k]));
        const prefs = keys.length ? { before: pick(was, keys), after: pick(merged, keys) } : null;
        const summary = `Changed ${keys.map((k) => PREF_LABELS[k]).join(', ') || PREF_LABELS.gateConfig}`;
        await logChange(session, gate, { summary }, before, prefs);
      }
      return out;
    })),

    // History: this gate's events (newest first) and the gate's users with their last sign-in.
    route('GET', `${G}/history`, 'gate', async ({ gate }) => [200, {
      events: await dk.listHistory(store, gate.phoneNumber), users: await dk.gateUsers(store, gate.phoneNumber),
    }]),
    route('POST', `${G}/history/:id/revert`, 'gate-admin', ({ session, gate, params }) => serial(gate.phoneNumber, () => revertEvent(session, gate, params.id))),

    // Deletes everything stored about the gate: its database rows (every user's gate-list entry, prefs, history,
    // schedules, camera settings, snapshot log, notes, transaction history) and its folder (pulled files, working
    // copy, camera pictures). Nothing on the gate changes. Body: { confirm: true }.
    webOnly(route('POST', `${G}/delete-data`, 'gate-admin', async ({ session, gate, body }) => {
      if (body.confirm !== true) return [400, { error: 'Deleting the gate\'s data must be confirmed' }];
      if (currentJob(gate.phoneNumber).state === 'running') return [409, { error: 'Wait for the gate connection to finish' }];
      if (snapRuns.get(gate.phoneNumber)?.state === 'running') return [409, { error: 'Stop the snapshot run first' }];
      if (scheduleRunningFor(gate.phoneNumber)) return [409, { error: 'Wait for the scheduled transfer to finish' }];
      dropQueuedSchedules(gate.phoneNumber);
      const removed = await dk.deleteGateData(store, gate.phoneNumber);
      snapRuns.delete(gate.phoneNumber);
      forgetJob(gate.phoneNumber);
      let files = '';
      try { fs.rmSync(gate.dir, { recursive: true, force: true }); } catch (err) { files = (err as Error).message; }
      logger('gates')[files ? 'warn' : 'info']`${session.user} deleted all stored data of gate ${gate.phoneNumber}: ${JSON.stringify(removed)}${files ? `; files not all deleted: ${files}` : ''}`;
      return [200, { removed, ...(files && { filesError: files }) }];
    })),
  ];
}
