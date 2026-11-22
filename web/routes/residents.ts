/**
 * @module web/routes/residents
 *
 * Residents and vendors in the working copy: single CRUD, bulk actions, and CSV import with dry-run preview.
 */
import * as dk from '../../index.ts';
import type { BoardBuffers, ResidentEdit } from '../../src/residents-edit.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route } from '../routing.ts';

const MAX_BULK = 500;

/**
 * Residents routes (`GET/POST/PUT/DELETE /residents`, `/directory-codes`, `/dir-digits`, `/residents/bulk`, `/residents/import`).
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function residentsRoutes(modules: Modules): Route[] {
  const { store } = modules.context;
  const { applyToCache, changeDetails, dropNote, editOpts, editorResidents, saveNote, withHistory, workingBuffers } = modules.editing;
  /**
   * Pads a directory code to the gate's configured digit count (throws 404 when there is no working copy).
   *
   * @param gate - Gate phone identifier.
   * @param code - Directory code string.
   * @returns Padded directory code.
   */
  const fullCode = async (gate: { phoneNumber: string }, code: string) =>
    code.padStart(dk.namesDirDigits((await dk.readCacheFile(store, gate.phoneNumber, 'names.bin')).data), '0');

  return [
    // Residents/vendors in the working copy, keyed by directory code.
    route('GET', `${G}/residents`, 'gate', ({ gate }) => editorResidents(gate)),

    route('POST', `${G}/residents`, 'gate-editor', ({ session, gate, body }) => withHistory(session, gate,
      { summary: `Added ${body.vendor ? 'vendor' : 'resident'} ${body.directoryCode}` }, async (ctx) => {
        dk.checkName(body.name);
        const opts = await editOpts(gate);
        const { hidden: _hidden, ...fields } = body;
        const [, out] = await applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.applyShownRule(dk.addEntry(bufs, fields, opts), String(body.directoryCode ?? ''))), ctx);
        return [201, out];
      })),

    // Bulk action on selected directory codes in one History entry and one tidyBoard pass.
    // Body: { action: 'setSecurityLevel' | 'delete' | 'removeCode', codes: string[], securityLevel?: number }.
    route('POST', `${G}/residents/bulk`, 'gate-editor', async ({ session, gate, body }) => {
      const action = String(body.action || '');
      if (!['setSecurityLevel', 'delete', 'removeCode'].includes(action)) {
        return [400, { error: 'action must be setSecurityLevel, delete or removeCode' }];
      }
      if (!Array.isArray(body.codes) || !body.codes.length || body.codes.length > MAX_BULK) {
        return [400, { error: `codes must be a list of 1-${MAX_BULK} directory codes` }];
      }
      const digits = dk.namesDirDigits((await dk.readCacheFile(store, gate.phoneNumber, 'names.bin')).data);
      const codes = [...new Set(body.codes.map((c) => String(c ?? '').trim().padStart(digits, '0')))];
      const level = action === 'setSecurityLevel' ? Number(body.securityLevel) : undefined;
      if (action === 'setSecurityLevel' && (!Number.isInteger(level) || level! < 0 || level! > 30)) {
        return [400, { error: 'securityLevel must be a whole number from 0 to 30' }];
      }
      const summary = action === 'setSecurityLevel'
        ? `Bulk set security level ${level} on ${codes.length} entries`
        : action === 'delete' ? `Bulk deleted ${codes.length} entries` : `Bulk removed ${codes.length} directory codes`;
      const out = await withHistory(session, gate, { summary }, async (ctx) => {
        const opts = await editOpts(gate);
        const [, saved] = await applyToCache(gate.phoneNumber, (bufs) => {
          let cur = bufs;
          for (const code of codes) {
            if (action === 'setSecurityLevel') cur = dk.applyResidentEdit(cur, { directoryCode: code, securityLevel: level }, opts);
            else if (action === 'delete') cur = dk.deleteResident(cur, code);
            else cur = dk.removeDirectoryCode(cur, code);
          }
          return dk.tidyBoard(cur);
        }, ctx);
        return [200, { action, count: codes.length, ...(saved as object) }];
      });
      if (out[0] < 300 && (action === 'delete' || action === 'removeCode')) {
        for (const code of codes) await dropNote(session, gate, code, out);
      }
      return out;
    }),

    // Bulk CSV / JSON import of residents/vendors: { rows: [...], dryRun?: boolean }.
    // dryRun previews added/updated/errors and From -> To changes without saving anything.
    route('POST', `${G}/residents/import`, 'gate-editor', async ({ session, gate, body }) => {
      if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_BULK) {
        return [400, { error: `rows must be a list of 1-${MAX_BULK} entries` }];
      }
      const dryRun = body.dryRun === true;
      const before = await workingBuffers(gate.phoneNumber);
      if (!before) return [404, { error: 'There is no working copy. Pull residents from the gate.' }];
      const opts = await editOpts(gate);
      const digits = dk.namesDirDigits(before.names);
      const existing = new Set(dk.residentRows(before).rows.filter((r) => r.name || r.phone || r.entryCode || r.cards.length).map((r) => r.directoryCode));
      let simulated: BoardBuffers = { names: Buffer.from(before.names), phone: Buffer.from(before.phone), cards: Buffer.from(before.cards) };
      let added = 0;
      let updated = 0;
      const errors: { row: number; directoryCode: string; error: string }[] = [];
      const notesToSave: [string, string][] = [];

      for (const [index, raw] of body.rows.entries()) {
        const item = (raw && typeof raw === 'object' ? raw : {}) as ResidentEdit & { note?: unknown };
        const rawCode = String(item.directoryCode ?? '').trim();
        const code = rawCode ? rawCode.padStart(digits, '0') : '';
        try {
          if (!code) throw dk.httpError('Directory code is required');
          if ('name' in item) dk.checkName(item.name);
          const { hidden: _hidden, note, ...fields } = item;
          if (existing.has(code)) {
            simulated = dk.applyShownRule(dk.applyResidentEdit(simulated, { ...fields, directoryCode: code }, opts), code);
            updated++;
          } else {
            dk.checkName(item.name);
            simulated = dk.applyShownRule(dk.addEntry(simulated, { ...fields, directoryCode: code }, opts), code);
            existing.add(code);
            added++;
          }
          if (typeof note === 'string' && note.trim()) notesToSave.push([code, note]);
        } catch (err) {
          errors.push({ row: index + 1, directoryCode: code, error: (err as Error).message });
        }
      }
      simulated = dk.tidyBoard(simulated);
      const changes = changeDetails(before, simulated);
      if (dryRun) return [200, { dryRun: true, added, updated, errors, changes }];
      if (errors.length) return [400, { error: `Import has ${errors.length} error(s); fix them before applying`, errors }];
      const out = await withHistory(session, gate, { summary: `Imported ${added + updated} entries (${added} added, ${updated} updated)` }, async (ctx) => {
        const [, saved] = await applyToCache(gate.phoneNumber, () => simulated, ctx);
        return [200, { added, updated, ...(saved as object) }];
      });
      if (out[0] < 300) {
        for (const [code, note] of notesToSave) await saveNote(session, gate, code, note);
      }
      return out;
    }, { bodyLimit: 256 * 1024 }),

    route('GET', `${G}/residents/:code`, 'gate', async ({ gate, params }) => {
      const [, list] = await editorResidents(gate);
      const want = params.code.padStart(list.dirDigits, '0');
      const row = list.rows!.find((resident) => resident.directoryCode === want);
      return row ? [200, row] : [404, { error: 'Directory code not found' }];
    }),

    route('PUT', `${G}/residents/:code`, 'gate-editor', ({ session, gate, params, body }) => withHistory(session, gate,
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
    route('PUT', `${G}/residents/:code/note`, 'gate-editor', async ({ session, gate, params, body }) => {
      const [, list] = await editorResidents(gate);
      const want = params.code.padStart(list.dirDigits, '0');
      if (!list.rows!.some((row) => row.directoryCode === want)) return [404, { error: 'Directory code not found' }];
      return [200, { note: await saveNote(session, gate, want, body.note) }];
    }),

    // Blanks the slot (the code stays on the gate as an empty unit). The code may be sent without its leading zeros.
    route('DELETE', `${G}/residents/:code`, 'gate-editor', async ({ session, gate, params }) => {
      const code = await fullCode(gate, params.code);
      return dropNote(session, gate, code, await withHistory(session, gate, { summary: `Deleted the entry at directory code ${code}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.deleteResident(bufs, code)), ctx)));
    }),

    // Takes the directory code off the gate entirely.
    route('DELETE', `${G}/directory-codes/:code`, 'gate-editor', async ({ session, gate, params }) => {
      const code = await fullCode(gate, params.code);
      return dropNote(session, gate, code, await withHistory(session, gate, { summary: `Removed directory code ${code}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.tidyBoard(dk.removeDirectoryCode(bufs, code)), ctx)));
    }),

    // "Num of Digits in Dir Code". Decreasing wipes all resident data, so it needs confirm: true.
    route('PUT', `${G}/dir-digits`, 'gate-editor', async ({ session, gate, body }) => {
      const from = dk.namesDirDigits((await dk.readCacheFile(store, gate.phoneNumber, 'names.bin')).data);
      if (Number(body.digits) < from && body.confirm !== true) {
        return [400, { error: 'Decreasing the directory code digits destroys all resident data; confirm is required' }];
      }
      return withHistory(session, gate, { summary: `Changed directory code digits from ${from} to ${body.digits}` },
        (ctx) => applyToCache(gate.phoneNumber, (bufs) => dk.convertDirDigits(bufs, body.digits), ctx));
    }),
  ];
}
