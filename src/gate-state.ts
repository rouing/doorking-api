// The gate's working copy as plain values, and the board files built from them.
//
// Tables (all keyed by the gate's phone number; the values are the text the app shows):
//   gate_residents  one row per directory code (name, type, hidden, phone, entry code, security level, …)
//   gate_cards      one row per used card slot (card number, directory code)
//   gate_settings   one row per names.bin setting (the master code left out)
//   gate_working    the directory code digits, area-code layout and table, the directory's middle-entry pointer, the
//                   undecoded non-blank bytes (extra), the file sizes, and whether the base passed the round-trip check
//   gate_state      the round-trip and rebuild checks of the latest pull
// The board files to show, compare or send are built from the base copy (gate_files, what the gate holds) and these
// values: buildFiles, with the master code saved with the gate's login (managed_gates; kept out of these tables). The
// base also gives the blocks a send uploads (those that differ from it).
//
// Round-trip check: the decoded values are written back into a copy of the pulled files whose decoded bytes were
// first overwritten, and the copy must come out byte for byte the same as the pull. That shows the files can be
// built from these values. Rebuild check: the files are built from blank ones with the values alone (and the master
// code from managed_gates) and must match the pull too, so no byte is known only from a stored file.
import { bcd, namesDirDigits, namesLayout, parseNamesBin, residentRows } from './board-files.ts';
import { all, one, run, transaction, type Store, phoneDigits } from './db.ts';
import { GATE_SETTING_FIELDS, WRITTEN_FIELDS, decodeGateSettings } from './gate-settings.ts';
import {
  addEntry, addStoredEntry, applyResidentEdit, convertAreaCodeMode, convertDirDigits, encodeBcd, findPhoneRecord, removeDirectoryCode,
  type BoardBuffers, type EditOptions,
} from './residents-edit.ts';
import type { ResidentRow } from './types.ts';
import { httpError } from './errors.ts';

const CARD_SIZE = 4;
const SCRAMBLE = 0xaa;
const MAX_OFFSETS = 10;
const MIDDLE_POINTER = 0xf8;
const DIR_ENTRY_SIZE = 20;
const DIRECTORY_REGION = 0xc00; // where the area-code table and directory start (in either layout)
const PHONE_RECORD = 10;
const DIR_DIGITS = 0x40;
// names.bin ranges DoorKing32 fills with spaces on every send ([from, to)); the other undecoded bytes it fills with 0xFF.
const BLANK_SPACES: [number, number][] = [[0x100, 0x114], [0x144, 0x145], [0x179, 0x18d]];

// rawCode: the record's bytes 2-3 as hex when they aren't a directory code (e.g. a mass-enabled AB record).
export interface GateCard { slot: number; cardNumber: string; directoryCode: string | null; rawCode?: string }
export interface RoundTripProblem { file: string; bytes: number; offsets: string[]; settings?: string[]; error?: string }
export interface RoundTrip { ok: boolean; problems: RoundTripProblem[]; carried: string[] }
export interface RebuildCheck { ok: boolean; problems: RoundTripProblem[] }
export type BuildOptions = EditOptions & { masterCode?: string };
export type ResidentValues = Pick<ResidentRow, 'directoryCode' | 'name' | 'type' | 'hidden' | 'areaCode' | 'phone' | 'entryCode'
  | 'securityLevel' | 'floor' | 'elevatorRef'> & Partial<Pick<ResidentRow, 'entryOffset' | 'recordOffset'>>;
// The working copy as values.
// areaCodes: the area-code table, one entry per slot (null = free); middlePointer: names.bin 0xF8-0xFA as hex.
// extra: the names.bin bytes before the directory that nothing decodes and that aren't blank (0xFF, or a space in
// BLANK_SPACES), as { "037": "01" } (hex offset: hex bytes); sizes: the files' lengths. Both are missing in rows
// saved before 2026-11-13 until addMissingValues (gate-cache.ts) fills them.
export interface WorkingState {
  dirDigits: number;
  areaCodeMode: number;
  areaCodes: (string | null)[];
  middlePointer: string;
  residents: ResidentValues[];
  cards: GateCard[];
  settings: Record<string, string>;
  extra?: Record<string, string>;
  sizes?: { names: number; phone: number; cards: number };
}

const VALUE_FIELDS = ['name', 'type', 'hidden', 'areaCode', 'phone', 'entryCode', 'securityLevel', 'floor', 'elevatorRef'] as const;
const written = WRITTEN_FIELDS;

// Which names.bin bytes before the directory the values cover: every setting (the master code too), the directory
// code digits, the middle-entry pointer and the area-code table.
function coveredHeader(names: Buffer): Uint8Array {
  const { areaCodeOffset, areaCodeSlots, directoryOffset } = namesLayout(names);
  const covered = new Uint8Array(Math.min(directoryOffset, names.length));
  const mark = (from: number, to: number) => covered.fill(1, from, Math.min(to, covered.length));
  for (const field of GATE_SETTING_FIELDS) mark(field.offset, field.offset + field.type.size);
  mark(DIR_DIGITS, DIR_DIGITS + 1);
  mark(MIDDLE_POINTER, MIDDLE_POINTER + 3);
  mark(areaCodeOffset, areaCodeOffset + areaCodeSlots * 2);
  return covered;
}
const blankByte = (offset: number): number => (BLANK_SPACES.some(([a, b]) => offset >= a && offset < b) ? 0x20 : 0xff);

