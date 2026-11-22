import { allFF, bcd, BLOCK_SIZE } from './board-files.ts';
import { httpError } from './errors.ts';

/**
 * Gate settings read directly from names.bin (positions from DoorKing32's send builder, FUN_004aad40).
 * Only fields whose position and encoding are confirmed are editable; the rest are shown read-only.
 */
const DISPLAY_LINES_OFFSET = 0x190;
const HOLIDAY_OFFSET = 0x9c3;
const HOLIDAY_ROWS = 32;

/** maxLength: text types only, the most characters encode accepts. */
export interface FieldType { size: number; decode: (b: Buffer) => string; encode?: (v: string) => Buffer; maxLength?: number }
export interface GateSettingField {
  key: string; group: string; name: string; offset: number; type: FieldType; editable?: boolean; secret?: boolean; note?: string;
}
export interface GateSetting {
  key: string; group: string; name: string; offset: number; size: number; value: string;
  editable: boolean; secret: boolean; note: string | null; maxLength: number | null;
}

const toBcd = (value: number): number => ((Math.floor(value / 10) << 4) | (value % 10));
const fieldType = (type: FieldType): FieldType => type;
/**
 * The bytes of a "? (0x7)" or "? (005da0013491)" value (shown for bytes a type can't name), or null.
 *
 * @param v - `string` value.
 * @param size - Byte length or count.
 * @returns `Buffer | null` result.
 */
function rawValue(v: string, size: number): Buffer | null {
  const match = /^\? \((0x)?([0-9a-f]+)\)$/i.exec(v);
  if (!match) return null;
  if (match[1]) return size === 1 && match[2].length <= 2 ? Buffer.from([parseInt(match[2], 16)]) : null;
  return match[2].length === size * 2 ? Buffer.from(match[2], 'hex') : null;
}

