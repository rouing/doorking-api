// The working copy: gate data views, settings, relays, edits with History, reverts and preferences.
import type { ServerResponse } from 'node:http';
import * as dk from '../index.ts';
import { loadData, residents, residentRows, type GateFiles } from './data.ts';
import type { BoardBuffers } from '../src/residents-edit.ts';
import type { Patch, RecordChange } from '../src/audit.ts';
import type { ValuesPatch } from '../src/gate-state.ts';
import type { CacheStatus } from '../src/gate-cache.ts';
import type { GateSetting } from '../src/gate-settings.ts';
import type { DeviceRange, GateFeatures, GatePrefs, GateTracker, ResidentRow } from '../src/types.ts';
import type { Body, Gate, PrefsChange, Reply, Session } from './context.ts';
import type { ContextModule } from './context.ts';
import { logger } from '../src/logging.ts';

// Runs fn (returning [status, body]) after the gate's earlier changes and records what it changed in the working copy.
// ctx: the working copy before the change; applyToCache(..., ctx) uses it and records the result, so History needn't
// build the files again.
interface EditContext { before: BoardBuffers | null; after?: BoardBuffers }

export function createEditing(deps: ContextModule) {
  const { AREA_CODE_SETTINGS, defaults, GATE_CONFIG_KEYS, logged, objectField, prefsOf, send, serial, store } = deps;
  // The transaction list (the saved history, tx-history.ts), with names from the working copy's values; page: one page
  // of it (GET /data), with transactions.next for the older page. The server's own uses (camera runs) take all of it.
  const gateData = async (phone: string, page?: { before?: number; limit: number }) => {
    const [prefs, tx, pulledAt, w] = await Promise.all([prefsOf(phone), dk.readTransactionPage(store, phone, page),
      dk.txPulledAt(store, phone), dk.loadWorkingState(store, phone)]);
    const data = loadData(pulledAt, w && w.state, prefs.deviceAssociation, tx.records);
    return { transactions: data.transactions && { ...data.transactions, next: tx.next } };
  };
  const TX_PAGE = 2000;
  const TX_PAGE_MAX = 10000;
  // Gate settings are read from and saved to the working copy (see gate-cache.ts); the base copy stays as the
  // gate's values. Nothing is sent to the gate.
  async function gateSettings(phone: string): Promise<Reply> {
    const status = await dk.ensureCache(store, phone);
    const names = await dk.readCacheFile(store, phone, 'names.bin');
    const hide = (v: string) => '•'.repeat(v.length);
    const gate = dk.decodeGateSettings(names.base);
    const fields = dk.decodeGateSettings(names.data).map((setting, i) => (setting.secret
      ? { ...setting, value: hide(setting.value), gate: hide(gate[i].value) } : { ...setting, gate: gate[i].value }));
    return [200, { pulled: names.baseTime, saved: names.savedTime, cache: status, fields }];
  }
  // A save that changes a tone-open digit is refused while two tones share a digit.
  async function saveSettings(gate: Gate, changes: Body, cmd: number[]): Promise<Reply> {
    const names = await dk.readCacheFile(store, gate.phoneNumber, 'names.bin');
    const { buffer, changed } = dk.applyGateSettings(names.data, changes);
    if (!changed.length) return [400, { error: 'No changes to save' }];
    if (Object.keys(changes).some((k) => /^relay\dTone/.test(k))) {
      const clash = toneConflicts(dk.decodeGateSettings(buffer), cmd);
      if (clash.length) return [400, { error: `Each tone-open digit can be used only once. Used more than once: ${clash.join('; ')}` }];
    }
    const { changedBlocks } = await dk.writeCacheFile(store, gate.phoneNumber, 'names.bin', buffer);
    return [200, { changed, changedBlocks }];
  }
  const TONE_NAMES: Record<string, string> = { ToneMomentary: 'Momentary', ToneHold: 'Hold', ToneRelease: 'Release', ToneHold1Hr: 'Hold 1 Hr' };
  // Tracker command relays: relay 1 with Tracker 1, relay 2 with Tracker 2 (their row is locked on the Relays page).
  async function commandRelays(phone: string): Promise<number[]> {
    const t = (await prefsOf(phone)).tracker;
    return t && t.enabled ? [...(t.tracker1 ? [1] : []), ...(t.tracker2 ? [2] : [])] : [];
  }
  // Relays live control may set: 0-2 except Tracker command relays, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
  function liveRelays(cmd: number[]): number[] {
    const range = (from: number) => Array.from({ length: 8 }, (_, i) => from + i);
    return [...[0, 1, 2].filter((r) => !cmd.includes(r)), ...(cmd.includes(2) ? range(3) : []), ...(cmd.includes(1) ? range(11) : [])];
  }
  // Tone-open digits used by more than one tone of relays 0-2, e.g. "3 (Relay 0 Momentary, Relay 1 Hold)".
  // Relays in `skip` are left out.
  function toneConflicts(settings: GateSetting[], skip: number[]): string[] {
    const uses = new Map<string, string[]>();
    for (const setting of settings) {
      const match = /^relay(\d)(Tone\w+)$/.exec(setting.key);
      if (!match || !setting.value || skip.includes(Number(match[1]))) continue;
      uses.set(setting.value, [...(uses.get(setting.value) || []), `Relay ${match[1]} ${TONE_NAMES[match[2]] || match[2]}`]);
    }
    return [...uses].filter(([, list]) => list.length > 1).map(([d, list]) => `${d} (${list.join(', ')})`);
  }
  // Refuses (409) a send while the working copy has a directory code, entry code or card held by more than one entry.
  async function refuseDuplicates(phone: string): Promise<void> {
    const dups = dk.findDuplicates(await readBuffers(phone));
    if (dups.length) {
      throw dk.httpError(`Fix these before sending: ${dups.map((duplicate) => duplicate.text).join('; ')}`, 409);
    }
  }
  // Residents/vendors read from and saved to the working copy (never the gate). The editor keys on the
  // directory code; the area-code table lets the UI offer existing area codes. Each row carries its local note.
  async function editorResidents(gate: Gate) {
    const notes = await dk.getNotes(store, gate.phoneNumber);
    const { files: work, status: cache } = await dk.readCache(store, gate.phoneNumber);
    const updated = new Date(Math.max(...Object.values(work).map((f) => f.savedTime.getTime())));
    const files = Object.fromEntries(Object.entries(work).map(([n, f]) => [n, { data: f.data, mtime: updated }])) as GateFiles;
    const res = residents(files);
    const rows = res?.rows?.map((resident) => ({ ...resident, note: notes[dk.noteKey(resident.directoryCode)] || '' }));
    const names = work['names.bin'];
    const areaCodes = dk.areaCodeUsage(names.data, work['phone.bin'].data);
    const emptyCodes = dk.emptySlots(names.data);
    const dirDigits = dk.namesDirDigits(names.data);
    const duplicates = dk.findDuplicates({ names: names.data, phone: work['phone.bin'].data, cards: work['cards.bin'].data });
    return [200, { ...res, rows, areaCodes, emptyCodes, dirDigits, duplicates, cache, pulled: names.baseTime, saved: names.savedTime }] as const;
  }
  // Saves (or, blank, clears) the local note of a directory code and records the change in history.
  async function saveNote(session: Session, gate: Gate, code: string, note: unknown, why = ''): Promise<string> {
    const before = await dk.getNote(store, gate.phoneNumber, code);
    const after = await dk.setNote(store, gate.phoneNumber, code, note, session.user);
    if (before !== after) {
      const summary = `${after ? 'Changed' : 'Cleared'} the note for directory code ${code}${why}`;
      await dk.addEvent(store, gate.phoneNumber, {
        user: session.user, action: 'note', summary,
        details: [{ key: code, label: `Directory code ${code}`, change: 'changed', fields: [{ field: 'Note', from: before, to: after }] }],
      });
      logger('change').info`Gate ${gate.phoneNumber}: ${summary} by ${session.user}`;
    }
    return after;
  }
  // After an entry is deleted or its code removed, its note goes too.
  async function dropNote(session: Session, gate: Gate, code: string, out: Reply): Promise<Reply> {
    if (out[0] < 300) await saveNote(session, gate, code, '', ' (entry deleted)');
    return out;
  }
  const WORK_FILES: (keyof BoardBuffers)[] = ['names', 'phone', 'cards'];
  // The three working-copy buffers (throws when there is no working copy).
  async function readBuffers(phone: string): Promise<BoardBuffers> {
    const work = await dk.readCacheFiles(store, phone);
    return Object.fromEntries(WORK_FILES.map((file) => [file, work[`${file}.bin`].data])) as unknown as BoardBuffers;
  }
  // Reads the three working-copy buffers (or takes them from ctx.before, as withHistory read them), runs a transform,
  // and saves the result when it changed anything; ctx.after gets the result, for History.
  async function applyToCache(phone: string, transform: (bufs: BoardBuffers) => BoardBuffers, ctx?: EditContext):
    Promise<[number, { changed: Record<string, number[]>; cache: CacheStatus }]> {
    const bufs = ctx?.before || await readBuffers(phone);
    const out = transform(bufs);
    const names = WORK_FILES.filter((file) => !out[file].equals(bufs[file]));
    if (ctx) ctx.after = out;
    if (!names.length) return [200, { changed: {}, cache: await dk.cacheStatus(store, phone) }];
    const saved = await dk.saveCacheFiles(store, phone, Object.fromEntries(WORK_FILES.map((file) => [`${file}.bin`, out[file]])));
    return [200, { changed: Object.fromEntries(names.map((name) => [`${name}.bin`, saved.blocks[`${name}.bin`]])), cache: saved.status }];
  }
  const RES_FIELDS: Record<string, string> = {
    name: 'Name', type: 'Type', hidden: 'Hidden', areaCode: 'Area code', phone: 'Phone', entryCode: 'Entry code',
    securityLevel: 'Security', floor: 'Floor', elevatorRef: 'Elevator', cards: 'Cards',
  };
  const PREF_LABELS: Record<string, string> = { relayLabels: 'Relay names', deviceAssociation: 'Device Association', gateConfig: 'Gate configuration',
    features: 'Floors and elevators shown', tracker: 'Tracker' };
  const MAX_DETAILS = 200;
  // The working-copy buffers, or null when there is no working copy yet.
  async function workingBuffers(phone: string): Promise<BoardBuffers | null> {
    try {
      return await readBuffers(phone);
    } catch { return null; }
  }
  // What changed between two working copies, for the history page: residents/vendors by directory code and
  // gate settings by field. Secret settings show as changed without their values.
  function changeDetails(before: BoardBuffers, after: BoardBuffers): RecordChange[] {
    const rows = (bufs: BoardBuffers) => { try { return residentRows(bufs).rows; } catch { return []; } };
    const label = (resident: ResidentRow) => `${resident.type} ${resident.directoryCode}${resident.name ? ` (${resident.name})` : ''}`;
    const out = dk.diffRecords(rows(before), rows(after), 'directoryCode', Object.keys(RES_FIELDS), label)
      .map((d) => ({ ...d, fields: d.fields.map((field) => ({ ...field, field: RES_FIELDS[field.field] })) }));
    if (!before.names.equals(after.names)) {
      const settings = (buf: Buffer): GateSetting[] => { try { return dk.decodeGateSettings(buf); } catch { return []; } };
      const changed = dk.diffRecords(settings(before.names), settings(after.names), 'key', ['value'], (setting) => setting);
      for (const c of changed) {
        const setting = c.label;
        const mask = (v: string) => (setting.secret && v ? '••••' : v);
        out.push({ key: c.key, label: `Gate setting: ${setting.group}`, change: 'changed',
          fields: c.fields.map((field) => ({ field: setting.name, from: mask(field.from), to: mask(field.to) })) });
      }
    }
    if (!out.length) {
      for (const file of WORK_FILES) {
        if (before[file].equals(after[file])) continue;
        const patch = dk.diffBuffers(before[file], after[file]);
        const bytes = patch.whole ? 'layout changed' : `${patch.runs.reduce((t, r) => t + r[1].length / 2, 0)} bytes changed`;
        out.push({ key: file, label: `${file}.bin`, change: 'changed', fields: [{ field: 'Other data', from: '', to: bytes }] });
      }
    }
    if (out.length > MAX_DETAILS) {
      const more = out.length - MAX_DETAILS;
      out.length = MAX_DETAILS;
      out.push({ key: 'more', label: `…and ${more} more`, change: 'changed', fields: [] });
    }
    return out;
  }
  // Prefs changes as detail rows. Device Association rows are listed as "Row n".
  function prefsDetails({ before, after }: PrefsChange): RecordChange[] {
    const flat = (v: unknown): Record<string, unknown> => (Array.isArray(v)
      ? Object.fromEntries((v as DeviceRange[]).map((r, i) => [`Row ${i + 1}`, `${r.name} ${r.from}-${r.to}`]))
      : v && typeof v === 'object' ? v as Record<string, unknown> : {});
    return Object.keys(after).map((k) => {
      const a = flat(before[k]);
      const b = flat(after[k]);
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .map((field) => ({ field, from: String(a[field] ?? ''), to: String(b[field] ?? '') }))
        .filter((f) => f.from !== f.to);
      return { key: k, label: PREF_LABELS[k] || k, change: 'changed' as const, fields };
    });
  }
  // Records a working-copy and/or prefs change in the gate's history, with the patch Revert needs.
  // Nothing is recorded when nothing changed.
  // The working copy's change is stored as values (dk.diffStates: residents, cards, settings and layout, before and
  // after), which Revert undoes.
  async function logChange(session: Session, gate: Gate, entry: Record<string, unknown>, before: BoardBuffers | null, prefs: PrefsChange | null = null,
    known?: BoardBuffers) {
    const after = known || await workingBuffers(gate.phoneNumber);
    const changed = Boolean(before && after && WORK_FILES.some((file) => !before[file].equals(after[file])));
    const values = changed ? dk.diffStates(dk.decodeWorking(before!), dk.decodeWorking(after!)) : null;
    if (!values && !prefs) return null;
    const details = [...(changed ? changeDetails(before!, after!) : []), ...(prefs ? prefsDetails(prefs) : [])];
    const event = await dk.addEvent(store, gate.phoneNumber, {
      user: session.user, action: 'change', ...entry, details, ...(values && { values }), ...(prefs && { prefs }),
    });
    logger('change').info`${`Gate ${gate.phoneNumber}: ${String(entry.summary || entry.action || 'change')} by ${session.user}`
      + `${values ? ` (${Object.keys(values).join(', ')})` : ''}`}`;
    return event;
  }
  function withHistory(session: Session, gate: Gate, entry: Record<string, unknown>, fn: (ctx: EditContext) => Reply | Promise<Reply>): Promise<Reply> {
    return serial(gate.phoneNumber, async () => {
      const ctx: EditContext = { before: await workingBuffers(gate.phoneNumber) };
      const out = await fn(ctx);
      if (out[0] < 300) await logChange(session, gate, entry, ctx.before, null, ctx.after);
      return out;
    });
  }
  const pick = (obj: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const LATER_CHANGE = 'a later change touched the same data. Revert that change first.';
  const workingCopyOf = (before: BoardBuffers | null): BoardBuffers => {
    if (!before) throw dk.httpError('There is no working copy. Pull residents from the gate.', 409);
    return before;
  };
  // The working-copy files with a values patch undone (only those that change).
  async function filesWithValuesUndone(gate: Gate, before: BoardBuffers, values: ValuesPatch): Promise<Record<string, Buffer>> {
    const undone = dk.undoValues(dk.decodeWorking(before), values);
    if (!undone) throw dk.httpError(`Cannot revert: ${LATER_CHANGE}`, 409);
    const work = await dk.readCacheFiles(store, gate.phoneNumber);
    let built: BoardBuffers;
    try {
      built = dk.buildFiles({ names: work['names.bin'].base, phone: work['phone.bin'].base, cards: work['cards.bin'].base }, undone,
        { masterCode: gate.masterCode });
    } catch (err) { throw dk.httpError(`Cannot revert: ${(err as Error).message}`, 409); }
    return Object.fromEntries(WORK_FILES.filter((file) => !built[file].equals(before[file])).map((file) => [`${file}.bin`, built[file]]));
  }
  // Entries from before 2026-11-12 carry byte patches of the files instead.
  function filesWithPatchesUndone(before: BoardBuffers, patches: Record<string, Patch>): Record<string, Buffer> {
    return Object.fromEntries(Object.entries(patches).map(([name, patch]) => {
      const buffer = dk.undoPatch(before[name.replace(/\.bin$/, '') as keyof BoardBuffers], patch);
      if (!buffer) throw dk.httpError(`Cannot revert ${name}: ${LATER_CHANGE}`, 409);
      return [name, buffer];
    }));
  }
  // The prefs change that undoes change (refused when a later change touched the same prefs).
  async function prefsUndo(gate: Gate, change: PrefsChange): Promise<PrefsChange> {
    const now: Record<string, unknown> = { ...await prefsOf(gate.phoneNumber) };
    const keys = Object.keys(change.after);
    if (keys.some((k) => !same(now[k], change.after[k]))) {
      throw dk.httpError(`Cannot revert ${keys.map((k) => PREF_LABELS[k] || k).join(', ')}: ${LATER_CHANGE}`, 409);
    }
    return { before: change.after, after: change.before };
  }
  // Undoes one history entry in the working copy (and prefs) only; the gate changes on the next Send.
  // Refused when a later change touched the same bytes or prefs.
  async function revertEvent(session: Session, gate: Gate, id: string): Promise<Reply> {
    const events = await dk.readHistory(store, gate.phoneNumber);
    const entry = events.find((event) => event.id === id);
    if (!entry) return [404, { error: 'History entry not found' }];
    if (!entry.values && !entry.files && !entry.prefs) return [400, { error: 'This entry has nothing to revert' }];
    const done = events.find((event) => event.revertOf === id);
    if (done) return [409, { error: `Already reverted by ${done.user}` }];
    const before = await workingBuffers(gate.phoneNumber);
    const patches = (entry.files || {}) as Record<string, Patch>;
    const restored: Record<string, Buffer> = {
      ...(entry.values ? await filesWithValuesUndone(gate, workingCopyOf(before), entry.values as ValuesPatch) : {}),
      ...(Object.keys(patches).length ? filesWithPatchesUndone(workingCopyOf(before), patches) : {}),
    };
    const prefs = entry.prefs ? await prefsUndo(gate, entry.prefs as PrefsChange) : null;
    if (Object.keys(restored).length) await dk.writeCacheFiles(store, gate.phoneNumber, restored);
    if (prefs) {
      await dk.setPrefs(store, gate.phoneNumber, Object.fromEntries(Object.entries(prefs.after).map(([k, v]) => [k, v ?? undefined])));
    }
    const event = await logChange(session, gate, { action: 'revert', revertOf: id, summary: `Reverted: ${entry.summary}` }, before, prefs);
    return [200, { id: event && event.id, cache: await dk.cacheStatus(store, gate.phoneNumber) }];
  }
  // Validates and saves gate-scoped prefs. was: the saved prefs. Returns [status, merged prefs].
  async function savePrefs(gate: Gate, body: Body, was: GatePrefs): Promise<Reply> {
    const prefs: { relayLabels?: Record<string, string>; deviceAssociation?: DeviceRange[]; gateConfig?: Record<string, string>;
      features?: GateFeatures; tracker?: GateTracker } = {};
    const features = objectField(body, 'features');
    if (features) prefs.features = { floors: features.floors !== false, elevators: features.elevators !== false };
    const tracker = objectField(body, 'tracker');
    if (tracker) {
      const time = (v: unknown) => (/^\d{1,3}$/.test(String(v)) && Number(v) <= 255 ? String(Number(v)) : undefined);
      prefs.tracker = { enabled: tracker.enabled === true, tracker1: tracker.tracker1 === true, tracker2: tracker.tracker2 === true,
        prevTime1: time(tracker.prevTime1), prevTime2: time(tracker.prevTime2) };
    }
    // Only the relays given change (the Relays page saves one name at a time). Relays 0-2 always; Tracker relays
    // 3-18 only when named.
    const relayLabels = objectField(body, 'relayLabels');
    if (relayLabels) {
      const merged: Record<string, unknown> = { ...(was.relayLabels || {}), ...relayLabels };
      prefs.relayLabels = Object.fromEntries(Array.from({ length: 19 }, (_, r) => String(r))
        .map((k) => [k, String(merged[k] ?? '').trim().slice(0, 24)])
        .filter(([k, v]) => Number(k) <= 2 || v));
    }
    if (body.deviceAssociation !== undefined) {
      const da = dk.normalizeDeviceAssociation(body.deviceAssociation);
      if (da.error !== undefined) return [400, { error: da.error }];
      prefs.deviceAssociation = da.rows;
    }
    let undo: BoardBuffers | null = null; // the working copy before an area-code conversion
    const gateConfig = objectField(body, 'gateConfig');
    if (gateConfig) {
      prefs.gateConfig = gateConfigFrom(gateConfig);
      const r = await applyAreaCodeSetting(gate.phoneNumber, prefs.gateConfig.areaCodes || defaults.areaCodes);
      if (r.problem) return [409, { error: r.problem }];
      undo = r.before;
    }
    try {
      return [200, await dk.setPrefs(store, gate.phoneNumber, prefs)];
    } catch (err) { // the prefs weren't saved: put the working copy back, so it matches the saved Area codes setting
      if (undo) {
        await dk.saveCacheFiles(store, gate.phoneNumber, { 'names.bin': undo.names, 'phone.bin': undo.phone, 'cards.bin': undo.cards })
          .catch(logged('change', `Gate ${gate.phoneNumber}: area-code conversion not undone`));
      }
      throw err;
    }
  }
  // The gate configuration's values from a request (each up to 40 characters). Throws 400 on a bad Area codes value.
  function gateConfigFrom(raw: Record<string, unknown>): Record<string, string> {
    const cfg = Object.fromEntries(GATE_CONFIG_KEYS.map((k) => [k, String(raw[k] ?? '').slice(0, 40)]));
    if (cfg.areaCodes && !AREA_CODE_SETTINGS.includes(cfg.areaCodes)) {
      throw dk.httpError(`Area codes must be ${AREA_CODE_SETTINGS.join(' or ')}`);
    }
    return cfg;
  }
  // Area-code slot limit from the gate's saved "Area codes" setting.
  const editOpts = async (gate: Gate) => ({
    areaCodeSlots: dk.areaCodeLimit(((await prefsOf(gate.phoneNumber)).gateConfig || {}).areaCodes || defaults.areaCodes),
  });
  // Converts the working copy to the names.bin/phone.bin layout of the "Area codes" setting (see
  // convertAreaCodeMode). Returns { problem } (an error message), or { before }: the working copy before, when it changed.
  // "10 Area Codes" needs 10 or fewer area codes in use.
  async function applyAreaCodeSetting(phone: string, setting: string): Promise<{ problem?: string; before: BoardBuffers | null }> {
    const before = await workingBuffers(phone);
    if (!before) return { before: null }; // no working copy yet
    const ctx: EditContext = { before };
    try {
      await applyToCache(phone, (bufs) => dk.convertAreaCodeMode(bufs, dk.areaCodeLimit(setting)), ctx);
    } catch (err) { return { problem: (err as Error).message, before: null }; }
    return { before: ctx.after && WORK_FILES.some((file) => !ctx.after![file].equals(before[file])) ? before : null };
  }
  // Downloads a working-copy file (.bin, or its change map as .map), built from the database.
  async function sendFile(res: ServerResponse, phone: string, name: string) {
    const data = await dk.cacheFileData(store, phone, name);
    if (!data) return send(res, 404, { error: 'File not available' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(data);
  }
  return { gateData, TX_PAGE, TX_PAGE_MAX, gateSettings, saveSettings, commandRelays, liveRelays, refuseDuplicates, editorResidents, saveNote, dropNote, applyToCache, PREF_LABELS, workingBuffers, logChange, withHistory, pick, same, revertEvent, savePrefs, gateConfigFrom, editOpts, sendFile };
}

export type EditingModule = ReturnType<typeof createEditing>;