// The undecoded, non-blank names.bin bytes before the directory, as runs: { "037": "01" }.
export function extraBytes(names: Buffer): Record<string, string> {
  const covered = coveredHeader(names);
  const odd = (offset: number) => !covered[offset] && names[offset] !== blankByte(offset);
  const out: Record<string, string> = {};
  for (let offset = 0; offset < covered.length; offset++) {
    if (!odd(offset)) continue;
    let end = offset + 1;
    while (end < covered.length && odd(end)) end++;
    out[offset.toString(16).padStart(3, '0')] = names.toString('hex', offset, end);
    offset = end;
  }
  return out;
}

// Writes extra bytes back (only where nothing else is decoded).
function writeExtra(names: Buffer, extra: Record<string, string> = {}): void {
  const covered = coveredHeader(names);
  for (const [off, hex] of Object.entries(extra)) {
    const at = parseInt(off, 16);
    Buffer.from(hex, 'hex').forEach((b, i) => { if (at + i < covered.length && !covered[at + i]) names[at + i] = b; });
  }
}

// Every used card slot: card number (5 digits) and directory code ('' = none, null = not a directory code).
export function cardSlots(cards: Buffer): GateCard[] {
  const out: GateCard[] = [];
  for (let offset = 0; offset + CARD_SIZE <= cards.length; offset += CARD_SIZE) {
    const rec = cards.subarray(offset, offset + CARD_SIZE);
    if (rec.every((b) => b === 0xff)) continue;
    const code = bcd(rec.subarray(2, 4));
    out.push({ slot: offset / CARD_SIZE, cardNumber: String(rec.readUInt16BE(0)).padStart(5, '0'), directoryCode: code,
      ...(code === null && { rawCode: rec.toString('hex', 2, 4) }) });
  }
  return out;
}

// cards.bin built from its slots (all other slots free).
export function buildCards(size: number, slots: GateCard[]): Buffer {
  const out = Buffer.alloc(size, 0xff);
  for (const card of slots) {
    out.writeUInt16BE(Number(card.cardNumber), card.slot * CARD_SIZE);
    const code = card.directoryCode !== null ? encodeBcd(card.directoryCode, 2) : card.rawCode ? Buffer.from(card.rawCode, 'hex') : null;
    if (code) code.copy(out, card.slot * CARD_SIZE + 2);
  }
  return out;
}

// The values in a set of board files.
export function decodeWorking(bufs: BoardBuffers): WorkingState {
  return {
    dirDigits: namesDirDigits(bufs.names),
    areaCodeMode: namesLayout(bufs.names).areaCodeMode,
    areaCodes: parseNamesBin(bufs.names).areaCodes,
    middlePointer: bufs.names.toString('hex', MIDDLE_POINTER, MIDDLE_POINTER + 3),
    residents: residentRows(bufs).rows.map((resident) => ({
      ...Object.fromEntries(VALUE_FIELDS.map((k) => [k, resident[k]])), directoryCode: resident.directoryCode,
      entryOffset: resident.entryOffset, recordOffset: resident.recordOffset,
    }) as ResidentValues),
    cards: cardSlots(bufs.cards),
    settings: Object.fromEntries(decodeGateSettings(bufs.names).filter((setting) => !setting.secret).map((setting) => [setting.key, setting.value])),
    extra: extraBytes(bufs.names),
    sizes: { names: bufs.names.length, phone: bufs.phone.length, cards: bufs.cards.length },
  };
}

const differs = (a: ResidentValues, b: ResidentValues): boolean => VALUE_FIELDS.some((k) => String(a[k]) !== String(b[k]));
const editOf = (resident: ResidentValues) => ({
  directoryCode: resident.directoryCode, name: resident.name, vendor: resident.type === 'Vendor', hidden: resident.hidden, areaCode: resident.areaCode,
  phone: resident.phone, entryCode: resident.entryCode, securityLevel: resident.securityLevel, elevatorRef: resident.elevatorRef, floor: resident.floor,
});

// The area-code table written in names.bin's current layout.
function writeAreaCodes(names: Buffer, codes: (string | null)[]): void {
  const { areaCodeOffset, areaCodeSlots } = namesLayout(names);
  for (let i = 0; i < areaCodeSlots && areaCodeOffset + i * 2 + 2 <= names.length; i++) {
    (codes[i] ? encodeBcd(codes[i], 2) : Buffer.from([0xff, 0xff])).copy(names, areaCodeOffset + i * 2);
  }
}

// Puts the directory entries in the working copy's order (by each row's entryOffset). New codes are inserted in
// name order like any add, but where an entry ends up also depends on the names at the time it was added.
function orderDirectory(names: Buffer, residents: ResidentValues[]): void {
  const dir = parseNamesBin(names).directory;
  const byCode = new Map(dir.map((e) => [e.directoryCode, names.subarray(e.entryOffset, e.entryOffset + DIR_ENTRY_SIZE)]));
  const order = residents.filter((resident) => resident.entryOffset != null).sort((a, b) => a.entryOffset! - b.entryOffset!).map((resident) => resident.directoryCode);
  if (byCode.size !== dir.length || order.length !== dir.length || order.some((c) => !byCode.has(c))) return;
  const entries = order.map((c) => Buffer.from(byCode.get(c)!));
  const start = namesLayout(names).directoryOffset;
  entries.forEach((entry, i) => entry.copy(names, start + i * DIR_ENTRY_SIZE));
}

