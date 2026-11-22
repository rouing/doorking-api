import { decodeRcvEvent, hasValidDate, residentRows, type RcvRecord, type ResidentsData } from '../src/board-files.ts';
import { DEFAULT_DEVICE_ASSOCIATION, deviceNameFor } from '../src/shared.ts';
import { footageApplies, minuteKey } from '../src/camera-log.ts';
import type { TxRow } from '../src/camera-settings.ts';
import type { DeviceRange, TransactionRow } from '../src/types.ts';
import type { WorkingState } from '../src/gate-state.ts';

/** A gate file's contents and when it was pulled (the latest pull, from gate_files). */
export interface FileRead { data: Buffer; mtime: Date }
export type GateFiles = Partial<Record<'names.bin' | 'phone.bin' | 'cards.bin', FileRead>>;

/**
 * Residents from names.bin + phone.bin + cards.bin, joined on directory code.
 *
 * @param files - Map of board filenames to binary buffers.
 * @returns `(ResidentsData & { updated: Date | undefined }) | null` result.
 */
export function residents(files: GateFiles): (ResidentsData & { updated: Date | undefined }) | null {
  const names = files['names.bin'] || null;
  const phones = files['phone.bin'] || null;
  const cards = files['cards.bin'] || null;
  if (!names && !phones && !cards) return null;
  const { rows, unassignedCards } = residentRows({ names: names && names.data, phone: phones && phones.data, cards: cards && cards.data });
  const updated = [names, phones, cards].filter((file) => file !== null).map((file) => file.mtime).sort((a, b) => a.getTime() - b.getTime()).pop();
  return { updated, rows, unassignedCards };
}

/**
 * Transactions from the saved history (see tx-history.ts), with resident names looked up in the working copy's values
 * (gate_residents, gate_cards) by directory code, entry code or card. Card events take their Event Type from the
 * Device Association ranges, as DoorKing32 does. updated: the last transactions pull; null (no transactions yet)
 * when the gate was never read.
 *
 * @param pulledAt - Timestamp of the last pull, or `null`.
 * @param values - Decoded working-copy values.
 * @param [devices] - Configured Device Association card ranges.
 * @param [history] - Ordered transaction records.
 * @returns `{ updated: Date; rows: TransactionRow[] } | null` result.
 */
function transactions(pulledAt: Date | null, values: WorkingState | null,
  devices: DeviceRange[] | null | undefined = DEFAULT_DEVICE_ASSOCIATION,
  history?: RcvRecord[] | null): { updated: Date; rows: TransactionRow[] } | null {
  if (!pulledAt) return null;
  type Who = { name: string; directoryCode: string };
  const by = { card: new Map<string | null, Who>(), entryCode: new Map<string | null, Who>(), directory: new Map<string | null, Who>() };
  for (const resident of values ? values.residents : []) {
    if (resident.entryCode) by.entryCode.set(resident.entryCode, resident);
    by.directory.set(resident.directoryCode, resident);
  }
  // A card assigned to a code with no directory entry still shows that code (with no name).
  for (const card of values ? values.cards : []) {
    if (card.directoryCode) by.card.set(card.cardNumber, by.directory.get(card.directoryCode) || { name: '', directoryCode: card.directoryCode });
  }
  const rows = (history || [])
    .filter(hasValidDate)
    .reverse()
    .map((record) => {
      const event = decodeRcvEvent(record);
      const who = event.lookup ? by[event.lookup].get(event.number) : null;
      const ts = recordTime(record);
      return {
        ts,
        minute: minuteKey(ts), // snapshot folder (see cameras.ts)
        date: `${record.year}-${String(record.month).padStart(2, '0')}-${String(record.day).padStart(2, '0')}`,
        time: `${record.hour}:${String(record.minute).padStart(2, '0')} ${record.pm ? 'PM' : 'AM'}`,
        eventType: event.eventType === 'Cards' ? deviceNameFor(devices, event.number as string) : event.eventType,
        number: event.number,
        lookup: event.lookup,
        name: who ? who.name : event.lookup === 'card' && values ? 'Unknown' : event.name,
        access: event.access,
        relay: event.relay,
        apb: event.apb,
        directoryCode: who ? who.directoryCode : '',
        camera: footageApplies(event),
        raw: record.raw,
      };
    });
  return { updated: pulledAt, rows };
}

/**
 * A transaction record's time (ms, the server's time zone).
 *
 * @param record - Parsed binary record.
 * @returns `number` result.
 */
function recordTime(record: RcvRecord): number {
  const hour24 = (record.hour % 12) + (record.pm ? 12 : 0);
  return new Date(record.year as number, record.month - 1, record.day, hour24, record.minute).getTime();
}

/**
 * What the camera code needs of each saved transaction (history: oldest first): no names, no Device Association.
 *
 * @param history - Oldest first.
 * @returns `TxRow[]` result.
 */
export function cameraRows(history: RcvRecord[]): TxRow[] {
  return history.filter(hasValidDate).map((record) => {
    const { eventType, access } = decodeRcvEvent(record);
    return { ts: recordTime(record), eventType, access };
  });
}

export { residentRows };

/**
 * pulledAt: the last transactions pull (txPulledAt); values: the working copy's values (loadWorkingState), or null;
 * history: the saved transactions, or a page of them (readTransactionPage), oldest first.
 *
 * @param pulledAt - Timestamp of the last transactions pull (`txPulledAt`), or `null`.
 * @param values - Decoded working-copy values (`loadWorkingState`), or `null`.
 * @param [devices] - Configured Device Association card ranges.
 * @param [history] - Saved transaction records, oldest first (`readTransactionPage`).
 * @returns Operation result.
 */
export function loadData(pulledAt: Date | null, values: WorkingState | null, devices?: DeviceRange[] | null, history?: RcvRecord[] | null) {
  return { transactions: transactions(pulledAt, values, devices, history) };
}
