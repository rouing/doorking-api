/**
 * @module src/audit
 *
 * History of who did what on a gate (database table history, one JSON event per row, append-only, keyed by
 * the gate's phone number); see db.ts. Working-copy changes carry
 * their change as values (gate-state.ts diffStates; before 2026-11-12, a byte patch per file) so they can be
 * reverted; a revert is itself an event (revertOf = the id it undid).
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { all, run, type Store, phoneDigits } from './db.ts';
import type { EntryChange, HistoryEvent } from './types.ts';

export type Patch =
  | { whole: true; before: string; after: string }
  | { whole?: undefined; runs: [number, string, string][] };

export interface FieldChange { field: string; from: string; to: string }
export interface RecordChange<L = string> { key: string; label: L; change: 'added' | 'removed' | 'changed'; fields: FieldChange[] }

/**
 * A stored event: what listHistory returns plus the revert data (values; files on events before 2026-11-12; prefs)
 * and any other details.
 */
export interface StoredEvent {
  id: string;
  time: string;
  revertOf?: string;
  values?: unknown;
  files?: unknown;
  prefs?: unknown;
  [k: string]: unknown;
}

const MAX_LIST = 500;

const pack = (buf: Buffer): string => zlib.deflateRawSync(buf).toString('base64');
const unpack = (packed: string): Buffer => zlib.inflateRawSync(Buffer.from(packed, 'base64'));

/**
 * Patch from `before` to `after`: the changed byte runs as [offset, beforeHex, afterHex]. When the size
 * differs (names.bin switching area-code layout), both whole files are kept, compressed.
 *
 * @param before - State or buffer before the change.
 * @param after - State or buffer after the change.
 * @returns `Patch` result.
 */
export function diffBuffers(before: Buffer, after: Buffer): Patch {
  if (before.length !== after.length) return { whole: true, before: pack(before), after: pack(after) };
  const runs: [number, string, string][] = [];
  for (let i = 0; i < after.length; i++) {
    if (before[i] === after[i]) continue;
    let j = i + 1;
    while (j < after.length && before[j] !== after[j]) j++;
    runs.push([i, before.toString('hex', i, j), after.toString('hex', i, j)]);
    i = j;
  }
  return { runs };
}

/**
 * Undoes a patch on `current`. Every patched byte must still hold its `after` value; otherwise a later
 * change touched the same bytes and null is returned.
 *
 * @param current - Current password or state.
 * @param patch - Binary diff patch.
 * @returns `Buffer | null` result.
 */
export function undoPatch(current: Buffer, patch: Patch): Buffer | null {
  if (patch.whole) return current.equals(unpack(patch.after)) ? unpack(patch.before) : null;
  const out = Buffer.from(current);
  for (const [off, before, after] of patch.runs) {
    const want = Buffer.from(after, 'hex');
    if (off + want.length > current.length || !current.subarray(off, off + want.length).equals(want)) return null;
    Buffer.from(before, 'hex').copy(out, off);
  }
  return out;
}

const shown = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/**
 * Field changes between two record lists keyed by `key`:
 * [{ key, label, change: 'added'|'removed'|'changed', fields: [{ field, from, to }] }].
 *
 * @param before - State or buffer before the change.
 * @param after - State or buffer after the change.
 * @param key - Lookup key, API key, or setting key.
 * @param fields - Field names or field updates.
 * @param label - Display label.
 * @returns `RecordChange<L>[]` result.
 */
export function diffRecords<R extends object, L = string>(
  before: R[], after: R[], key: string, fields: string[], label: (row: R) => L,
): RecordChange<L>[] {
  const get = (row: R, field: string): unknown => (row as Record<string, unknown>)[field];
  const was = new Map(before.map((row) => [get(row, key) as string, row]));
  const now = new Map(after.map((row) => [get(row, key) as string, row]));
  const out: RecordChange<L>[] = [];
  for (const id of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(id);
    const next = now.get(id);
    const list = fields
      .map((field) => ({ field, from: old ? shown(get(old, field)) : '', to: next ? shown(get(next, field)) : '' }))
      .filter((field) => field.from !== field.to);
    if (!list.length) continue;
    out.push({ key: id, label: label((next || old) as R), change: !old ? 'added' : !next ? 'removed' : 'changed', fields: list });
  }
  return out;
}

/**
 * One event with its patch data (to revert it), and the revert that undid it (none: null).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Unique record identifier.
 * @returns Promise resolving to `{ event: StoredEvent | null; revertedBy: StoredEvent | null }`.
 */
