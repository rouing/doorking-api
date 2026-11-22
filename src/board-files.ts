// Board memory images exchanged with DKS Cloud (names.bin, phone.bin, cards.bin, rcv_out.bin)
// and their .MAP change flags (one byte per 128-byte block, 1 = block changed).
import type { ResidentRow } from './types.ts';

export interface NamesLayout { areaCodeMode: 255 | 10; areaCodeOffset: number; areaCodeSlots: number; directoryOffset: number }
export interface PhoneFields { areaCodeIndex: number | null; phone: string | null }
export interface PhoneEntry {
  recordOffset: number; directoryCode: string | null; areaCodeIndex: number | null; phone: string | null;
  entryCode: string | null; securityLevel: number; elevatorRef: number; floor: number | null;
}
export type ResidentsData = { rows: ResidentRow[]; unassignedCards: string[] };
export interface CardEntry { cardNumber: string; directoryCode: string | null }
export interface DirectoryEntry { entryOffset: number; directoryCode: string; name: string; flag: number; vendor: boolean; hidden: boolean }
export interface RcvRecord {
  month: number; day: number; hour: number; minute: number; pm: boolean; eventFlags: number;
  codeType: number; code: string | null; raw: string; year?: number;
}
export interface RcvEvent {
  eventType: string; number: string | null; name: string; access: string; relay: string; apb: string;
  lookup: 'directory' | 'entryCode' | 'card' | null;
}

// Record sizes and fixed offsets of the board files, used by every module that reads or writes them.
export const BLOCK_SIZE = 128; // a .map file has one byte per block of this size
export const NAMES_ENTRY_SIZE = 20; // one directory entry in names.bin
export const PHONE_RECORD_SIZE = 10; // one phone.bin record
export const CARD_RECORD_SIZE = 4; // one cards.bin record
export const NAMES_MIDDLE_POINTER_OFFSET = 0xf8; // 3-byte big-endian offset of the middle shown entry (DoorKing32.exe.c:119433)
// names.bin layout depends on the gate's "Area codes" setting (DoorKing32 snapshots, 255 vs 10):
//   255: area-code table at 0xA41 (255 entries), directory at 0xF80.
//   10:  area-code table at 0x44 (10 entries), directory at 0xC00; the file is 0x380 bytes shorter.
// The middle-entry pointer (0xF8) always counts as if the directory started at 0xF80.
export const NAMES_LAYOUTS: Record<255 | 10, NamesLayout> = {
  255: { areaCodeMode: 255, areaCodeOffset: 0xa41, areaCodeSlots: 255, directoryOffset: 0xf80 },
  10: { areaCodeMode: 10, areaCodeOffset: 0x44, areaCodeSlots: 10, directoryOffset: 0xc00 },
};
const NAMES_10_LENGTH = 63104; // DoorKing32 names.bin in 10-area-code mode (64000 in 255 mode)

// "Num of Digits in Dir Code" (1-4, per the DoorKing manual) at names.bin 0x40. The entry's code field (bytes
// 16-19) holds the code right-justified and space padded ("   5", "  12", " 701", "1701"); phone.bin/cards.bin hold
// it as F-padded BCD. 1 and 2 digits are not yet checked against DoorKing32 snapshots.
export const NAMES_DIR_DIGITS_OFFSET = 0x40;
export const namesDirDigits = (buf: Buffer): number => ([1, 2, 3, 4].includes(buf[NAMES_DIR_DIGITS_OFFSET]) ? buf[NAMES_DIR_DIGITS_OFFSET] : 3);

// Directory code of the entry at o, or null when o is not a directory entry.
export function namesEntryCode(buf: Buffer, offset: number): string | null {
  if (offset + NAMES_ENTRY_SIZE > buf.length) return null;
  const match = /^ {0,3}(\d{1,4})$/.exec(buf.toString('latin1', offset + 16, offset + 20));
  return match ? match[1] : null;
}

export const isNamesEntryAt = (buf: Buffer, offset: number): boolean => namesEntryCode(buf, offset) !== null;