// Puts the phone records in the working copy's order (by each row's recordOffset), in the record slots the edits
// left in use, as orderDirectory does for the directory. They stay as they are unless every record has a distinct
// stored position.
function orderPhone(bufs: BoardBuffers, residents: ResidentValues[]): Buffer {
  const want = new Map(residents.filter((resident) => resident.recordOffset != null).map((resident) => [resident.directoryCode, resident.recordOffset!]));
  const rows = residentRows(bufs).rows.filter((resident) => resident.recordOffset !== null);
  if (rows.length !== want.size || rows.some((resident) => !want.has(resident.directoryCode)) || new Set(want.values()).size !== want.size) return bufs.phone;
  const slots = rows.map((resident) => resident.recordOffset!).sort((a, b) => a - b);
  const order = [...rows].sort((a, b) => want.get(a.directoryCode)! - want.get(b.directoryCode)!);
  if (order.every((resident, i) => resident.recordOffset === slots[i])) return bufs.phone;
  const out = Buffer.from(bufs.phone);
  order.forEach((resident, i) => bufs.phone.copy(out, slots[i], resident.recordOffset!, resident.recordOffset! + PHONE_RECORD));
  return out;
}

// The board files of a working copy: the base files with the values written over them. Steps, in this order:
// directory code digits; the area-code table (when the layout is unchanged); directory codes removed, entry codes
// that change cleared (so codes moved or swapped between residents never collide half-way), resident values that
// differ, codes added (a blank name as the gate's empty slot); the area-code layout and then its table
// (when the layout changed, with every resident's area code pointed at the new table); settings that differ (read-only ones too, from their stored values); the extra bytes;
// the directory order and middle-entry pointer; the master code, when given (from managed_gates; it isn't in the
// values tables; else the base's bytes stay); the phone records' positions; cards.bin from its slots.
export function buildFiles(base: BoardBuffers, working: WorkingState, { masterCode, ...opts }: BuildOptions = {}): BoardBuffers {
  let bufs: BoardBuffers = { names: Buffer.from(base.names), phone: Buffer.from(base.phone), cards: Buffer.from(base.cards) };
  if (working.dirDigits !== namesDirDigits(bufs.names)) bufs = convertDirDigits(bufs, working.dirDigits);
  const sameLayout = working.areaCodeMode === namesLayout(bufs.names).areaCodeMode;
  if (sameLayout) writeAreaCodes(bufs.names, working.areaCodes);
  const want = new Set(working.residents.map((resident) => resident.directoryCode));
  const have = new Map(residentRows(bufs).rows.map((resident) => [resident.directoryCode, resident as ResidentValues]));
  for (const code of have.keys()) if (!want.has(code)) bufs = removeDirectoryCode(bufs, code);
  for (const resident of working.residents) {
    const was = have.get(resident.directoryCode);
    const offset = was && (was.entryCode || '') !== (resident.entryCode || '') ? findPhoneRecord(bufs.phone, resident.directoryCode) : -1;
    if (offset >= 0) bufs.phone.fill(0xff, offset + 6, offset + 8);
  }
  for (const resident of working.residents) {
    if (have.has(resident.directoryCode) && differs(have.get(resident.directoryCode)!, resident)) bufs = applyResidentEdit(bufs, editOf(resident), opts);
  }
  for (const resident of working.residents) {
    if (!have.has(resident.directoryCode)) bufs = String(resident.name ?? '').trim() ? addEntry(bufs, editOf(resident), opts) : addStoredEntry(bufs, editOf(resident), opts);
  }
  if (!sameLayout) {
    bufs = convertAreaCodeMode(bufs, working.areaCodeMode);
    writeAreaCodes(bufs.names, working.areaCodes);
    // The residents' area codes were written against the old table; point each at its place in the new one.
    for (const r of working.residents) if (r.areaCode) bufs = applyResidentEdit(bufs, { directoryCode: r.directoryCode, areaCode: r.areaCode }, opts);
  }
  const names = Buffer.from(bufs.names);
  for (const field of written) {
    const v = working.settings[field.key];
    if (v === undefined || v === field.type.decode(names.subarray(field.offset, field.offset + field.type.size))) continue;
    try { field.type.encode!(v).copy(names, field.offset); } catch (err) { throw httpError(`${field.name}: ${(err as Error).message}`, 400); }
  }
  writeExtra(names, working.extra);
  orderDirectory(names, working.residents);
  Buffer.from(working.middlePointer, 'hex').copy(names, MIDDLE_POINTER);
  if (masterCode) writeMasterCode(names, masterCode);
  return { names, phone: orderPhone({ names, phone: bufs.phone, cards: bufs.cards }, working.residents), cards: buildCards(base.cards.length, working.cards) };
}

// The master code at 0x00-0x03, one digit per byte (0 = 0x00, as DoorKing32's send builders write it and its receive
// check expects).
function writeMasterCode(names: Buffer, code: string): void {
  if (!/^\d{4}$/.test(code)) throw httpError('The master code must be 4 digits', 400);
  Buffer.from([...code].map(Number)).copy(names, 0);
}

// The board files from the values alone, with no stored file: blank files of the recorded sizes (0xFF, spaces where
// DoorKing32 writes them, the directory code digits), then buildFiles (with the master code, when given) and every
// written setting. Throws without sizes.
export function buildFromValues(working: WorkingState, opts: BuildOptions = {}): BoardBuffers {
  if (!working.sizes) throw new Error('The file sizes are not recorded for this working copy');
  const names = Buffer.alloc(working.sizes.names, 0xff);
  for (const [a, b] of BLANK_SPACES) names.fill(0x20, a, b);
  names[DIR_DIGITS] = working.dirDigits;
  const out = buildFiles({ names, phone: Buffer.alloc(working.sizes.phone, 0xff), cards: Buffer.alloc(working.sizes.cards, 0xff) }, working, opts);
  for (const field of written) {
    if (working.settings[field.key] === undefined) continue;
    try { field.type.encode!(working.settings[field.key]).copy(out.names, field.offset); } catch (err) { throw new Error(`${field.name}: ${(err as Error).message}`); }
  }
  return out;
}