export async function historyEvent(store: Store, phone: string, id: string): Promise<{ event: StoredEvent | null; revertedBy: StoredEvent | null }> {
  const rows = await all<{ data: StoredEvent }>(store, "SELECT data FROM history WHERE phone = $1 AND (id = $2 OR data->>'revertOf' = $2) ORDER BY seq",
    [phoneDigits(phone), id]);
  return { event: rows.find((row) => row.data.id === id)?.data ?? null, revertedBy: rows.find((row) => row.data.revertOf === id)?.data ?? null };
}

/**
 * Events without their patch data (values, files, prefs; patched: whether they had any), newest first; and who
 * reverted which (revertOf -> the revert).
 */
const SUMMARY = "data - 'values' - 'files' - 'prefs' AS data, (data ? 'values' OR data ? 'files' OR data ? 'prefs') AS patched";
async function reverts(store: Store, phone: string): Promise<Map<unknown, StoredEvent>> {
  const rows = await all<{ data: StoredEvent }>(store, `SELECT ${SUMMARY} FROM history WHERE phone = $1 AND data ? 'revertOf'`, [phone]);
  return new Map(rows.map((row) => [row.data.revertOf, row.data]));
}

/**
 * Add event.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param event - History or UI event object.
 * @returns Promise resolving to `StoredEvent`.
 */
export async function addEvent(store: Store, phone: string, event: Record<string, unknown>): Promise<StoredEvent> {
  const stored: StoredEvent = { id: crypto.randomBytes(8).toString('hex'), time: new Date().toISOString(), ...event };
  await run(store, 'INSERT INTO history (id, phone, data) VALUES ($1, $2, $3)', [stored.id, phoneDigits(phone), JSON.stringify(stored)]);
  return stored;
}

/**
 * The changes History recorded for one directory code (its resident/vendor fields and its note), newest first:
 * [{ id, time, user, action, summary, change, fields: [{ field, from, to }], revertedBy }]. Pulls and sends that list
 * the code are included (their user is whoever ran them).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns Promise resolving to `EntryChange[]`.
 */
export async function entryHistory(store: Store, phone: string, code: string): Promise<EntryChange[]> {
  const key = String(code ?? '');
  const phoneKey = phoneDigits(phone);
  const events = (await all<{ data: StoredEvent }>(store, `SELECT ${SUMMARY} FROM history WHERE phone = $1
    AND data->'details' @> jsonb_build_array(jsonb_build_object('key', $2::text)) ORDER BY seq DESC`, [phoneKey, key])).map((row) => row.data);
  const revertsOf = await reverts(store, phoneKey);
  const out: EntryChange[] = [];
  for (const event of events) {
    const change = (Array.isArray(event.details) ? event.details as RecordChange[] : []).find((item) => item.key === key);
    if (!change) continue;
    const by = revertsOf.get(event.id);
    out.push({ id: event.id, time: event.time, user: String(event.user ?? ''), action: String(event.action ?? ''), summary: String(event.summary ?? ''),
      change: change.change, fields: change.fields, revertedBy: by ? { id: by.id, user: String(by.user ?? ''), time: by.time } : null });
  }
  return out;
}

/**
 * Newest first, without the patch data. revertedBy names the revert that undid an event.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param [limit] - Maximum number of rows to return.
 * @returns Promise resolving to `HistoryEvent[]`.
 */
export async function listHistory(store: Store, phone: string, limit = MAX_LIST): Promise<HistoryEvent[]> {
  const phoneKey = phoneDigits(phone);
  const rows = await all<{ data: StoredEvent; patched: boolean }>(store, `SELECT ${SUMMARY} FROM history WHERE phone = $1 ORDER BY seq DESC LIMIT $2`,
    [phoneKey, limit]);
  const revertsOf = await reverts(store, phoneKey);
  return rows.map(({ data: event, patched }): HistoryEvent => {
    const by = revertsOf.get(event.id);
    const { user, action, summary, result, error, details, ...rest } = event;
    return {
      ...rest,
      user: String(user ?? ''), action: String(action ?? ''), summary: String(summary ?? ''),
      ...(result !== undefined && { result: String(result) }), ...(error !== undefined && { error: String(error) }),
      ...(details !== undefined && { details: details as HistoryEvent['details'] }),
      revertible: patched && !by,
      revertedBy: by ? { id: by.id, user: String(by.user ?? ''), time: by.time } : null,
    };
  });
}