// Layout of a names.bin: from where the directory starts, else (empty directory) from the file length.
export function namesLayout(buf: Buffer): NamesLayout {
  if (isNamesEntryAt(buf, NAMES_LAYOUTS[255].directoryOffset)) return NAMES_LAYOUTS[255];
  if (isNamesEntryAt(buf, NAMES_LAYOUTS[10].directoryOffset)) return NAMES_LAYOUTS[10];
  return buf.length === NAMES_10_LENGTH ? NAMES_LAYOUTS[10] : NAMES_LAYOUTS[255];
}

// phone.bin bytes 2-5 (area-code index + 7-digit local number).
//   255 mode: byte 2 = index (0xFF = none), bytes 3-5 = number as 24-bit big-endian (0xFFFFFF = none).
//   10 mode: high nibble of byte 2 = index (0xF = none), then the 7 digits as BCD (all 0xF = none).
export function readPhoneFields(rec: Buffer, areaCodeMode = 255): PhoneFields {
  if (areaCodeMode === 10) {
    const hex = rec.subarray(2, 6).toString('hex');
    return {
      areaCodeIndex: hex[0] === 'f' ? null : parseInt(hex[0], 16),
      phone: /^f+$/.test(hex.slice(1)) ? null : hex.slice(1),
    };
  }
  const phoneBytes = rec.subarray(3, 6);
  return {
    areaCodeIndex: rec[2] === 0xff ? null : rec[2],
    phone: allFF(phoneBytes) ? null : String(phoneBytes.readUIntBE(0, 3)).padStart(7, '0'),
  };
}

// Writes bytes 2-5 of the phone record at offset o. phone = up to 7 digits or null.
export function writePhoneFields(
  buf: Buffer, offset: number,
  { areaCodeIndex, phone }: { areaCodeIndex?: number | null; phone?: string | number | null },
  areaCodeMode = 255,
): void {
  if (areaCodeMode === 10) {
    if (areaCodeIndex != null && !(areaCodeIndex >= 0 && areaCodeIndex <= 9)) throw new Error(`Area-code index ${areaCodeIndex} does not fit 10-area-code mode`);
    const hex = (areaCodeIndex == null ? 'f' : String(areaCodeIndex)) + (phone == null ? 'fffffff' : String(phone).padStart(7, '0'));
    Buffer.from(hex, 'hex').copy(buf, offset + 2);
    return;
  }
  buf[offset + 2] = areaCodeIndex == null ? 0xff : areaCodeIndex;
  if (phone == null) {
    buf.fill(0xff, offset + 3, offset + 6);
    return;
  }
  buf.writeUIntBE(Number(phone), offset + 3, 3);
}
// Packed decimal digits; 0xF nibbles are padding.
export function bcd(bytes: Iterable<number>): string | null {
  let out = '';
  for (const byte of bytes) {
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      if (nibble > 9 && nibble !== 0x0f) return null;
      if (nibble <= 9) out += nibble;
    }
  }
  return out;
}

export const allFF = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0xff);

// phone.bin: 10 bytes per directory code. Bytes 2-5 depend on the area-code mode (see readPhoneFields).
// Byte 8 is packed: bits 0-4 = security level (0-30), bits 5-7 = elevator reference index
// (stored 0-7, shown +1 so 0 -> "1"). Byte 9 = floor number (0xFF = unset). Both confirmed by
// isolated before/after gate pulls (hide lives in names.bin, not here).
export function parsePhoneBin(buf: Buffer, areaCodeMode = 255): PhoneEntry[] {
  const entries: PhoneEntry[] = [];
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= buf.length; offset += PHONE_RECORD_SIZE) {
    const rec = buf.subarray(offset, offset + PHONE_RECORD_SIZE);
    if (allFF(rec.subarray(0, 2))) continue;
    const { areaCodeIndex, phone } = readPhoneFields(rec, areaCodeMode);
    entries.push({
      recordOffset: offset,
      directoryCode: bcd(rec.subarray(0, 2)),
      areaCodeIndex,
      phone: phone && `${phone.slice(0, 3)}-${phone.slice(3)}`,
      entryCode: allFF(rec.subarray(6, 8)) ? null : bcd(rec.subarray(6, 8)),
      securityLevel: rec[8] & 0x1f,
      elevatorRef: (rec[8] >> 5) + 1,
      floor: rec[9] === 0xff ? null : rec[9],
    });
  }
  return entries;
}

