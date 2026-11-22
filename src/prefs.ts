/**
 * @module src/prefs
 *
 * Local, gate-scoped preferences — things the DoorKing app keeps in its own ACCOUNT.DAT (never on the gate),
 * such as relay labels. Keyed by the gate's system phone number so every account that manages the same
 * physical gate shares the same labels. Stored in the database's prefs table (see db.ts), one JSON row per gate.
 */
import { one, phoneDigits, transaction, type Store } from './db.ts';
import type { DeviceRange, GatePrefs } from './types.ts';
import { httpError } from './errors.ts';

/**
 * Rows are keyed by the phone number's digits, so "214-555-0100" and "2145550100" share preferences.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `GatePrefs`.
 */
export async function getPrefs(store: Store, phone: string): Promise<GatePrefs> {
  const row = await one<{ data: GatePrefs }>(store, 'SELECT data FROM prefs WHERE phone = $1', [phoneDigits(phone)]);
  return row ? row.data : {};
}

/**
 * Merge `prefs` into the gate's stored preferences (shallow) and return the merged result.
 * Keys set to undefined are removed.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param prefs - Gate-scoped preferences object.
 * @returns Promise resolving to `GatePrefs`.
 */
export async function setPrefs(store: Store, phone: string, prefs: Record<string, unknown>): Promise<GatePrefs> {
  return transaction(store, async (tx) => {
    const old = await one<{ data: GatePrefs }>(tx, 'SELECT data FROM prefs WHERE phone = $1 FOR UPDATE', [phoneDigits(phone)]);
    const merged: GatePrefs = JSON.parse(JSON.stringify({ ...(old ? old.data : {}), ...prefs }));
    await one(tx, 'INSERT INTO prefs (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = excluded.data',
      [phoneDigits(phone), JSON.stringify(merged)]);
    return merged;
  });
}

/**
 * Device Association (DoorKing32's "Dev Enable" window, kept only in ACCOUNT.DAT as CDeviceRecord): up to 10
 * named card-number ranges. Names up to 12 characters, device codes 00001-65407 (DoorKing manual 3.7.2), ranges
 * may not overlap.
 */
export const DEVICE_MIN = 1;
export const DEVICE_MAX = 65407;
const DEVICE_NAME_MAX = 12;

/**
 * Validates Device Association rows, pads card numbers to 5 digits, drops blank rows, and rejects overlaps.
 *
 * @param list - Unvalidated array of device-range objects.
 * @returns Normalized `DeviceRange[]`.
 * @throws HTTP 400 error on invalid or overlapping rows.
 */
export function normalizeDeviceAssociation(list: unknown): DeviceRange[] {
  if (!Array.isArray(list)) throw httpError('Device association must be a list');
  if (list.length > 10) throw httpError('Device association has at most 10 rows');
  const rows: (DeviceRange & { rowNumber: number })[] = [];
  for (const [index, item] of list.entries()) {
    const range = item && typeof item === 'object' ? (item as Partial<Record<keyof DeviceRange, unknown>>) : null;
    const name = String(range?.name ?? '').trim();
    const from = String(range?.from ?? '').trim();
    const to = String(range?.to ?? '').trim();
    if (!name && !from && !to) continue;
    const rowNumber = index + 1;
    if (!name) throw httpError(`Row ${rowNumber}: enter a device name`);
    if (name.length > DEVICE_NAME_MAX) throw httpError(`Row ${rowNumber}: device name is at most ${DEVICE_NAME_MAX} characters`);
    if (!/^\d{1,5}$/.test(from) || !/^\d{1,5}$/.test(to)) throw httpError(`Row ${rowNumber}: From and To must be numbers`);
    if ([from, to].some((value) => Number(value) < DEVICE_MIN || Number(value) > DEVICE_MAX)) {
      throw httpError(`Row ${rowNumber}: device codes are 00001-${DEVICE_MAX}`);
    }
    if (Number(from) > Number(to)) throw httpError(`Row ${rowNumber}: From is greater than To`);
    rows.push({ name, from: from.padStart(5, '0'), to: to.padStart(5, '0'), rowNumber });
  }
  const sorted = [...rows].sort((first, second) => Number(first.from) - Number(second.from));
  for (let index = 1; index < sorted.length; index++) {
    if (Number(sorted[index].from) <= Number(sorted[index - 1].to)) {
      throw httpError(`Rows ${sorted[index - 1].rowNumber} and ${sorted[index].rowNumber} overlap`);
    }
  }
  return rows.map(({ name, from, to }) => ({ name, from, to }));
}