// Builds files from their decoded values alone (buildFromValues) and compares them with the files: nothing must be
// known only from the stored files. masterCode: the gate's (else bytes 0-3 differ).
export function checkRebuild(files: BoardBuffers, opts: BuildOptions = {}): RebuildCheck {
  let out: BoardBuffers;
  try { out = buildFromValues(decodeWorking(files), opts); } catch (err) {
    return { ok: false, problems: [{ file: 'all', bytes: 0, offsets: [], error: (err as Error).message }] };
  }
  const problems = labelled(files, out);
  return { ok: !problems.length, problems };
}

// fileDifferences, with the settings that cover differing names.bin bytes.
function labelled(a: BoardBuffers, b: BoardBuffers): RoundTripProblem[] {
  return fileDifferences(a, b).map((p) => {
    const covering = p.file === 'names.bin'
      ? [...new Set(differences(a.names, b.names).offsets
        .flatMap((offset) => GATE_SETTING_FIELDS.filter((field) => offset >= field.offset && offset < field.offset + field.type.size).map((field) => field.key)))]
      : [];
    return { ...p, ...(covering.length && { settings: covering.slice(0, MAX_OFFSETS) }) };
  });
}

// A change to a working copy as values, for History and Revert: per resident (directory code), card slot, setting
// and layout value, [before, after] (null = absent). Only what changed is listed.
export interface ValuesPatch {
  residents?: Record<string, [ResidentValues | null, ResidentValues | null]>;
  cards?: Record<string, [GateCard | null, GateCard | null]>;
  settings?: Record<string, [string | null, string | null]>;
  layout?: Partial<Record<typeof LAYOUT_KEYS[number], [unknown, unknown]>>;
}
const LAYOUT_KEYS = ['dirDigits', 'areaCodeMode', 'areaCodes', 'middlePointer', 'extra', 'sizes'] as const;

// JSON with sorted keys, so two values compare equal whatever order their keys were built in.
const canon = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a ?? null) === canon(b ?? null);

function diffMap<T>(before: Map<string, T>, after: Map<string, T>, eq: (a: unknown, b: unknown) => boolean = same):
  Record<string, [T | null, T | null]> | undefined {
  const out: Record<string, [T | null, T | null]> = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(k) ?? null;
    const b = after.get(k) ?? null;
    if (!eq(a, b)) out[k] = [a, b];
  }
  return Object.keys(out).length ? out : undefined;
}
const residentMap = (working: WorkingState) => new Map(working.residents.map((resident) => [resident.directoryCode, resident]));
// Cards by card number (a repeated number: "<number>#<slot>"), not by slot: tidyBoard re-packs the slots after every
// edit, so a slot holds different cards over time. Two cards are the same item whatever slot they sit in.
function cardMap(working: WorkingState): Map<string, GateCard> {
  const m = new Map<string, GateCard>();
  for (const card of working.cards) m.set(m.has(card.cardNumber) ? `${card.cardNumber}#${card.slot}` : card.cardNumber, card);
  return m;
}
const sameCard = (a: unknown, b: unknown) => same(a && { ...(a as GateCard), slot: undefined }, b && { ...(b as GateCard), slot: undefined });
// Cards with slots that don't collide: each keeps its slot when free (earlier cards first), else takes the first free
// one. Beyond the end of cards.bin when it is full (building the files then fails).
function placeCards(cards: GateCard[], sizeBytes: number): GateCard[] {
  const total = Math.floor(sizeBytes / CARD_SIZE);
  const used = new Set<number>();
  const out: GateCard[] = [];
  const moved: GateCard[] = [];
  for (const card of cards) {
    const fits = card.slot >= 0 && card.slot < total && !used.has(card.slot);
    if (fits) used.add(card.slot);
    (fits ? out : moved).push(card);
  }
  let free = 0;
  for (const card of moved) {
    while (used.has(free)) free++;
    used.add(free);
    out.push({ ...card, slot: free });
  }
  return out.sort((a, b) => a.slot - b.slot);
}
const settingMap = (working: WorkingState) => new Map(Object.entries(working.settings));

// What changed from one working copy to another, or null when nothing did.
export function diffStates(before: WorkingState, after: WorkingState): ValuesPatch | null {
  const layout: ValuesPatch['layout'] = {};
  for (const k of LAYOUT_KEYS) if (!same(before[k], after[k])) layout[k] = [before[k], after[k]];
  const patch: ValuesPatch = {
    residents: diffMap(residentMap(before), residentMap(after)),
    cards: diffMap(cardMap(before), cardMap(after), sameCard),
    settings: diffMap(settingMap(before), settingMap(after)),
    ...(Object.keys(layout).length && { layout }),
  };
  for (const k of Object.keys(patch) as (keyof ValuesPatch)[]) if (patch[k] === undefined) delete patch[k];
  return Object.keys(patch).length ? patch : null;
}