// cards.bin: 4 bytes per card: card number (16-bit big-endian), directory code (BCD, F-padded).
export function parseCardsBin(buf: Buffer): CardEntry[] {
  const cards: CardEntry[] = [];
  for (let offset = 0; offset + CARD_RECORD_SIZE <= buf.length; offset += CARD_RECORD_SIZE) {
    const rec = buf.subarray(offset, offset + CARD_RECORD_SIZE);
    if (allFF(rec)) continue;
    cards.push({
      cardNumber: String(rec.readUInt16BE(0)).padStart(5, '0'),
      directoryCode: bcd(rec.subarray(2, 4)),
    });
  }
  return cards;
}

// names.bin: area code table and the A-Z directory (see NAMES_LAYOUTS; settings are decoded by gate-settings.ts).
// Area code table: 2-byte BCD entries (F-padded), indexed by phone.bin's area code index.
// Directory entry (20 bytes): name (15, space padded), flag byte, directory code (bytes 16-19, see namesEntryCode).
export function parseNamesBin(buf: Buffer) {
  const layout = namesLayout(buf);
  const areaCodes: (string | null)[] = [];
  for (let i = 0; i < layout.areaCodeSlots; i++) {
    const offset = layout.areaCodeOffset + i * 2;
    if (offset + 2 > buf.length) break;
    const rec = buf.subarray(offset, offset + 2);
    areaCodes.push(allFF(rec) ? null : bcd(rec));
  }
  while (areaCodes.length && areaCodes[areaCodes.length - 1] === null) areaCodes.pop();
  const directory: DirectoryEntry[] = [];
  for (let offset = layout.directoryOffset; offset + NAMES_ENTRY_SIZE <= buf.length; offset += NAMES_ENTRY_SIZE) {
    const code = namesEntryCode(buf, offset);
    if (!code) break;
    const flag = buf[offset + 15];
    directory.push({
      entryOffset: offset,
      directoryCode: code,
      name: buf.toString('latin1', offset, offset + 15).trimEnd(),
      flag,
      // flag byte 15 bitfield: bit 0 = vendor, bit 5 = shown in directory (clear = hidden).
      vendor: Boolean(flag & 0x01),
      hidden: !(flag & 0x20),
    });
  }
  return { areaCodeMode: layout.areaCodeMode, dirDigits: namesDirDigits(buf), areaCodes, directory };
}

// rcv_out.bin: raw 10-byte transaction records read from the board.
// Hour byte: bits 7-6 = event flags, bit 5 = PM, bits 4-0 = BCD hour (1-12).
// Code type 0x01 = keypad code (BCD), 0x02 = card number (16-bit big-endian).
export function parseRcvOut(buf: Buffer): RcvRecord[] {
  const records: RcvRecord[] = [];
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= buf.length; offset += PHONE_RECORD_SIZE) {
    const rec = buf.subarray(offset, offset + PHONE_RECORD_SIZE);
    const codeType = rec[4];
    const codeBytes = rec.subarray(5, 7);
    let code: string | null = null;
    if (!allFF(codeBytes)) {
      code = codeType === 0x02 ? String(codeBytes.readUInt16BE(0)).padStart(5, '0') : bcd(codeBytes);
    }
    records.push({
      month: Number(bcd([rec[0]])),
      day: Number(bcd([rec[1]])),
      hour: Number(bcd([rec[2] & 0x1f])),
      minute: Number(bcd([rec[3]])),
      pm: Boolean(rec[2] & 0x20),
      eventFlags: rec[2] >> 6,
      codeType,
      code,
      raw: rec.toString('hex'),
    });
  }
  return records;
}

