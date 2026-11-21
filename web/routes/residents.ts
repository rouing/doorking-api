// Residents and vendors in the working copy.
import * as dk from '../../index.ts';
import { G, type Route, route } from '../routing.ts';
import type { ContextModule } from '../context.ts';
import type { EditingModule } from '../editing.ts';

export function residentsRoutes(deps: ContextModule & EditingModule): Route[] {
  const { applyToCache, dropNote, editOpts, editorResidents, saveNote, store, withHistory } = deps;
  return [
    // Residents/vendors in the working copy, keyed by directory code.
    route('GET', `${G}/residents`, 'gate', ({ gate }) => editorResidents(gate)),

    route('POST', `${G}/residents`, 'gate-admin', ({ session, gate, body }) => withHistory(session, gate,
      { summary: `Added ${body.vendor ? 'vendor' : 'resident'} ${body.directoryCode}` }, async (ctx) => {
        dk.checkName(body.name);
        const opts = await editOpts(gate);
        const { hidden: _hidden, ...fields } = body;
        const [, out] = await applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.applyShownRule(dk.addEntry(bufs, fields, opts), body.directoryCode)), ctx);
        return [201, out];
      })),

    route('GET', `${G}/residents/:code`, 'gate', async ({ gate, params }) => {
      const [, list] = await editorResidents(gate);
      const want = params.code.padStart(list.dirDigits, '0');
      const row = list.rows!.find((r) => r.directoryCode === want);
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

    // Blanks the slot (the code stays on the gate as an empty unit).
    route('DELETE', `${G}/residents/:code`, 'gate-admin', async ({ session, gate, params }) => dropNote(session, gate, params.code, await withHistory(session, gate,
      { summary: `Deleted the entry at directory code ${params.code}` }, (ctx) => applyToCache(gate.phoneNumber,
        (bufs) => dk.tidyBoard(dk.deleteResident(bufs, params.code)), ctx)))),

    // Takes the directory code off the gate entirely.
    route('DELETE', `${G}/directory-codes/:code`, 'gate-admin', async ({ session, gate, params }) => dropNote(session, gate, params.code, await withHistory(session, gate,
      { summary: `Removed directory code ${params.code}` }, (ctx) => applyToCache(gate.phoneNumber,
        (bufs) => dk.tidyBoard(dk.removeDirectoryCode(bufs, params.code)), ctx)))),

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