// Undoes a patch on the current working copy. Every changed value must still hold its "after" value; otherwise a
// later change touched it and null is returned. Card changes are matched by card number (patches before 2026-11-21
// are keyed by slot and list cards that only moved slot; those are skipped).
export function undoValues(current: WorkingState, patch: ValuesPatch): WorkingState | null {
  const undo = <T>(now: Map<string, T>, changes: Record<string, [T | null, T | null]> = {}, eq = same): Map<string, T> | null => {
    const out = new Map(now);
    for (const [k, [before, after]] of Object.entries(changes)) {
      if (!eq(now.get(k) ?? null, after)) return null;
      if (before === null) {
        out.delete(k);
        continue;
      }
      out.set(k, before);
    }
    return out;
  };
  const res = undo(residentMap(current), patch.residents);
  const cardChanges = Object.fromEntries(Object.values(patch.cards || {}).filter(([a, b]) => !sameCard(a, b))
    .map(([a, b]) => [(b ?? a)!.cardNumber, [a, b] as [GateCard | null, GateCard | null]]));
  const cards = undo(cardMap(current), cardChanges, sameCard);
  const settings = undo(settingMap(current), patch.settings);
  if (!res || !cards || !settings) return null;
  const out: WorkingState = {
    ...current,
    residents: [...res.values()].sort((a, b) => a.directoryCode.localeCompare(b.directoryCode)),
    cards: placeCards([...cards.values()], current.sizes?.cards ?? Infinity),
    settings: Object.fromEntries(settings),
  };
  for (const [k, [before, after]] of Object.entries(patch.layout || {}) as [typeof LAYOUT_KEYS[number], [unknown, unknown]][]) {
    if (!same(current[k], after)) return null;
    (out as unknown as Record<string, unknown>)[k] = before;
  }
  return out;
}

// Rebasing unsent changes onto a newer pull. A conflict: an item both the gate and the working copy changed
// differently since the old base (resident by directory code, card by card number, setting by key). The working copy keeps
// its value until someone chooses Keep mine or Take the gate's.
export type ConflictKind = 'resident' | 'card' | 'setting';
export interface Conflict { kind: ConflictKind; key: string; label: string }
// One unsent change to put back: the item's value (null = removed).
export interface ItemChange { kind: ConflictKind; key: string; label: string; value: ResidentValues | GateCard | string | null }
export interface RebasePlan { gate: WorkingState; changes: ItemChange[]; conflicts: Conflict[]; fromGate: number; layoutChanged: boolean }

const residentKey = (r: ResidentValues | null) => r && Object.fromEntries([...VALUE_FIELDS, 'directoryCode'].map((k) => [k, (r as never)[k]]));
// Whether two values of an item are the same (residents compare values, not where they sit in the files).
export function sameItem(kind: ConflictKind, a: unknown, b: unknown): boolean {
  if (kind === 'card') return sameCard(a, b);
  return kind === 'resident' ? same(residentKey(a as ResidentValues | null), residentKey(b as ResidentValues | null)) : same(a, b);
}
const EDITABLE = new Set(GATE_SETTING_FIELDS.filter((field) => field.editable && !field.secret).map((field) => field.key));

// The items of a working copy by kind and key (only editable settings: read-only ones always come from the gate).
export function itemsOf(working: WorkingState): Record<ConflictKind, Map<string, ResidentValues | GateCard | string>> {
  return {
    resident: residentMap(working),
    card: cardMap(working),
    setting: new Map(Object.entries(working.settings).filter(([k]) => EDITABLE.has(k))),
  };
}
function itemLabel(kind: ConflictKind, key: string, ...values: unknown[]): string {
  if (kind === 'card') return `Card ${key.split('#')[0]}`;
  if (kind === 'setting') return GATE_SETTING_FIELDS.find((field) => field.key === key)?.name || key;
  const name = values.map((v) => (v as ResidentValues | null)?.name).find((n) => n && n.trim());
  return `Directory code ${key}${name ? ` (${name})` : ''}`;
}

// Works out how to put the unsent changes (oldBase -> mine) on top of a newer pull (gate). Per item: unchanged in the
// working copy -> the gate's; changed only in the working copy, or both to the same -> the working copy's; changed
// differently on both -> a conflict, keeping the working copy's. Earlier conflicts stay while their item still
// differs from the gate. layoutChanged: the directory code digits or area-code mode changed on either side, so the
// changes can't be put back item by item (the caller takes the gate's version).
export function rebasePlan(oldBase: WorkingState, mine: WorkingState, gate: WorkingState, earlier: Conflict[] = []): RebasePlan {
  const layoutChanged = oldBase.dirDigits !== gate.dirDigits || oldBase.areaCodeMode !== gate.areaCodeMode
    || oldBase.dirDigits !== mine.dirDigits || oldBase.areaCodeMode !== mine.areaCodeMode;
  const plan: RebasePlan = { gate, changes: [], conflicts: [], fromGate: 0, layoutChanged };
  if (layoutChanged) return plan;
  const [b, m, g] = [itemsOf(oldBase), itemsOf(mine), itemsOf(gate)];
  for (const kind of ['resident', 'card', 'setting'] as const) {
    for (const key of new Set([...b[kind].keys(), ...m[kind].keys(), ...g[kind].keys()])) {
      const [vb, vm, vg] = [b[kind].get(key) ?? null, m[kind].get(key) ?? null, g[kind].get(key) ?? null];
      if (sameItem(kind, vm, vb)) {
        if (!sameItem(kind, vg, vb)) plan.fromGate++;
        continue;
      }
      if (sameItem(kind, vm, vg)) continue;
      const label = itemLabel(kind, key, vm, vg, vb);
      plan.changes.push({ kind, key, label, value: vm });
      const conflicted = !sameItem(kind, vg, vb) || earlier.some((conflict) => conflict.kind === kind && conflict.key === key);
      if (conflicted) plan.conflicts.push({ kind, key, label });
    }
  }
  return plan;
}