// Event types from DoorKing32's transaction decoder (byte 4 of each rcv_out.bin record).
const SYSTEM_EVENTS: Record<number, string> = { 5: 'H/U', 6: 'Admit', 7: 'Hold', 8: 'Rels', 9: '1 Hour', 10: 'Hr Rel' };
const LINK_EVENTS: Record<number, [string, string]> = {
  0x0d: ['Modem-to-Modem', 'Download Data'], 0x0e: ['Modem-to-Modem', 'Upload Data'],
  0x0f: ['Modem-to-Modem', 'Upload Transaction'], 0x10: ['Modem-to-Modem', 'Unsuccessful'],
  0x11: ['Modem-to-Modem', 'Download Changes Only Data'], 0x12: ['Modem-to-Modem', 'Download Data Failed'],
  0x13: ['Modem-to-Modem', 'Upload Data Failed'], 0x14: ['Modem-to-Modem', 'Upload Transactions Failed'],
  0x15: ['Modem-to-Modem', 'Download Chgs Only Failed'],
  0x16: ['RS232', 'Download Data'], 0x17: ['RS232', 'Upload Data'], 0x18: ['RS232', 'Upload Trans'],
  0x19: ['RS232', 'Download Data - Failed'], 0x1a: ['RS232', 'Upload Data - Failed'],
  0x1b: ['RS232', 'Upload Trans - Failed'], 0x1c: ['RS232', 'Unsuccessful'],
  0x1d: ['RS232', 'Database is Up To Date'], 0x1e: ['Modem', 'Database is Up To Date'],
};
const APB_RESYNC = ['Re-Sync All Manually', 'Re-Sync All By Download', 'Re-Sync One Manually',
  'Re-Sync List By Download', 'Scheduled Re-Sync All'];
const APB_COUNTER = ['Set Facility Counter Manually', 'Set Facility Counter By Download',
  'Users In Facility', 'Dec Facility Counter Past Zero'];
const DEFAULT_RELAY_NAMES = ['Relay 0', 'Entry', 'Exit'];

// Decodes one parsed rcv_out.bin record into the columns of DoorKing32's transaction view.
// Byte 2 bit 6 = admit (else deny); byte 7 = relay (0x12 = relay 0, 0 = relay 1, 1 = relay 2,
// 0xFC-0xFF = combinations). lookup = 'directory' | 'entryCode' | 'card' when the number names a resident.
export function decodeRcvEvent(transaction: { raw: string }, relayNames: string[] = DEFAULT_RELAY_NAMES): RcvEvent {
  const rec = Buffer.from(transaction.raw, 'hex');
  const type = rec[4];
  const isApb = type >= 0x22 && type <= 0x25;
  const [r0, r1, r2] = relayNames;
  const event: RcvEvent = { eventType: '', number: '', name: '', access: '', relay: '', apb: '', lookup: null };

  event.access = !(rec[2] & 0x40) ? 'Deny' : isApb ? 'Open' : 'Admit';
  if (!(type === 5 || (type > 0x0c && !isApb))) {
    const flags = rec[7];
    const combos: Record<number, string[]> = { 0xfc: [r0, r1], 0xfd: [r0, r2], 0xfe: [r1, r2], 0xff: [r0, r1, r2] };
    event.relay = flags === 0x12 ? r0 : flags === 0 ? r1 : flags === 1 ? r2
      : flags >= 2 && flags <= 0x11 ? `Relay code ${flags}`
        : combos[flags]?.join(', ') || '';
  }

  return Object.assign(event, eventDetails(rec, event.access));
}