/** Field types: size in bytes, decode(bytes) -> string, encode(string) -> Buffer (throws when invalid). */
const TYPES = {
  text: (size: number): FieldType => ({
    size,
    maxLength: size,
    decode: (buffer) => buffer.toString('latin1').trimEnd(),
    encode: (value) => {
      if (value.length > size || !/^[\x20-\x7e]*$/.test(value)) throw new Error(`up to ${size} printable characters`);
      return Buffer.from(value.padEnd(size), 'latin1');
    },
  }),
  tone: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? '' : buffer[0] >= 1 && buffer[0] <= 9 ? String(buffer[0]) : `? (0x${buffer[0].toString(16)})`),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff]);
      if (!/^[1-9]$/.test(value)) throw new Error('a digit 1-9, or blank for none');
      return Buffer.from([Number(value)]);
    },
  }),
  digit: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? '' : buffer[0] <= 9 ? String(buffer[0]) : `? (0x${buffer[0].toString(16)})`),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff]);
      if (!/^[0-9]$/.test(value)) throw new Error('a digit 0-9, or blank for none');
      return Buffer.from([Number(value)]);
    },
  }),
  code4: fieldType({
    size: 2,
    decode: (buffer) => (allFF(buffer) ? '' : bcd(buffer) ?? `? (${buffer.toString('hex')})`),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{4}$/.test(value)) throw new Error('4 digits, or blank');
      return Buffer.from(value, 'hex');
    },
  }),
  holiday: fieldType({
    size: 2,
    decode: (buffer) => {
      if (allFF(buffer)) return '';
      const month = bcd(buffer.subarray(0, 1));
      const day = bcd(buffer.subarray(1, 2));
      return month && day ? `${Number(month)}/${Number(day)}` : `? (${buffer.toString('hex')})`;
    },
    encode: (value) => {
      if (value === '') return Buffer.from([0xff, 0xff]);
      const match = /^(\d{1,2})\/(\d{1,2})$/.exec(value);
      if (!match || +match[1] < 1 || +match[1] > 12 || +match[2] < 1 || +match[2] > 31) throw new Error('month/day such as 12/25, or blank');
      return Buffer.from([toBcd(+match[1]), toBcd(+match[2])]);
    },
  }),
  digits: (size: number): FieldType => ({ size, decode: (buffer) => [...buffer].map((byte) => (byte <= 9 ? String(byte) : byte === 0x0a ? '0' : '')).join('') }),
  /** Talk time: one byte of seconds (DoorKing32 writes minutes * 60 + seconds), shown as m:ss. 0xFF = unset. */
  seconds: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? '' : `${Math.floor(buffer[0] / 60)}:${String(buffer[0] % 60).padStart(2, '0')}`),
    encode: (value) => {
      if (value.trim() === '') return Buffer.from([0xff]);
      const match = /^(?:(\d{1,2}):)?(\d{1,3})$/.exec(value.trim());
      const secs = match ? Number(match[1] || 0) * 60 + Number(match[2]) : NaN;
      if (!match || (match[1] !== undefined && Number(match[2]) > 59) || !(secs >= 0 && secs <= 254)) {
        throw new Error('m:ss (or seconds) from 0:00 to 4:14');
      }
      return Buffer.from([secs]);
    },
  }),
  byte: fieldType({
    size: 1,
    decode: (buffer) => String(buffer[0]),
    encode: (value) => {
      if (!/^\d{1,3}$/.test(value) || Number(value) > 255) throw new Error('a number 0-255');
      return Buffer.from([Number(value)]);
    },
  }),
  /** Facility code: 16-bit big-endian, 0xFFFF = blank. */
  code16: fieldType({
    size: 2,
    decode: (buffer) => (allFF(buffer) ? '' : String((buffer[0] << 8) | buffer[1])),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('a number 0-65535, or blank');
      return Buffer.from([(Number(value) >> 8) & 0xff, Number(value) & 0xff]);
    },
  }),
  /** Facility code: stored like code16, but valid codes are 000-255 (DoorKing manual 3.7.1). */
  facility: fieldType({
    size: 2,
    decode: (buffer) => (allFF(buffer) ? '' : String((buffer[0] << 8) | buffer[1])),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{1,3}$/.test(value) || Number(value) > 255) throw new Error('a facility code 0-255, or blank');
      return Buffer.from([0, Number(value)]);
    },
  }),
  /** On/off flag where 0x00 = on and 0xFF = off (facility codes enable). */
  onoff: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? 'No' : 'Yes'),
    encode: (value) => Buffer.from([/^(yes|on|1|true)$/i.test(value) ? 0x00 : 0xff]),
  }),
  /** Hold-open time: hour byte (0x80 set, 0x20 PM, low 5 = BCD hour 1-12) + BCD minute. Value is 24h "HH:MM". */
  holdTime: fieldType({
    size: 2,
    decode: (buffer) => {
      if (buffer[0] === 0xff) return '';
      const h12 = bcd(Buffer.from([buffer[0] & 0x1f]));
      const min = bcd(buffer.subarray(1, 2));
      if (h12 === null || min === null) return '';
      const h24 = (Number(h12) % 12) + ((buffer[0] & 0x20) ? 12 : 0);
      return `${String(h24).padStart(2, '0')}:${min.padStart(2, '0')}`;
    },
    encode: (value) => {
      if (value === '') return Buffer.from([0xff, 0xff]);
      const match = /^(\d{1,2}):(\d{2})$/.exec(value);
      if (!match || +match[1] > 23 || +match[2] > 59) throw new Error('time as HH:MM (24-hour), or blank');
      const h24 = +match[1];
      const h12 = (h24 % 12) || 12;
      return Buffer.from([0x80 | (h24 >= 12 ? 0x20 : 0) | toBcd(h12), toBcd(+match[2])]);
    },
  }),
  /**
   * Day mask: bit 7 = Sun … bit 1 = Sat, as a 7-char "0"/"1" string. 0xFF = not set: '' (kept apart from 0x00, no days).
   */
  dayMask: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? ''
      : Array.from({ length: 7 }, (_, day) => ((buffer[0] & (1 << (7 - day))) ? '1' : '0')).join('')),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff]);
      let byte = 0;
      for (let d = 0; d < 7; d++) if (value[d] === '1') byte |= 1 << (7 - d);
      return Buffer.from([byte]);
    },
  }),
  /** Elevator bitmap: elevator e (1-8) is bit (e-1). Value is an 8-char "0"/"1" string. 0x00 = none. */
  elevatorMask: fieldType({
    size: 1,
    decode: (buffer) => Array.from({ length: 8 }, (_, elevator) => ((buffer[0] & (1 << elevator)) ? '1' : '0')).join(''),
    encode: (value) => {
      let byte = 0;
      for (let e = 0; e < 8; e++) if (value[e] === '1') byte |= 1 << e;
      return Buffer.from([byte]);
    },
  }),
  /**
   * Text stored in a `size`-byte space-padded slot but limited to `max` input characters (e.g. the
   * single-line System Message: a 48-byte slot the gate only accepts 27 usable characters in; the gate
   * needs the space padding to 48 bytes for its marquee scrolling).
   */
  textMax: (size: number, max: number): FieldType => ({
    size,
    maxLength: max,
    decode: (buffer) => buffer.toString('latin1').trimEnd(),
    encode: (value) => {
      if (value.length > max || !/^[\x20-\x7e]*$/.test(value)) throw new Error(`up to ${max} printable characters`);
      return Buffer.from(value.padEnd(size), 'latin1');
    },
  }),
  /** Elevator hold time: one byte of seconds, 0xFF = unset. */
  elevatorSeconds: fieldType({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? '' : String(buffer[0])),
    encode: (value) => {
      if (value === '') return Buffer.from([0xff]);
      if (!/^\d{1,3}$/.test(value) || Number(value) > 254) throw new Error('seconds 0-254, or blank');
      return Buffer.from([Number(value)]);
    },
  }),
  /**
   * Security relays: 3 bytes (big-endian), relay r (0-18) at bit (r+5). Value is a 19-char "0"/"1" string.
   * All-0xFF is the unused-record filler (bits 0-4 can never be a real relay), so it reads as none.
   */
  relayMask: fieldType({
    size: 3,
    decode: (buffer) => {
      if (buffer[0] === 0xff && buffer[1] === 0xff && buffer[2] === 0xff) return '0'.repeat(19);
      const v = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];
      return Array.from({ length: 19 }, (_, relay) => ((v & (1 << (relay + 5))) ? '1' : '0')).join('');
    },
    encode: (value) => {
      let bits = 0;
      for (let r = 0; r < 19; r++) if (value[r] === '1') bits |= 1 << (r + 5);
      return Buffer.from([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff]);
    },
  }),
  /**
   * Security floors: 8 bytes, floor f (1-64) at byte (7 - (f-1)>>3) of this field, bit (f-1)&7.
   * Value is a comma-separated list of floor numbers. All-0xFF is the unused-record filler (reads as none).
   */
  floorMask: fieldType({
    size: 8,
    decode: (buffer) => {
      if (buffer.every((byte) => byte === 0xff)) return '';
      const floors: number[] = [];
      for (let f = 1; f <= 64; f++) if (buffer[7 - ((f - 1) >> 3)] & (1 << ((f - 1) & 7))) floors.push(f);
      return floors.join(',');
    },
    encode: (value) => {
      const buf = Buffer.alloc(8, 0);
      for (const part of value.split(',').map((piece) => piece.trim()).filter(Boolean)) {
        const floor = Number(part);
        if (!Number.isInteger(floor) || floor < 1 || floor > 64) throw new Error('floors 1-64, comma-separated');
        buf[7 - ((floor - 1) >> 3)] |= 1 << ((floor - 1) & 7);
      }
      return buf;
    },
  }),
  /** One choice stored as a byte: names[0] = 0xFF, names[i] = i. */
  choice: (names: string[]): FieldType => ({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? names[0] : names[buffer[0]] ?? `? (0x${buffer[0].toString(16)})`),
    encode: (value) => {
      const i = names.indexOf(value);
      if (i < 0) throw new Error(`one of ${names.join(', ')}`);
      return Buffer.from([i === 0 ? 0xff : i]);
    },
  }),
  /**
   * Read-only (written back only from the stored value, never edited). The read-only types encode every value
   * they decode, "? (...)" included, so the files rebuild exactly. A flag DoorKing32 writes like a digit:
   * 0x01 = on, 0x0A (digit 0) = off.
   */
  digitFlag: (on: string, off: string): FieldType => ({
    size: 1,
    decode: (buffer) => (buffer[0] === 0x01 ? on : buffer[0] === 0x0a ? off : buffer[0] === 0xff ? '' : `? (0x${buffer[0].toString(16)})`),
    encode: (value) => {
      const b = value === on ? Buffer.from([0x01]) : value === off ? Buffer.from([0x0a]) : value === '' ? Buffer.from([0xff]) : rawValue(value, 1);
      if (!b) throw new Error(`${on}, ${off} or blank`);
      return b;
    },
  }),
  /** Read-only. One byte naming a value (names[byte]); 0xFF = none. */
  named: (names: Record<number, string>): FieldType => ({
    size: 1,
    decode: (buffer) => (buffer[0] === 0xff ? '' : names[buffer[0]] ?? `? (0x${buffer[0].toString(16)})`),
    encode: (value) => {
      const i = Object.entries(names).find(([, label]) => label === value)?.[0];
      const b = i !== undefined ? Buffer.from([Number(i)]) : value === '' ? Buffer.from([0xff]) : rawValue(value, 1);
      if (!b) throw new Error(`one of ${Object.values(names).join(', ')}, or blank`);
      return b;
    },
  }),
  /** Read-only. A Unix time, 4 bytes little-endian, shown as "YYYY-MM-DD HH:MM:SS UTC". All 0xFF = none. */
  unixTime: fieldType({
    size: 4,
    decode: (buffer) => {
      if (allFF(buffer)) return '';
      const seconds = buffer.readUInt32LE(0);
      if (seconds < 946684800 || seconds >= 4102444800) return `? (${buffer.toString('hex')})`;
      return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    },
    encode: (value) => {
      if (value === '') return Buffer.alloc(4, 0xff);
      const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(value);
      const seconds = match ? Date.parse(`${match[1]}T${match[2]}Z`) / 1000 : NaN;
      const b = Number.isInteger(seconds) && seconds >= 946684800 && seconds < 4102444800 ? Buffer.alloc(4) : rawValue(value, 4);
      if (!b) throw new Error('a time as YYYY-MM-DD HH:MM:SS UTC, or blank');
      if (match) b.writeUInt32LE(seconds, 0);
      return b;
    },
  }),
  /**
   * Read-only. The system memory (number of directory codes), from the two 24-bit big-endian end addresses
   * DoorKing32 writes: the directory area's (0xF80 + memory * 20), then phone.bin's (0x10D80 + memory * 10).
   */
  memorySize: fieldType({
    size: 6,
    decode: (buffer) => {
      if (allFF(buffer)) return '';
      const index = (buffer.readUIntBE(0, 3) - 0xf80) / 20;
      return Number.isInteger(index) && index > 0 && buffer.readUIntBE(3, 3) === 0x10d80 + index * 10 ? String(index) : `? (${buffer.toString('hex')})`;
    },
    encode: (value) => {
      if (value === '') return Buffer.alloc(6, 0xff);
      if (/^\d{1,5}$/.test(value) && +value > 0) {
        const b = Buffer.alloc(6);
        b.writeUIntBE(0xf80 + +value * 20, 0, 3);
        b.writeUIntBE(0x10d80 + +value * 10, 3, 3);
        return b;
      }
      const b = rawValue(value, 6);
      if (!b) throw new Error('a memory size such as 3000, or blank');
      return b;
    },
  }),
  /**
   * Anti-pass back relay row: up to 10 relay numbers (0-18), sorted, 0xFF = empty. Value is a comma-separated list.
   */
  relayList: fieldType({
    size: 10,
    decode: (buffer) => {
      const list = [...buffer].filter((byte) => byte !== 0xff);
      if (list.some((byte) => byte > 18)) return `? (${buffer.toString('hex')})`;
      return [...new Set(list)].sort((a, b) => a - b).join(',');
    },
    encode: (value) => {
      const list = [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean).map(Number))];
      if (list.some((relay) => !Number.isInteger(relay) || relay < 0 || relay > 18)) throw new Error('relays 0-18, comma-separated');
      if (list.length > 10) throw new Error('up to 10 relays');
      const buf = Buffer.alloc(10, 0xff);
      list.sort((a, b) => a - b).forEach((relay, i) => { buf[i] = relay; });
      return buf;
    },
  }),
  /**
   * Re-Sync List: enable byte (0x00 = on) + 5 big-endian numbers (0x0000 = empty box); all 0xFF when off.
   * Value is '' when off, else the 5 boxes comma-separated (blank boxes allowed).
   */
  resyncList: fieldType({
    size: 11,
    decode: (buffer) => (buffer[0] === 0xff ? '' : Array.from({ length: 5 }, (_, i) => {
      const number = (buffer[1 + i * 2] << 8) | buffer[2 + i * 2];
      return number ? String(number) : '';
    }).join(',')),
    encode: (value) => {
      const buf = Buffer.alloc(11, 0xff);
      if (value === '') return buf;
      const slots = value.split(',').map((part) => part.trim());
      if (slots.length !== 5) throw new Error('5 comma-separated boxes (blank allowed), or blank for off');
      buf[0] = 0;
      slots.forEach((slot, i) => {
        if (slot !== '' && (!/^\d{1,5}$/.test(slot) || +slot < 1 || +slot > 65535)) throw new Error('numbers 1-65535, or blank');
        const number = slot === '' ? 0 : +slot;
        buf[1 + i * 2] = number >> 8;
        buf[2 + i * 2] = number & 0xff;
      });
      return buf;
    },
  }),
  /**
   * Scheduled re-sync days: 7 bytes Sat..Sun; day d (0=Sun..6=Sat) at byte (6-d) holds (7-d) when ticked,
   * 0xFF when not. Value is a 7-char "0"/"1" string, Sun..Sat.
   */
  dayList: fieldType({
    size: 7,
    decode: (buffer) => Array.from({ length: 7 }, (_, day) => (buffer[6 - day] === 0xff ? '0' : '1')).join(''),
    encode: (value) => {
      const buf = Buffer.alloc(7, 0xff);
      for (let d = 0; d < 7; d++) if (value[d] === '1') buf[6 - d] = 7 - d;
      return buf;
    },
  }),
};