// A working copy with one item set (null removes it). A resident keeps the gate's place in the files when it has one;
// a card keeps its slot when free, else takes the first free one.
export function withItem(working: WorkingState, kind: ConflictKind, key: string, value: ResidentValues | GateCard | string | null): WorkingState {
  if (kind === 'setting') return { ...working, settings: { ...working.settings, [key]: value as string } };
  if (kind === 'card') {
    const cards = cardMap(working);
    cards.delete(key);
    return { ...working, cards: placeCards(value ? [...cards.values(), value as GateCard] : [...cards.values()], working.sizes?.cards ?? Infinity) };
  }
  const at = working.residents.find((resident) => resident.directoryCode === key);
  const rest = working.residents.filter((resident) => resident.directoryCode !== key);
  if (!value) return { ...working, residents: rest };
  const r = { ...(value as ResidentValues), entryOffset: at?.entryOffset, recordOffset: at?.recordOffset };
  return { ...working, residents: [...rest, r].sort((a, resident) => a.directoryCode.localeCompare(resident.directoryCode)) };
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', type: 'Type', hidden: 'Hidden', areaCode: 'Area code', phone: 'Phone', entryCode: 'Entry code',
  securityLevel: 'Security level', floor: 'Floor', elevatorRef: 'Elevator', cardNumber: 'Card', directoryCode: 'Directory code',
};
// How the gate's and the working copy's values of a conflicted item differ, in words: { gate, mine }.
export function describeConflict(kind: ConflictKind, gate: unknown, mine: unknown): { gate: string; mine: string } {
  if (gate == null || mine == null) {
    const what = (v: unknown) => (kind === 'setting' ? `"${v}"` : kind === 'card' ? `card ${(v as GateCard).cardNumber}`
      : (v as ResidentValues).name || '(empty slot)');
    return { gate: gate == null ? 'removed' : what(gate), mine: mine == null ? 'removed' : what(mine) };
  }
  if (kind === 'setting') return { gate: `"${gate}"`, mine: `"${mine}"` };
  const fields = Object.keys(FIELD_LABELS).filter((k) => k in (gate as object) && !same((gate as never)[k], (mine as never)[k]));
  const text = (v: unknown) => fields.map((k) => `${FIELD_LABELS[k]} ${JSON.stringify((v as never)[k] ?? '')}`).join(', ');
  return { gate: text(gate), mine: text(mine) };
}

// Offsets (hex) where two buffers differ, and how many.
function differences(a: Buffer, b: Buffer): { bytes: number; offsets: number[] } {
  if (a.length !== b.length) return { bytes: Math.max(a.length, b.length), offsets: [] };
  const offsets: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) offsets.push(i);
  return { bytes: offsets.length, offsets };
}
const hex = (n: number) => `0x${n.toString(16)}`;

// Where two sets of files differ: [{ file, bytes, offsets }] (empty when they're the same).
export function fileDifferences(a: BoardBuffers, b: BoardBuffers): RoundTripProblem[] {
  return (['names', 'phone', 'cards'] as const).map((n) => ({ n, d: differences(a[n], b[n]) })).filter((x) => x.d.bytes)
    .map(({ n, d }) => ({ file: `${n}.bin`, bytes: d.bytes, offsets: d.offsets.slice(0, MAX_OFFSETS).map(hex) }));
}

// Writes every decoded value back over scrambled decoded bytes and compares the result with the pull.
// carried: settings the app only reads (kept as pulled).
export function checkRoundTrip(pulled: BoardBuffers, opts: EditOptions = {}): RoundTrip {
  const problems: RoundTripProblem[] = [];
  let names = Buffer.from(pulled.names);
  const phone = Buffer.from(pulled.phone);

  // Settings the files are built from (read-only ones too), then the extra bytes.
  const values = new Map(decodeGateSettings(pulled.names).map((setting) => [setting.key, setting.value]));
  for (const field of written) names.fill(SCRAMBLE, field.offset, field.offset + field.type.size);
  for (const field of written) {
    try { field.type.encode!(values.get(field.key)!).copy(names, field.offset); } catch (err) {
      problems.push({ file: 'names.bin', bytes: field.type.size, offsets: [hex(field.offset)], settings: [field.key], error: (err as Error).message });
    }
  }
  const extra = extraBytes(pulled.names);
  for (const [off, h] of Object.entries(extra)) names.fill(SCRAMBLE, parseInt(off, 16), parseInt(off, 16) + h.length / 2);
  writeExtra(names, extra);

  // Residents: name and flag bits (vendor, shown) in names.bin, bytes 2-9 of each phone record.
  const { rows } = residentRows(pulled);
  const placed = rows.filter((resident) => resident.entryOffset !== null && resident.recordOffset !== null);
  for (const resident of placed) {
    names.fill(SCRAMBLE, resident.entryOffset!, resident.entryOffset! + 15);
    names[resident.entryOffset! + 15] ^= 0x21;
    phone.fill(SCRAMBLE, resident.recordOffset! + 2, resident.recordOffset! + 10);
  }
  let bufs: BoardBuffers = { names, phone, cards: pulled.cards };
  for (const resident of placed) {
    try { bufs = applyResidentEdit(bufs, editOf(resident), opts); } catch (err) {
      problems.push({ file: 'phone.bin', bytes: 0, offsets: [hex(resident.recordOffset!)], error: `Directory code ${resident.directoryCode}: ${(err as Error).message}` });
    }
  }

  // The middle-entry pointer (0xF8-0xFA) follows the directory; edits only recompute it when the directory changes
  // (withPointer in residents-edit.ts), so with the area-code table and directory rebuilt exactly the pulled
  // pointer is kept.
  if (pulled.names.subarray(DIRECTORY_REGION).equals(bufs.names.subarray(DIRECTORY_REGION))) {
    pulled.names.copy(bufs.names, MIDDLE_POINTER, MIDDLE_POINTER, MIDDLE_POINTER + 3);
  }

  // Cards: built from their slots.
  const out: BoardBuffers = { names: bufs.names, phone: bufs.phone, cards: buildCards(pulled.cards.length, cardSlots(pulled.cards)) };
  problems.push(...labelled(pulled, out));
  const carried = GATE_SETTING_FIELDS.filter((field) => !written.includes(field)).map((field) => field.key);
  return { ok: !problems.length, problems, carried };
}