// The columns that depend on the record type (byte 4); access: the column as decoded from byte 2.
function eventDetails(rec: Buffer, access: string): Partial<RcvEvent> {
  const type = rec[4];
  const card = String(rec.readUInt16BE(5)).padStart(5, '0');
  if (type === 0 || type === 1) {
    return { eventType: type === 0 ? 'Directory' : 'Entry Code', number: bcd(rec.subarray(5, 7)), lookup: type === 0 ? 'directory' : 'entryCode',
      ...(access === 'Deny' && { relay: '' }) };
  }
  if (type === 2) {
    const status = rec.readUInt16BE(5);
    if (status >= 0xff80) return { number: card, access: '', name: status === 0xff80 ? 'Gate Close Edge Activated' : `Board status ${status - 0xff80}` };
    return { eventType: 'Cards', number: card, lookup: 'card' };
  }
  if (type === 4) return { eventType: 'Open Request' };
  if (SYSTEM_EVENTS[type]) return { eventType: 'System', access: SYSTEM_EVENTS[type] };
  if (type === 0x0b || type === 0x0c) return { eventType: type === 0x0b ? 'Hold Begin' : 'Hold End', access: type === 0x0b ? 'Hold' : 'Rels' };
  if (LINK_EVENTS[type]) return { eventType: LINK_EVENTS[type][0], name: LINK_EVENTS[type][1], access: '' };
  if (type === 0x20) {
    return { eventType: 'APB Re-Sync', name: APB_RESYNC[rec[7]] || '', access: '', relay: '', ...((rec[7] === 2 || rec[7] === 3) && { number: card }) };
  }
  if (type === 0x21) return { eventType: 'APB Counter', name: APB_COUNTER[rec[7]] || '', number: card, access: '', relay: '' };
  if (type >= 0x22 && type <= 0x25) {
    return { eventType: type <= 0x23 ? 'APB Okay' : 'APB Violation', apb: type % 2 === 0 ? 'IN' : 'OUT', number: card, lookup: 'card' };
  }
  return { eventType: `Type 0x${type.toString(16).padStart(2, '0')}`, access: '', relay: '' };
}

// A transaction record with a real month and day (the board leaves some blank or garbled).
export const hasValidDate = (record: { month: number; day: number }): boolean =>
  record.month >= 1 && record.month <= 12 && record.day >= 1 && record.day <= 31;

const CLOCK_AHEAD_MS = 2 * 86400000; // how far ahead of the server's clock the gate's may be (orderRcvOut)

// rcv_out.bin is a 10,000-record ring buffer followed by a 6-byte trailer:
// byte 0 = 0x99 when the buffer has wrapped, bytes 3-5 = next write address (0xA0000 + index * 10).
// Returns records oldest -> newest with a year inferred backwards from pulledAt (the board stores no year).
export function orderRcvOut(buf: Buffer, pulledAt: Date = new Date()): RcvRecord[] {
  const records = parseRcvOut(buf);
  let ordered = records;
  if (buf.length % 10 === 6) {
    const trailer = buf.subarray(buf.length - 6);
    const next = (trailer.readUIntBE(3, 3) - 0xa0000) / 10;
    if (Number.isInteger(next) && next >= 0 && next <= records.length) {
      ordered = trailer[0] === 0x99
        ? [...records.slice(next), ...records.slice(0, next)]
        : records.slice(0, next);
    }
  }
  // Walking back from the newest, a record dated after the newer one belongs to the year before. A gate clock may run
  // up to CLOCK_AHEAD_MS ahead of the server's (so the newest records may even be in the next year), and records with
  // no valid date are skipped (they get the year of the record after them).
  const dayOf = (year: number, record: RcvRecord) => Date.UTC(year, record.month - 1, record.day);
  let year = pulledAt.getFullYear();
  let newer = Date.UTC(year, pulledAt.getMonth(), pulledAt.getDate()) + CLOCK_AHEAD_MS;
  const newest = ordered.findLastIndex(hasValidDate);
  if (newest >= 0 && dayOf(year + 1, ordered[newest]) <= newer) year++;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hasValidDate(ordered[i])) {
      if (dayOf(year, ordered[i]) > newer) year--;
      newer = dayOf(year, ordered[i]);
    }
    ordered[i] = { ...ordered[i], year };
  }
  return ordered;
}

// .MAP: indexes of 128-byte blocks flagged as changed.
export function parseMap(buf: Buffer): { blocks: number; changedBlocks: number[]; blockSize: number } {
  const changedBlocks: number[] = [];
  buf.forEach((changed, i) => changed && changedBlocks.push(i));
  return { blocks: buf.length, changedBlocks, blockSize: BLOCK_SIZE };
}

