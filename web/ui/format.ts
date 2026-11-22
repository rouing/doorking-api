// Display helpers shared by the tables.
import type { GateFeatures, GatePrefs, GateTracker, ResidentRow, TransactionRow } from '../../src/types.ts';
import { NO_FOOTAGE_EVENTS } from '../../src/snapshot-files.ts';

// A row's value for a column key (a field of the row; undefined when it has none).
export const fieldOf = (row: object, key: string): unknown => (row as { [field: string]: unknown })[key];

export const cell = (value: unknown): string => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value));

// Compares two cell values: numeric when both look numeric, else case-insensitive with numbers in order.
export function cmpCells(a: unknown, b: unknown): number {
  const textA = cell(a);
  const textB = cell(b);
  const numberA = Number(textA);
  const numberB = Number(textB);
  if (textA !== '' && textB !== '' && !Number.isNaN(numberA) && !Number.isNaN(numberB)) return numberA - numberB;
  return textA.localeCompare(textB, undefined, { numeric: true });
}

// An unused directory slot: no name, phone, entry code or cards (the gate keeps the slot's code, flag 0x00).
export const isEmptySlot = (resident: ResidentRow) => !resident.name && !resident.phone && !resident.entryCode && !(resident.cards && resident.cards.length);

// The phone as one value; the gate stores the area code (3 digits, or 4 as 1 + area code for long distance) and
// the 7-digit number separately.
export function phoneFull(resident: ResidentRow): string {
  const local = (resident.phone || '').replace(/\D/g, '');
  if (!local) return '';
  const full = (resident.areaCode || '') + local;
  return full.length === 10 || full.length === 11 ? formatPhoneDigits(full)
    : local.length === 7 ? `${local.slice(0, 3)}-${local.slice(3)}` : full;
}