const DISPLAY_LINE_NAMES = ['User message line 1', 'User message line 2', 'User message line 3', 'User message line 4',
  'Instructions line 1', 'Instructions line 2', 'Instructions line 3', 'Instructions line 4'];
const TONES = [['Momentary', 'ToneMomentary'], ['Hold', 'ToneHold'], ['Release', 'ToneRelease'], ['Hold 1 Hr', 'ToneHold1Hr']];
const TONE_OFFSETS: Record<number, number> = { 0: 0x58, 1: 0x07, 2: 0x0b };

/** key, group, name, offset, type, editable, secret, note. */
const FIELDS: GateSettingField[] = [
  { key: 'masterCode', group: 'System', name: 'Master code', offset: 0x00, type: TYPES.digits(4), secret: true },
  { key: 'talkTime', group: 'System', name: 'Talk time (m:ss)', offset: 0x10, type: TYPES.seconds, editable: true },
  // "Dial _ First, then Dial Phone Number": 0xFF = none, else the digit 0-9 (confirmed with 9, 0 and blank).
  { key: 'outsideLineDigit', group: 'System', name: 'Outside line digit (dialed before the phone number)', offset: 0x1d,
    type: TYPES.digit, editable: true },
  // From the decompiled DoorKing32 (send builders FUN_004aad40 / FUN_004b0020, settings report FUN_0050e9d0, receive
  // checks FUN_0045b490), checked against a pull; read-only until confirmed by one-change diffs.
  { key: 'dialType', group: 'System', name: 'Dial type', offset: 0x0f, type: TYPES.digitFlag('Rotary', 'Tone') },
  { key: 'multipleSystems', group: 'System', name: 'Multiple systems (sharing the resident database)', offset: 0x06,
    type: TYPES.digitFlag('Yes', 'No') },
  { key: 'systemMemory', group: 'System', name: 'System memory', offset: 0xbf, type: TYPES.memorySize },
  // The board's memory chips; DoorKing32 writes its MemPLUS choice (0/1) here, and on a receive expects 0x05 for an
  // anti-pass back account, 0x01 for MemPLUS, 0x00 otherwise.
  { key: 'memoryChips', group: 'System', name: 'Memory chips (reported by the gate)', offset: 0xfb,
    type: TYPES.named({ 0: 'Standard', 1: 'MemPLUS', 5: 'Anti-pass back' }) },
  // Written by the program that last sent to the gate; DoorKing32 compares them on a receive and switches to
  // "Send All Data because another PC has downloaded to this System" when they differ from its own copy.
  { key: 'downloadStamp1', group: 'System', name: 'Last download stamp 1', offset: 0x15, type: TYPES.unixTime },
  { key: 'downloadStamp2', group: 'System', name: 'Last download stamp 2', offset: 0x19, type: TYPES.unixTime },
  // Relay strike times (seconds). Confirmed by setting distinct values: relay 0 lives at 0x11 (after talk
  // time 0x10), relays 1 and 2 at 0x04/0x05.
  ...[[0, 0x11], [1, 0x04], [2, 0x05]].map(([relay, offset]) => ({
    key: `relay${relay}Time`, group: 'Relays', name: `Relay ${relay} strike time (seconds)`, offset, type: TYPES.byte, editable: true,
  })),
  ...[0, 1, 2].flatMap((relay) => TONES.map(([name, suffix], i) => ({
    key: `relay${relay}${suffix}`, group: 'Relays', name: `Relay ${relay} tone open: ${name}`, offset: TONE_OFFSETS[relay] + i,
    type: TYPES.tone, editable: true,
  }))),
  // Postal switch and rotary dial 9: which relays they activate, a bitmask byte each (bit r = relay r), confirmed
  // by one-change diffs of DoorKing32's output (BAK\ACCT0001_tracker5/6). Same 8-bit layout as elevatorMask.
  { key: 'relayPostalSwitch', group: 'Relays', name: 'Postal switch activates relays', offset: 0x41, type: TYPES.elevatorMask, editable: true },
  { key: 'relayRotaryDial9', group: 'Relays', name: 'Rotary dial 9 activates relays', offset: 0x42, type: TYPES.elevatorMask, editable: true },
  // Entry code ranges, one per relay, 4 bytes apart: relay 0 at 0xac, relay 1 at 0xb0, relay 2 at 0xb4 (From, then
  // To, 2-byte BCD each; confirmed by one-change diffs, BAK\ACCT0001_tracker7/8).
  ...[[0, 0xac], [1, 0xb0], [2, 0xb4]].flatMap(([relay, base]) => ['From', 'To'].map((end, i) => ({
    key: `relay${relay}EntryCodeRange${end}`, group: 'Relays', name: `Relay ${relay} entry code range: ${end.toLowerCase()}`,
    offset: base + i * 2, type: TYPES.code4, editable: true,
  }))),
  ...DISPLAY_LINE_NAMES.map((name, i) => ({
    key: `displayLine${i + 1}`, group: 'Display (8 line)', name, offset: DISPLAY_LINES_OFFSET + i * 20, type: TYPES.text(20),
    editable: true,
  })),
  // Single-line mode: System Message (48-byte slot, 27 chars max, space-padded to 48 bytes because the gate
  // scrolls it as a marquee) and System Instruction (52 bytes).
  { key: 'systemMessage', group: 'Display (single line)', name: 'System message', offset: 0x114, type: TYPES.textMax(48, 27), editable: true },
  { key: 'systemInstruction', group: 'Display (single line)', name: 'System instruction', offset: 0x145, type: TYPES.textMax(52, 52), editable: true },
  ...Array.from({ length: HOLIDAY_ROWS }, (_, i) => ({
    key: `holiday${i + 1}`, group: 'Holidays', name: `Holiday row ${i + 1}`, offset: HOLIDAY_OFFSET + i * 2,
    type: TYPES.holiday, editable: true,
  })),
  // "Holidays for Security Levels": TZ4 of every security level becomes the Holiday time zone. Right after the 32
  // holiday rows; 0x00 = on, 0xFF = off (confirmed by a one-change diff, BAK\ACCT0001_hol1).
  { key: 'holidaysForSecurity', group: 'Holidays', name: 'Holidays for Security Levels', offset: 0xa03, type: TYPES.onoff, editable: true },
  { key: 'facilityEnabled', group: 'Facility Codes', name: 'Facility codes enabled', offset: 0x32, type: TYPES.onoff, editable: true },
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `facilityCode${i + 1}`, group: 'Facility Codes', name: `Facility code ${i + 1}`, offset: 0x1e + i * 2,
    type: TYPES.facility, editable: true,
  })),
  // Hold-open: 8 rows (1-7 + Holiday), 5 bytes each at 0x6f — begin (2), end (2), day bitmap (1).
  ...([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4], ['6', 5], ['7', 6], ['Hol', 7]] as [string, number][]).flatMap(([label, i]) => [
    { key: `holdOpen${label}Begin`, group: 'Hold Open', name: `Row ${label} begin`, offset: 0x6f + i * 5, type: TYPES.holdTime, editable: true },
    { key: `holdOpen${label}End`, group: 'Hold Open', name: `Row ${label} end`, offset: 0x6f + i * 5 + 2, type: TYPES.holdTime, editable: true },
    { key: `holdOpen${label}Days`, group: 'Hold Open', name: `Row ${label} days`, offset: 0x6f + i * 5 + 4, type: TYPES.dayMask, editable: true },
  ]),
  // Hold-open relays: one byte per relay 0-18 at 0x5c, bit i = row i (bit 7 = Holiday). Same 8-bit layout
  // as elevatorMask: value is an 8-char "0"/"1" string, rows 1-7 then Hol.
  ...Array.from({ length: 19 }, (_, relay) => ({
    key: `holdOpenRelay${relay}`, group: 'Hold Open', name: `Relay ${relay} hold-open rows`, offset: 0x5c + relay, type: TYPES.elevatorMask, editable: true,
  })),
  // Elevator Reference table (ER1-ER8, the resident's "Elevator reference"): elevators a visitor may use (bitmap at
  // 0xc6) and how long the floor button stays active (seconds at 0x97). Keys keep their original elevatorN names.
  ...Array.from({ length: 8 }, (_, i) => [
    { key: `elevator${i + 1}Elevators`, group: 'Elevator', name: `ER${i + 1} elevators`, offset: 0xc6 + i, type: TYPES.elevatorMask, editable: true },
    { key: `elevator${i + 1}Time`, group: 'Elevator', name: `ER${i + 1} floor button time (s)`, offset: 0x97 + i, type: TYPES.elevatorSeconds, editable: true },
  ]).flat(),
  // Relay / Elevator table: which elevators (bit e-1 = elevator e) each relay 0-18 controls. Relay 0 at 0xf7, relays
  // 1-18 at 0x230 + relay (0x230 itself is not part of it). Confirmed for relays 0, 2 and 5 by one-change diffs
  // (BAK\ACCT0001_elev1-3); the other relays follow the spacing.
  ...Array.from({ length: 19 }, (_, relay) => ({
    key: `relay${relay}Elevators`, group: 'Relay Elevator', name: `Relay ${relay} elevators`, offset: relay === 0 ? 0xf7 : 0x230 + relay,
    type: TYPES.elevatorMask, editable: true,
  })),
  // Security levels: 116 records (levels 2-30, TZ1-4) of 16 bytes at 0x243 — begin (2), end (2), days (1), relays (3), floors (8).
  ...Array.from({ length: 116 }, (_, i) => {
    const level = 2 + (i >> 2); const tz = (i & 3) + 1; const offset = 0x243 + i * 16; const k = `sec${level}tz${tz}`;
    return [
      { key: `${k}Begin`, group: 'Security', name: `L${level} TZ${tz} begin`, offset: offset, type: TYPES.holdTime, editable: true },
      { key: `${k}End`, group: 'Security', name: `L${level} TZ${tz} end`, offset: offset + 2, type: TYPES.holdTime, editable: true },
      { key: `${k}Days`, group: 'Security', name: `L${level} TZ${tz} days`, offset: offset + 4, type: TYPES.dayMask, editable: true },
      { key: `${k}Relays`, group: 'Security', name: `L${level} TZ${tz} relays`, offset: offset + 5, type: TYPES.relayMask, editable: true },
      { key: `${k}Floors`, group: 'Security', name: `L${level} TZ${tz} floors`, offset: offset + 8, type: TYPES.floorMask, editable: true },
    ];
  }).flat(),
  // Anti-Pass Back (block 20), confirmed by diffing DoorKing32's output one change at a time.
  { key: 'apbMode', group: 'Anti-Pass Back', name: 'True Anti Passback', offset: 0xa04,
    type: TYPES.choice(['Off', 'Passive', 'Active', 'Trap']), editable: true },
  { key: 'apbRelaysIn', group: 'Anti-Pass Back', name: 'Relays In', offset: 0xa05, type: TYPES.relayList, editable: true },
  { key: 'apbRelaysOut', group: 'Anti-Pass Back', name: 'Relays Out', offset: 0xa0f, type: TYPES.relayList, editable: true },
  { key: 'apbCounterEvery', group: 'Anti-Pass Back', name: 'Record Facility Counter Every', offset: 0xa19,
    type: TYPES.choice(['Off', '15 Mins', '30 Mins', 'Hour']), editable: true },
  { key: 'apbCounterReset', group: 'Anti-Pass Back', name: 'Reset Facility Counter to', offset: 0xa29, type: TYPES.code16, editable: true },
  { key: 'apbResyncAll', group: 'Anti-Pass Back', name: 'Re-Sync All Devices', offset: 0xa2b, type: TYPES.onoff, editable: true },
  { key: 'apbResyncList', group: 'Anti-Pass Back', name: 'Re-Sync List', offset: 0xa2c, type: TYPES.resyncList, editable: true },
  { key: 'apbScheduleEnabled', group: 'Anti-Pass Back', name: 'Enable Scheduled Re-Sync All', offset: 0xa37, type: TYPES.onoff, editable: true },
  { key: 'apbScheduleDays', group: 'Anti-Pass Back', name: 'Scheduled Re-Sync All days', offset: 0xa38, type: TYPES.dayList, editable: true },
  { key: 'apbScheduleTime', group: 'Anti-Pass Back', name: 'Scheduled Re-Sync All time', offset: 0xa3f, type: TYPES.holdTime, editable: true },
];
const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));
/**
 * Fields the board files are built from: every setting with an encoder except the master code (kept out of the
 * values tables; see gate-state.ts). Users may change only the editable ones.
 */