// DKS Cloud transfers files as hex text (two digits per byte). Anything else is a message, not a file (for example
// "Session not found"), and is refused with its start.
export function decodeFileText(text: unknown): Buffer {
  const hex = String(text).trim();
  if (/^([0-9a-f]{2})*$/i.test(hex)) return Buffer.from(hex, 'hex');
  throw new Error(`DKS Cloud sent something other than a file: ${hex.slice(0, 80)}`);
}

// Hex text for SendResidentData (DoorKing32 writes two hex digits per byte).
export const encodeFileText = (buf: Uint8Array): string => Buffer.from(buf).toString('hex').toUpperCase();

// The two counts DoorKing32 embeds in the send session's UserID as "{residents,vendors}"
// (DoorKing32 FUN_004f7320 counts resident records with FL 0 and FL 2). Both are directory
// facts, so we derive them from names.bin instead of reading RESIDENT.DAT:
//   vendors   = directory entries with the vendor flag bit set (flag & 1), the FL 2 records;
//   residents = every other occupied directory entry, the FL 0 records.
// Confirmed against the sample data: flag&1 reproduces the vendor count exactly, and
// residents + vendors equals the occupied directory size (the binary's memory-fit guard).
export function namesResidentCounts(buf: Buffer): [number, number] {
  const { directory } = parseNamesBin(buf);
  const vendors = directory.filter((entry) => (entry.flag & 1) === 1).length;
  return [directory.length - vendors, vendors];
}

// The same join from buffers ({ names, phone, cards }; any may be missing).
export function residentRows(bufs: { names?: Buffer | null; phone?: Buffer | null; cards?: Buffer | null }): ResidentsData {
  const names = bufs.names && { data: bufs.names };
  const phones = bufs.phone && { data: bufs.phone };
  const cards = bufs.cards && { data: bufs.cards };
  const rows = new Map<string, ResidentRow>();
  const row = (code: string): ResidentRow => {
    if (!rows.has(code)) {
      rows.set(code, {
        directoryCode: code, name: '', type: 'Resident', hidden: false,
        areaCode: '', areaCodeIndex: null, phone: '', entryCode: '',
        securityLevel: '', elevatorRef: '', floor: '', cards: [],
        entryOffset: null, recordOffset: null,
      });
    }
    return rows.get(code)!;
  };
  const namesBin = names && parseNamesBin(names.data);
  // A directory entry's flag byte (byte 15): bit 0 = vendor, bit 5 = shown (clear = hidden).
  if (namesBin) for (const entry of namesBin.directory) Object.assign(row(entry.directoryCode), {
    name: entry.name, type: entry.vendor ? 'Vendor' : 'Resident', hidden: entry.hidden, entryOffset: entry.entryOffset,
  });
  if (phones) {
    for (const record of parsePhoneBin(phones.data, namesBin ? namesBin.areaCodeMode : 255)) {
      if (record.directoryCode === null) continue; // not decimal: left out (its bytes are kept as they are)
      const areaCode = (namesBin && record.areaCodeIndex !== null && namesBin.areaCodes[record.areaCodeIndex]) || '';
      Object.assign(row(record.directoryCode), {
        areaCode, areaCodeIndex: record.areaCodeIndex, phone: record.phone || '', entryCode: record.entryCode || '',
        securityLevel: record.securityLevel, elevatorRef: record.elevatorRef, floor: record.floor == null ? '' : record.floor,
        recordOffset: record.recordOffset,
      });
    }
  }
  const unassignedCards: string[] = [];
  if (cards) {
    for (const card of parseCardsBin(cards.data)) (card.directoryCode ? row(card.directoryCode).cards : unassignedCards).push(card.cardNumber);
  }
  const list = [...rows.values()].sort((a, b) => a.directoryCode.localeCompare(b.directoryCode));
  return { rows: list, unassignedCards };
}