// Partial phone digits as typed: up to 7 as 555-1234, 8-10 as (918) 555-0142, 11 as 1 (918) 555-0142.
export const formatPhoneDigits = (digits: string) => (digits.length <= 7
  ? (digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits)
  : digits.length === 11 ? `${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
    : `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`);

// The gate's Tracker switches; Tracker 1/2 count only while Tracker is on.
export const trackerOf = (prefs: GatePrefs): GateTracker => {
  const enabled = prefs.tracker?.enabled === true;
  return { enabled, tracker1: enabled && prefs.tracker?.tracker1 === true, tracker2: enabled && prefs.tracker?.tracker2 === true };
};

// Relays 0-2, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
export const trackerRelays = (tracker: GateTracker): number[] => [0, 1, 2,
  ...(tracker.tracker2 ? Array.from({ length: 8 }, (_, i) => 3 + i) : []), ...(tracker.tracker1 ? Array.from({ length: 8 }, (_, i) => 11 + i) : [])];

// The gate's Floors/Elevators switches (System Settings > Gate configuration); shown unless turned off.
export const featuresOf = (prefs: GatePrefs): GateFeatures => ({
  floors: prefs.features?.floors !== false, elevators: prefs.features?.elevators !== false,
});

// Security level as shown: 0 = Disabled, 1 = Enabled (always valid), else the level number. The gate stores the number.
export const securityText = (level: unknown): string => {
  const text = cell(level);
  return text === '0' ? 'Disabled' : text === '1' ? 'Enabled' : text;
};

// Text of a directory column (hidden flag, combined phone, security level, blank floor/elevator).
export function dirCell(resident: ResidentRow, key: string): string {
  if (key === 'hidden') return resident.hidden ? 'Hidden' : '';
  if (key === 'phoneFull') return phoneFull(resident);
  if (key === 'securityLevel') return securityText(resident.securityLevel);
  return cell(fieldOf(resident, key));
}

// Transaction event types that are gate/system actions: the ones that never get camera footage, and System.
const TX_SYSTEM = new Set([...NO_FOOTAGE_EVENTS, 'System']);

// Row colour of a transaction: denied red, system actions amber, admitted green.
export function txTone(transaction: TransactionRow): 'red' | 'amber' | 'green' | null {
  if (transaction.access === 'Deny') return 'red';
  if (TX_SYSTEM.has(transaction.eventType) || (!transaction.eventType && !transaction.lookup && transaction.name)) return 'amber';
  if (transaction.access === 'Admit') return 'green';
  return null;
}

// Finds the resident/vendor a transaction refers to: by its resolved directory code, else by its Number,
// matched as the transaction's lookup says (directory code, entry code or card).
export function residentFinder(rows: ResidentRow[]): (transaction: TransactionRow) => ResidentRow | null {
  const by = { directory: new Map<unknown, ResidentRow>(), entryCode: new Map<unknown, ResidentRow>(), card: new Map<unknown, ResidentRow>() };
  for (const resident of rows) {
    if (isEmptySlot(resident)) continue;
    by.directory.set(resident.directoryCode, resident);
    if (resident.entryCode) by.entryCode.set(resident.entryCode, resident);
    for (const card of resident.cards) by.card.set(Number(card), resident);
  }
  return (transaction) => {
    if (transaction.directoryCode && by.directory.has(transaction.directoryCode)) return by.directory.get(transaction.directoryCode)!;
    if (!transaction.lookup || !transaction.number) return null;
    return by[transaction.lookup].get(transaction.lookup === 'card' ? Number(transaction.number) : transaction.number) || null;
  };
}

// Downloads rows as a CSV file.
export function downloadCsv(name: string, header: string[], rows: string[][]) {
  const esc = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  downloadText(name, [header, ...rows].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n');
}

// The whole directory as DoorKing's cloud exports it (ResidentsExport.csv, matched against one, 2026-11-16): one row per
// directory code in the gate's directory order (empty slots first, vendors last), 62 columns: ACCOUNT (the site
// name), Resident, H (hidden: Y/N; vendors N), AAC (area code as stored, 3 or 4 digits), PHONE (555-0142), Dir, ENT, SL,
// Device + DEVICE2-25 (card numbers, 5 digits, ascending), FL (blank when unset), ER, NOTES + NOTES2-25 (per-device
// notes: kept empty), Vendor (Y/N), RESIDENTNOTES (the local note). Text columns are always quoted, the others never;
// CRLF line ends. Cards without a directory code are listed on directory code 0 (000), as the cloud does. 25 is also
// the gate's limit of cards per directory code.
export function doorKingCsv(account: string, rows: ResidentRow[], unassignedCards: string[] = []): string {
  const quoted = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const plain = (value: unknown) => String(value ?? '').replace(/[",\r\n]/g, ' ');
  const devices = [''].concat(Array.from({ length: 24 }, (_, i) => String(i + 2)));
  const header = ['ACCOUNT', 'Resident', 'H', 'AAC', 'PHONE', 'Dir', 'ENT', 'SL', 'Device', 'FL', 'ER', 'NOTES', 'Vendor',
    ...devices.slice(1).flatMap((device) => [`DEVICE${device}`, `NOTES${device}`]), 'RESIDENTNOTES'];
  const ordered = [...rows].sort((a, b) => (a.entryOffset ?? Infinity) - (b.entryOffset ?? Infinity) || a.directoryCode.localeCompare(b.directoryCode));
  const lines = ordered.map((resident) => {
    const vendor = resident.type === 'Vendor';
    const own = /^0+$/.test(resident.directoryCode) ? [...resident.cards, ...unassignedCards] : resident.cards;
    const cards = [...new Set(own.map((card) => Number(card)))].filter((card) => card > 0).sort((x, y) => x - y).slice(0, 25).map((card) => String(card).padStart(5, '0'));
    const dev = (i: number) => plain(cards[i] || '');
    return [quoted(account), quoted(resident.name), resident.hidden && !vendor ? 'Y' : 'N', plain(resident.areaCode), plain(resident.phone), plain(resident.directoryCode), plain(resident.entryCode),
      plain(resident.securityLevel), dev(0), plain(resident.floor), plain(resident.elevatorRef), quoted(''), vendor ? 'Y' : 'N',
      ...devices.slice(1).flatMap((_, i) => [dev(i + 1), quoted('')]), quoted(resident.note || '')].join(',');
  });
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

// Downloads text as a file.
export function downloadText(name: string, text: string, type = 'text/csv') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

// An account phone number (E.164) for display: +1 (214) 555-0100 for US/Canada, else as stored.
export const fmtIntlPhone = (e164: string) => {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return match ? `+1 (${match[1]}) ${match[2]}-${match[3]}` : e164 || '';
};
export const fmtTime = (time: string | number | undefined | null) => (time ? new Date(time).toLocaleString('en-US') : '');