export const WRITTEN_FIELDS = FIELDS.filter((field) => field.type.encode && !field.secret);
const MIN_SIZE = Math.max(...FIELDS.map((field) => field.offset + field.type.size));

function checkSize(buf: Buffer): void {
  if (buf.length < MIN_SIZE) throw new Error(`names.bin is too short (${buf.length} bytes) to contain the settings`);
}

/**
 * names.bin -> list of settings with their current values.
 *
 * @param buf - Binary board file buffer.
 * @returns `GateSetting[]` result.
 */
export function decodeGateSettings(buf: Buffer): GateSetting[] {
  checkSize(buf);
  return FIELDS.map((field) => ({
    key: field.key, group: field.group, name: field.name, offset: field.offset, size: field.type.size,
    value: field.type.decode(buf.subarray(field.offset, field.offset + field.type.size)),
    editable: Boolean(field.editable), secret: Boolean(field.secret), note: field.note || null, maxLength: field.type.maxLength ?? null,
  }));
}

/**
 * Returns a copy of names.bin with the changed settings written in place, the list of changed bytes and a
 * names.map (one byte per 128-byte block, 1 = block changed). All other bytes stay as pulled from the gate.
 *
 * @param buf - Binary board file buffer.
 * @param changes - Map of setting keys to new values.
 * @returns Operation result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function applyGateSettings(buf: Buffer, changes: Record<string, unknown> | null | undefined) {
  checkSize(buf);
  const out = Buffer.from(buf);
  const changed: { key: string; name: string; from: string; to: string }[] = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const field = BY_KEY.get(key);
    if (!field) throw httpError(`Unknown setting ${key}`);
    if (!field.editable) throw httpError(`${field.name} is read-only`);
    const value = String(raw ?? '');
    let bytes: Buffer;
    try { bytes = field.type.encode!(value); } catch (err) { throw httpError(`${field.name}: ${(err as Error).message}`); }
    const from = field.type.decode(buf.subarray(field.offset, field.offset + field.type.size));
    bytes.copy(out, field.offset);
    if (!bytes.equals(buf.subarray(field.offset, field.offset + field.type.size))) changed.push({ key, name: field.name, from, to: value });
  }
  const bytes: { offset: number; from: number; to: number }[] = [];
  for (let i = 0; i < out.length; i++) if (out[i] !== buf[i]) bytes.push({ offset: i, from: buf[i], to: out[i] });
  const map = Buffer.alloc(Math.ceil(out.length / BLOCK_SIZE));
  for (const b of bytes) map[Math.floor(b.offset / BLOCK_SIZE)] = 1;
  return { buffer: out, changed, bytes, map };
}

export { FIELDS as GATE_SETTING_FIELDS };
