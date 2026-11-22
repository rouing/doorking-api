// Local, gate-scoped preferences — things the DoorKing app keeps in its own ACCOUNT.DAT (never on the gate),
// such as relay labels. Keyed by the gate's system phone number so every account that manages the same
// physical gate shares the same labels. Stored in the database's prefs table (see db.ts), one JSON row per gate.
import { one, phoneDigits, transaction, type Store } from './db.ts';
import type { DeviceRange, GatePrefs } from './types.ts';
import { httpError } from './errors.ts';

// Rows are keyed by the phone number's digits, so "214-555-0100" and "2145550100" share preferences.
export async function getPrefs(store: Store, phone: string): Promise<GatePrefs> {
  const row = await one<{ data: GatePrefs }>(store, 'SELECT data FROM prefs WHERE phone = $1', [phoneDigits(phone)]);
  return row ? row.data : {};
}

// Merge `prefs` into the gate's stored preferences (shallow) and return the merged result.
// Keys set to undefined are removed.
export async function setPrefs(store: Store, phone: string, prefs: Record<string, unknown>): Promise<GatePrefs> {
  return transaction(store, async (tx) => {
    const old = await one<{ data: GatePrefs }>(tx, 'SELECT data FROM prefs WHERE phone = $1 FOR UPDATE', [phoneDigits(phone)]);
    const merged: GatePrefs = JSON.parse(JSON.stringify({ ...(old ? old.data : {}), ...prefs }));
    await one(tx, 'INSERT INTO prefs (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = excluded.data',
      [phoneDigits(phone), JSON.stringify(merged)]);
    return merged;
  });
}

// Device Association (DoorKing32's "Dev Enable" window, kept only in ACCOUNT.DAT as CDeviceRecord): up to 10
// named card-number ranges. Names up to 12 characters, device codes 00001-65407 (DoorKing manual 3.7.2), ranges
// may not overlap.
export const DEVICE_MIN = 1;
export const DEVICE_MAX = 65407;
const DEVICE_NAME_MAX = 12;

// The rows with 5-digit numbers and blank rows dropped; throws 400 (httpError) on bad input.
export function normalizeDeviceAssociation(list: unknown): DeviceRange[] {
  if (!Array.isArray(list)) throw httpError('Device association must be a list');
  if (list.length > 10) throw httpError('Device association has at most 10 rows');
  const rows: (DeviceRange & { n: number })[] = [];
  for (const [i, range] of (list as (Partial<Record<keyof DeviceRange, unknown>> | null)[]).entries()) {
    const name = String((range && range.name) ?? '').trim();
    const from = String((range && range.from) ?? '').trim();
    const to = String((range && range.to) ?? '').trim();
    if (!name && !from && !to) continue;
    const position = i + 1;
    if (!name) throw httpError(`Row ${position}: enter a device name`);
    if (name.length > DEVICE_NAME_MAX) throw httpError(`Row ${position}: device name is at most ${DEVICE_NAME_MAX} characters`);
    if (!/^\d{1,5}$/.test(from) || !/^\d{1,5}$/.test(to)) throw httpError(`Row ${position}: From and To must be numbers`);
    if ([from, to].some((value) => Number(value) < DEVICE_MIN || Number(value) > DEVICE_MAX)) {
      throw httpError(`Row ${position}: device codes are 00001-${DEVICE_MAX}`);
    }
    if (Number(from) > Number(to)) throw httpError(`Row ${position}: From is greater than To`);
    rows.push({ name, from: from.padStart(5, '0'), to: to.padStart(5, '0'), n: position });
  }
  const sorted = [...rows].sort((a, b) => Number(a.from) - Number(b.from));
  for (let i = 1; i < sorted.length; i++) {
    if (Number(sorted[i].from) <= Number(sorted[i - 1].to)) {
      throw httpError(`Rows ${sorted[i - 1].n} and ${sorted[i].n} overlap`);
    }
  }
  return rows.map(({ name, from, to }) => ({ name, from, to }));
}

