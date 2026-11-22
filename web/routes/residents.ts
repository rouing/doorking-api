/**
 * @module web/routes/residents
 *
 * Residents and vendors in the working copy.
 */
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route } from '../routing.ts';

/**
 * Residents routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function residentsRoutes(modules: Modules): Route[] {
  const { store } = modules.context;
  const { applyToCache, dropNote, editOpts, editorResidents, saveNote, withHistory } = modules.editing;
  /**
   * A directory code with the leading zeros the gate's codes have (throws 404 when there is no working copy).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param code - Directory code, HTTP status code, or verification code.
   * @returns Computed result.
   */
  const fullCode = async (gate: { phoneNumber: string }, code: string) =>
    code.padStart(dk.namesDirDigits((await dk.readCacheFile(store, gate.phoneNumber, 'names.bin')).data), '0');
  return [
    // Residents/vendors in the working copy, keyed by directory code.
    route('GET', `${G}/residents`, 'gate', ({ gate }) => editorResidents(gate)),

    route('POST', `${G}/residents`, 'gate-admin', ({ session, gate, body }) => withHistory(session, gate,
      { summary: `Added ${body.vendor ? 'vendor' : 'resident'} ${body.directoryCode}` }, async (ctx) => {
        dk.checkName(body.name);
        const opts = await editOpts(gate);
        const { hidden: _hidden, ...fields } = body;
        const [, out] = await applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.applyShownRule(dk.addEntry(bufs, fields, opts), String(body.directoryCode ?? ''))), ctx);
        return [201, out];
      })),

    route('GET', `${G}/residents/:code`, 'gate', async ({ gate, params }) => {
      const [, list] = await editorResidents(gate);
      const want = params.code.padStart(list.dirDigits, '0');
      const row = list.rows!.find((resident) => resident.directoryCode === want);
      return row ? [200, row] : [404, { error: 'Directory code not found' }];
    }),

    route('PUT', `${G}/residents/:code`, 'gate-admin', ({ session, gate, params, body }) => withHistory(session, gate,
      { summary: `Edited directory code ${params.code}` }, async (ctx) => {
        if ('name' in body) dk.checkName(body.name);
        const opts = await editOpts(gate);
        const { hidden: _hidden, ...fields } = body;
        return applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.applyShownRule(dk.applyResidentEdit(bufs, { ...fields, directoryCode: params.code }, opts), params.code)), ctx);
      })),

    // What History recorded for a directory code, newest first: { changes: [EntryChange] }.
    route('GET', `${G}/residents/:code/history`, 'gate', async ({ gate, params }) => {
      const [, list] = await editorResidents(gate);
      return [200, { changes: await dk.entryHistory(store, gate.phoneNumber, params.code.padStart(list.dirDigits, '0')) }];
    }),

    // The local note of a directory code (never sent to the gate). Body: { note } (blank clears it).
    route('PUT', `${G}/residents/:code/note`, 'gate-admin', async ({ session, gate, params, body }) => {
      const [, list] = await editorResidents(gate);
      const want = params.code.padStart(list.dirDigits, '0');
      if (!list.rows!.some((row) => row.directoryCode === want)) return [404, { error: 'Directory code not found' }];
      return [200, { note: await saveNote(session, gate, want, body.note) }];
    }),

    // Blanks the slot (the code stays on the gate as an empty unit). The code may be sent without its leading zeros.
    route('DELETE', `${G}/residents/:code`, 'gate-admin', async ({ session, gate, params }) => {
      const code = await fullCode(gate, params.code);
      return dropNote(session, gate, code, await withHistory(session, gate, { summary: `Deleted the entry at directory code ${code}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.deleteResident(bufs, code)), ctx)));
    }),

    // Takes the directory code off the gate entirely.
    route('DELETE', `${G}/directory-codes/:code`, 'gate-admin', async ({ session, gate, params }) => {
      const code = await fullCode(gate, params.code);
      return dropNote(session, gate, code, await withHistory(session, gate, { summary: `Removed directory code ${code}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.removeDirectoryCode(bufs, code)), ctx)));
    }),

    // "Num of Digits in Dir Code". Decreasing wipes all resident data, so it needs confirm: true.
    route('PUT', `${G}/dir-digits`, 'gate-admin', async ({ session, gate, body }) => {
      const from = dk.namesDirDigits((await dk.readCacheFile(store, gate.phoneNumber, 'names.bin')).data);
      if (Number(body.digits) < from && body.confirm !== true) {
        return [400, { error: 'Decreasing the directory code digits destroys all resident data; confirm is required' }];
      }
      return withHistory(session, gate, { summary: `Changed directory code digits from ${from} to ${body.digits}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.convertDirDigits(bufs, body.digits), ctx));
    }),
  ];
}