// Records the round-trip check and the rebuild-from-values check (checkRebuild; opts.masterCode: the gate's) of a
// pull in gate_state. Returns both.
export async function checkPull(store: Store, phone: unknown, pulled: BoardBuffers, pulledAt: Date, opts: BuildOptions = {}):
  Promise<RoundTrip & { rebuild: RebuildCheck }> {
  const { masterCode, ...editOpts } = opts;
  const check = checkRoundTrip(pulled, editOpts);
  const rebuild = checkRebuild(pulled, { ...editOpts, masterCode });
  await run(store, `INSERT INTO gate_state (phone, pulled_at, checked_at, round_trip_ok, problems, rebuild_ok, rebuild_problems)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (phone) DO UPDATE SET pulled_at = excluded.pulled_at, checked_at = excluded.checked_at,
    round_trip_ok = excluded.round_trip_ok, problems = excluded.problems, rebuild_ok = excluded.rebuild_ok,
    rebuild_problems = excluded.rebuild_problems`,
  [phoneDigits(phone), pulledAt.toISOString(), new Date().toISOString(), check.ok, JSON.stringify(check.problems), rebuild.ok,
    JSON.stringify(rebuild.problems)]);
  return { ...check, rebuild };
}

const FIELD_BY_KEY = new Map(GATE_SETTING_FIELDS.map((field) => [field.key, field]));
const settingRows = (settings: Record<string, string>): string => JSON.stringify(Object.entries(settings)
  .map(([key, value]) => ({ key, grp: FIELD_BY_KEY.get(key)!.group, name: FIELD_BY_KEY.get(key)!.name, value })));

// Adds setting rows the working copy doesn't have yet; existing rows stay. Returns how many were added.
export async function addSettingRows(store: Store, phone: unknown, settings: Record<string, string>): Promise<number> {
  return run(store, `INSERT INTO gate_settings (phone, key, grp, name, value)
    SELECT $1, key, grp, name, value FROM jsonb_to_recordset($2) AS t(key text, grp text, name text, value text)
    ON CONFLICT (phone, key) DO NOTHING`, [phoneDigits(phone), settingRows(settings)]);
}

// Saves the working copy's values (replacing the gate's earlier rows). baseOk: the base passed the round-trip check.
export async function saveWorkingState(store: Store, phone: unknown, working: WorkingState, { baseOk, savedAt = new Date() }:
  { baseOk: boolean; savedAt?: Date }): Promise<void> {
  const phoneKey = phoneDigits(phone);
  await transaction(store, async (tx) => {
    for (const t of ['gate_residents', 'gate_cards', 'gate_settings']) await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [phoneKey]);
    await run(tx, `INSERT INTO gate_residents (phone, seq, directory_code, type, name, hidden, area_code, phone_number, entry_code,
      security_level, floor, elevator_ref, entry_offset, record_offset)
      SELECT $1, seq, directory_code, type, name, hidden, area_code, phone_number, entry_code, security_level, floor, elevator_ref,
        entry_offset, record_offset
      FROM jsonb_to_recordset($2) AS t(seq int, directory_code text, type text, name text, hidden boolean, area_code text,
        phone_number text, entry_code text, security_level int, floor int, elevator_ref int, entry_offset int, record_offset int)`,
    [phoneKey, JSON.stringify(working.residents.map((resident, i) => ({
      seq: i + 1, directory_code: resident.directoryCode, type: resident.type, name: resident.name, hidden: resident.hidden, area_code: resident.areaCode,
      phone_number: resident.phone, entry_code: resident.entryCode, security_level: resident.securityLevel === '' ? null : resident.securityLevel,
      floor: resident.floor === '' ? null : resident.floor, elevator_ref: resident.elevatorRef === '' ? null : resident.elevatorRef,
      entry_offset: resident.entryOffset ?? null, record_offset: resident.recordOffset ?? null,
    })))]);
    await run(tx, `INSERT INTO gate_cards (phone, slot, card_number, directory_code, raw_code)
      SELECT $1, slot, card_number, directory_code, raw_code
      FROM jsonb_to_recordset($2) AS t(slot int, card_number text, directory_code text, raw_code text)`,
    [phoneKey, JSON.stringify(working.cards.map((card) => ({ slot: card.slot, card_number: card.cardNumber, directory_code: card.directoryCode, raw_code: card.rawCode ?? null })))]);
    await run(tx, `INSERT INTO gate_settings (phone, key, grp, name, value)
      SELECT $1, key, grp, name, value FROM jsonb_to_recordset($2) AS t(key text, grp text, name text, value text)`,
    [phoneKey, settingRows(working.settings)]);
    await run(tx, `INSERT INTO gate_working (phone, dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at, extra, sizes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (phone) DO UPDATE SET dir_digits = excluded.dir_digits, area_code_mode = excluded.area_code_mode,
      area_codes = excluded.area_codes, middle_pointer = excluded.middle_pointer, base_ok = excluded.base_ok, saved_at = excluded.saved_at,
      extra = excluded.extra, sizes = excluded.sizes`,
    [phoneKey, working.dirDigits, working.areaCodeMode, JSON.stringify(working.areaCodes), working.middlePointer, baseOk, savedAt.toISOString(),
      working.extra ? JSON.stringify(working.extra) : null, working.sizes ? JSON.stringify(working.sizes) : null]);
  });
}

interface ResidentDbRow {
  directory_code: string; type: 'Resident' | 'Vendor'; name: string; hidden: boolean; area_code: string; phone_number: string;
  entry_code: string; security_level: number | null; floor: number | null; elevator_ref: number | null;
  entry_offset: number | null; record_offset: number | null;
}

// The working copy's values, { baseOk, savedAt, conflicts }, or null when there is none.
export async function loadWorkingState(store: Store, phone: unknown):
  Promise<{ state: WorkingState; baseOk: boolean; savedAt: Date; conflicts: Conflict[] } | null> {
  const phoneKey = phoneDigits(phone);
  const head = await one<{ dir_digits: number; area_code_mode: number; area_codes: (string | null)[]; middle_pointer: string;
    base_ok: boolean; saved_at: string; extra: Record<string, string> | null; sizes: WorkingState['sizes'] | null; conflicts: Conflict[] }>(store,
    'SELECT dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at, extra, sizes, conflicts FROM gate_working WHERE phone = $1', [phoneKey]);
  if (!head) return null;
  const [res, cards, settings] = await Promise.all([
    all<ResidentDbRow>(store, 'SELECT * FROM gate_residents WHERE phone = $1 ORDER BY seq', [phoneKey]),
    all<{ slot: number; card_number: string; directory_code: string | null; raw_code: string | null }>(store,
      'SELECT slot, card_number, directory_code, raw_code FROM gate_cards WHERE phone = $1 ORDER BY slot', [phoneKey]),
    all<{ key: string; value: string }>(store, 'SELECT key, value FROM gate_settings WHERE phone = $1', [phoneKey]),
  ]);
  return {
    baseOk: head.base_ok,
    savedAt: new Date(head.saved_at),
    conflicts: head.conflicts,
    state: {
      dirDigits: head.dir_digits,
      areaCodeMode: head.area_code_mode,
      areaCodes: head.area_codes,
      middlePointer: head.middle_pointer,
      residents: res.map((r) => ({
        directoryCode: r.directory_code, type: r.type, name: r.name, hidden: r.hidden, areaCode: r.area_code, phone: r.phone_number,
        entryCode: r.entry_code, securityLevel: r.security_level ?? '', floor: r.floor ?? '', elevatorRef: r.elevator_ref ?? '',
        entryOffset: r.entry_offset, recordOffset: r.record_offset,
      })),
      cards: cards.map((card) => ({ slot: card.slot, cardNumber: card.card_number, directoryCode: card.directory_code,
        ...(card.raw_code && { rawCode: card.raw_code }) })),
      settings: Object.fromEntries(settings.map((setting) => [setting.key, setting.value])),
      ...(head.extra && { extra: head.extra }),
      ...(head.sizes && { sizes: head.sizes }),
    },
  };
}

// Replaces the working copy's list of conflicts (saving values leaves it as it is).
export async function setConflicts(store: Store, phone: unknown, conflicts: Conflict[]): Promise<void> {
  await run(store, 'UPDATE gate_working SET conflicts = $2 WHERE phone = $1', [phoneDigits(phone), JSON.stringify(conflicts)]);
}

// Removes the working copy's values.
export async function deleteWorkingState(store: Store, phone: unknown): Promise<void> {
  const phoneKey = phoneDigits(phone);
  await transaction(store, async (tx) => {
    for (const t of ['gate_residents', 'gate_cards', 'gate_settings', 'gate_working']) await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [phoneKey]);
  });
}

// rebuildOk / rebuildProblems: null for pulls checked before 2026-11-13.
export interface GateState {
  pulledAt: string; checkedAt: string; roundTripOk: boolean; problems: RoundTripProblem[];
  rebuildOk: boolean | null; rebuildProblems: RoundTripProblem[] | null;
}

// The round-trip and rebuild checks of the gate's latest pull, or null.
export async function getGateState(store: Store, phone: unknown): Promise<GateState | null> {
  const r = await one<{ pulled_at: string; checked_at: string; round_trip_ok: boolean; problems: RoundTripProblem[];
    rebuild_ok: boolean | null; rebuild_problems: RoundTripProblem[] | null }>(store,
    'SELECT pulled_at, checked_at, round_trip_ok, problems, rebuild_ok, rebuild_problems FROM gate_state WHERE phone = $1', [phoneDigits(phone)]);
  return r ? { pulledAt: r.pulled_at, checkedAt: r.checked_at, roundTripOk: r.round_trip_ok, problems: r.problems,
    rebuildOk: r.rebuild_ok, rebuildProblems: r.rebuild_problems } : null;
}

// Counts of the gate's working-copy rows (residents, cards, settings).
export async function gateStateCounts(store: Store, phone: unknown): Promise<Record<string, number>> {
  const phoneKey = phoneDigits(phone);
  const out: Record<string, number> = {};
  for (const t of ['gate_residents', 'gate_cards', 'gate_settings']) {
    out[t] = (await all<{ n: number }>(store, `SELECT COUNT(*) AS n FROM ${t} WHERE phone = $1`, [phoneKey]))[0].n;
  }
  return out;
}
