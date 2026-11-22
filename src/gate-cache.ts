import fs from 'node:fs';
import path from 'node:path';
import { all, decryptBytes, encryptBytes, getMeta, one, run, setMeta, transaction, type Store, phoneDigits } from './db.ts';
import { getGate } from './gate-list.ts';
import { GATE_SETTING_FIELDS, decodeGateSettings } from './gate-settings.ts';
import {
  addSettingRows, buildFiles, checkRoundTrip, decodeWorking, deleteWorkingState, describeConflict, diffStates, fileDifferences, itemsOf,
  loadWorkingState, rebasePlan, sameItem, saveWorkingState, setConflicts, withItem,
  type Conflict, type ConflictKind, type ItemChange, type RebasePlan, type WorkingState,
} from './gate-state.ts';
import { withPointer, type BoardBuffers } from './residents-edit.ts';
import { BLOCK_SIZE } from './board-files.ts';
import { httpError } from './errors.ts';

/**
 * The gate's working copy. Nothing here talks to the gate.
 * gate_files (encrypted: names.bin holds the master code) keeps per gate and file the base: the latest residents
 * pull, i.e. what the gate holds (rcv_out.bin isn't kept: its events go into tx_history, see tx-history.ts). Until
 * 2026-11-13 a newer pull waited in a separate `pulled` copy until Reset to gate; migratePulledCopies converts those.
 * The working copy itself is values in tables (gate_residents, gate_cards, gate_settings, gate_working; see
 * gate-state.ts). Its board files are built from base + values whenever they are read; a write is decoded into
 * values and stored only when the files rebuild from them byte for byte. A file's change map (one byte per 128-byte
 * block, 1 = block differs from base: the blocks a send uploads) is worked out from base and working copy.
 * Each residents pull becomes the base at once (applyPull); unsent changes are put back on top of it, and items both
 * sides changed differently become conflicts that must be decided before a send.
 */
export const CACHE_FILES = ['names.bin', 'phone.bin', 'cards.bin'];
const NAMES_MODE_DELTA = 0x380; // names.bin size difference between the 255 and 10 area-code layouts

/**
 * pulled: the gate's file is stored. A conflict as shown: { kind, key, label, gate, mine } (the two values in words).
 */
export type CacheFileStatus =
  | { name: string; cached: false; pulled: boolean }
  | { name: string; cached: true; changedBlocks: number[]; baseTime: Date; savedTime: Date };
export interface ConflictView extends Conflict { gate: string; mine: string }
export interface CacheStatus { exists: boolean; edited: boolean; conflicts: ConflictView[]; files: CacheFileStatus[] }
export interface StoredFile { data: Buffer; savedAt: Date }
type Copy = 'pulled' | 'base' | 'working';
type Copies = Record<Copy, Map<string, StoredFile>>;


/**
 * Sizes allowed for a working-copy file: the pulled size, or for names.bin the other area-code layout's size.
 *
 * @param name - Display name or filename.
 * @param base - Base (last-pulled) board buffers.
 * @param data - Binary or structured payload.
 * @returns True when the condition holds.
 */
const sizeOk = (name: string, base: Buffer, data: Buffer): boolean => data.length === base.length
  || (name === 'names.bin' && Math.abs(data.length - base.length) === NAMES_MODE_DELTA);
const mapName = (name: string) => name.replace(/\.bin$/, '.map');

/**
 * Block map.
 *
 * @param base - Base (last-pulled) board buffers.
 * @param work - `Buffer` value.
 * @returns `Buffer` result.
 */
export function blockMap(base: Buffer, work: Buffer): Buffer {
  const map = Buffer.alloc(Math.ceil(work.length / BLOCK_SIZE));
  for (let i = 0; i < work.length; i++) if (work[i] !== base[i]) map[Math.floor(i / BLOCK_SIZE)] = 1;
  return map;
}
const changed = (map: Buffer): number[] => [...map.keys()].filter((i) => map[i]);

/**
 * The stored files (copies as kept in gate_files).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param names - Raw `names.bin` buffer.
 * @returns Promise resolving to `Copies`.
 */
async function loadFiles(store: Store, phone: string, names: string[]): Promise<Copies> {
  const rows = await all<{ copy: Copy; name: string; data: Buffer; saved_at: string }>(store,
    'SELECT copy, name, data, saved_at FROM gate_files WHERE phone = $1 AND name = ANY($2)', [phoneDigits(phone), names]);
  const out: Copies = { pulled: new Map(), base: new Map(), working: new Map() };
  for (const row of rows) out[row.copy].set(row.name, { data: decryptBytes(store, row.data), savedAt: new Date(row.saved_at) });
  return out;
}

const boardOf = (files: Map<string, StoredFile>): BoardBuffers => ({
  names: files.get('names.bin')!.data, phone: files.get('phone.bin')!.data, cards: files.get('cards.bin')!.data,
});
const hasAll = (files: Map<string, StoredFile>) => CACHE_FILES.every((file) => files.has(file));

/**
 * The base from gate_files; working built from base and the working copy's values, with the master code saved with
 * the gate's login (managed_gates; for a gate not managed here the base's bytes stay). conflicts: as stored.
 * hasWorking: a working copy exists; build false skips building its files (c.working stays empty).
 */
type Loaded = Copies & { baseOk: boolean; masterCode?: string; conflicts: Conflict[]; hasWorking: boolean };
async function loadCopies(store: Store, phone: string, names: string[] = CACHE_FILES, { build = true } = {}): Promise<Loaded> {
  const files = await loadFiles(store, phone, [...new Set([...names, ...CACHE_FILES])]);
  files.working = new Map();
  /**
   * One query after another: store may be a transaction's single connection (no queries at the same time on it).
   */
  const working = await loadWorkingState(store, phone);
  const gate = await getGate(store, phone);
  const masterCode = gate ? gate.masterCode : undefined;
  const hasWorking = Boolean(working && hasAll(files.base));
  if (working && hasWorking && build) {
    const built = buildFiles(boardOf(files.base), working.state, { masterCode });
    for (const file of CACHE_FILES) files.working.set(file, { data: built[file.replace('.bin', '') as keyof BoardBuffers], savedAt: working.savedAt });
  }
  return { ...files, baseOk: Boolean(working && working.baseOk), masterCode, conflicts: working ? working.conflicts : [], hasWorking };
}

async function putFile(store: Store, phone: string, copy: Copy, name: string, data: Buffer, savedAt: Date = new Date()): Promise<void> {
  await run(store, `INSERT INTO gate_files (phone, copy, name, data, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, copy, name) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`,
  [phoneDigits(phone), copy, name, encryptBytes(store, data), savedAt.toISOString()]);
}

function statusOf(copies: Loaded): CacheStatus {
  const files = CACHE_FILES.map((name): CacheFileStatus => {
    const work = copies.working.get(name);
    const base = copies.base.get(name);
    if (!work || !base) return { name, cached: false, pulled: Boolean(base) };
    return { name, cached: true, changedBlocks: changed(blockMap(base.data, work.data)), baseTime: base.savedAt, savedTime: work.savedAt };
  });
  const cached = files.filter((file): file is Extract<CacheFileStatus, { cached: true }> => file.cached);
  return { exists: cached.length > 0, edited: cached.some((file) => file.changedBlocks.length), conflicts: liveConflicts(copies), files };
}

/**
 * The stored conflicts whose item still differs between the working copy and the gate, with both values in words.
 *
 * @param copies - `Loaded` value.
 * @returns `ConflictView[]` result.
 */
function liveConflicts(copies: Loaded): ConflictView[] {
  if (!copies.conflicts.length || !hasAll(copies.working) || !hasAll(copies.base)) return [];
  const [mine, gate] = [itemsOf(decodeWorking(boardOf(copies.working))), itemsOf(decodeWorking(boardOf(copies.base)))];
  return copies.conflicts.flatMap((conflict) => {
    const [yours, theirs] = [mine[conflict.kind].get(conflict.key) ?? null, gate[conflict.kind].get(conflict.key) ?? null];
    return sameItem(conflict.kind, yours, theirs) ? [] : [{ ...conflict, ...describeConflict(conflict.kind, theirs, yours) }];
  });
}
/**
 * Per file: whether it is cached and the changed blocks; whether anything is unsent; the conflicts to decide.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `CacheStatus`.
 */
export async function cacheStatus(store: Store, phone: string): Promise<CacheStatus> {
  return statusOf(await loadCopies(store, phone));
}

/**
 * The gate's files as stored (the latest residents pull), or null when one is missing.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `BoardBuffers | null`.
 */
export async function readBaseFiles(store: Store, phone: string): Promise<BoardBuffers | null> {
  const files = await loadFiles(store, phone, CACHE_FILES);
  return hasAll(files.base) ? boardOf(files.base) : null;
}

/**
 * Makes files the base and the working copy their values (no unsent changes, no conflicts). A missing file drops the
 * working copy. When the files fail the round-trip check, editing stays locked (baseOk false).
 *
 * @param tx - Active database transaction store.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Map of board filenames to binary buffers.
 */
async function setBase(tx: Store, phone: string, files: Map<string, StoredFile>): Promise<void> {
  for (const name of CACHE_FILES) {
    const file = files.get(name);
    if (!file) {
      await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'base' AND name = $2", [phoneDigits(phone), name]);
      continue;
    }
    await putFile(tx, phone, 'base', name, file.data, file.savedAt);
  }
  await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy IN ('pulled', 'working')", [phoneDigits(phone)]);
  if (!hasAll(files)) { await deleteWorkingState(tx, phone); return; }
  const board = boardOf(files);
  await saveWorkingState(tx, phone, decodeWorking(board), { baseOk: checkRoundTrip(board).ok });
  await setConflicts(tx, phone, []);
}
const fileMap = (files: Record<string, Buffer>, at: Date) => new Map(Object.entries(files)
  .filter(([name]) => CACHE_FILES.includes(name.toLowerCase())).map(([name, data]) => [name.toLowerCase(), { data, savedAt: at }]));

/**
 * Makes pulled files the base and the working copy (unsent changes are dropped), as after a send the gate confirmed.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Map of board filenames to binary buffers.
 * @param [at] - Timestamp (`Date` or milliseconds).
 * @returns Promise resolving to `CacheStatus`.
 */
export async function replaceBase(store: Store, phone: string, files: Record<string, Buffer>, at: Date = new Date()): Promise<CacheStatus> {
  await transaction(store, (tx) => setBase(tx, phone, fileMap(files, at)));
  return cacheStatus(store, phone);
}

/**
 * Reset to gate: drops the unsent changes and conflicts; the working copy becomes the gate's files again.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `CacheStatus`.
 */
export async function resetCache(store: Store, phone: string): Promise<CacheStatus> {
  await transaction(store, async (tx) => {
    const files = await loadFiles(tx, phone, CACHE_FILES);
    if (!files.base.size) throw httpError('No resident files yet. Pull residents from the gate.', 404);
    await setBase(tx, phone, files.base);
  });
  return cacheStatus(store, phone);
}

/**
 * What a residents pull did to the working copy. outcome: new (no working copy before), unchanged (the gate holds
 * the same files), refreshed (no unsent changes: the working copy is the pull), rebased (unsent changes put back on
 * top of the pull), dropped (unsent changes dropped: reason). kept: changes put back; fromGate: items the gate changed
 * that the working copy now shows; conflicts: items both changed differently (the working copy's value kept);
 * notKept: changes that couldn't be put back (the gate's value kept), with why.
 */
export interface PullResult {
  outcome: 'new' | 'unchanged' | 'refreshed' | 'rebased' | 'dropped';
  kept: number; fromGate: number; conflicts: Conflict[];
  notKept: { kind: ConflictKind; key: string; label: string; error: string }[];
  dropped?: { count: number; reason: string };
}

/**
 * Builds the working copy for a rebase: every change at once, else one at a time, leaving out those the files can't
 * take (for example an entry code the gate now gives to someone else). The middle-entry pointer is worked out again
 * when the directory differs from the pull's.
 *
 * @param base - Base (last-pulled) board buffers.
 * @param plan - `RebasePlan` value.
 * @param [masterCode] - 4-digit gate master code.
 * @returns `{ state: WorkingState; notKept: PullResult['notKept'] }` result.
 * @throws Error when validation or the underlying operation fails.
 */
function buildRebase(base: BoardBuffers, plan: RebasePlan, masterCode?: string): { state: WorkingState; notKept: PullResult['notKept'] } {
  /**
   * The working copy those values build into; throws when they can't be built, or don't rebuild the same.
   *
   * @param working - Decoded working-copy state.
   * @returns `WorkingState` result.
   * @throws Error when validation or the underlying operation fails.
   */
  const build = (working: WorkingState): WorkingState => {
    const built = withPointer(base.names, buildFiles(base, working, { masterCode }));
    const state = decodeWorking(built);
    const diff = fileDifferences(built, buildFiles(base, state, { masterCode }));
    if (diff.length) throw new Error(`rebuilding gives different bytes (${diff.map((problem) => problem.file).join(', ')})`);
    return state;
  };
  const put = (working: WorkingState, change: ItemChange) => withItem(working, change.kind, change.key, change.value);
  try { return { state: build(plan.changes.reduce(put, plan.gate)), notKept: [] }; } catch { /* keep the changes one by one below */ }
  const notKept: PullResult['notKept'] = [];
  let working = plan.gate;
  for (const change of plan.changes) {
    const next = put(working, change);
    try {
      build(next);
      working = next;
    } catch (err) { notKept.push({ kind: change.kind, key: change.key, label: change.label, error: (err as Error).message }); }
  }
  try { return { state: build(working), notKept }; } catch (err) {
    throw new Error(`The pull can't be built into a working copy: ${(err as Error).message}`);
  }
}

/**
 * How many items a values patch changes.
 *
 * @param working - Decoded working-copy state.
 * @param after - State or buffer after the change.
 * @returns `number` result.
 */
const patchSize = (working: WorkingState, after: WorkingState): number => {
  const patch = diffStates(working, after);
  return patch ? ['residents', 'cards', 'settings'].reduce((total, key) => total + Object.keys((patch as Record<string, object>)[key] || {}).length, 0) : 0;
};

/**
 * A residents pull: its files become the base (what the gate holds) at once, and the working copy follows. Unsent
 * changes are put back on top of the pull (see rebasePlan); when the gate's or the working copy's directory code
 * digits or area-code mode changed, or the pull can't be edited (round-trip check), the gate's version is taken
 * and the changes are dropped. Other files (rcv_out.bin) are ignored. Run it while no edit is being saved.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Map of board filenames to binary buffers.
 * @param [at] - Timestamp (`Date` or milliseconds).
 * @returns Promise resolving to `PullResult & { status: CacheStatus }`.
 */
export async function applyPull(store: Store, phone: string, files: Record<string, Buffer>, at: Date = new Date()):
  Promise<PullResult & { status: CacheStatus }> {
  const pulled = fileMap(files, at);
  const none = { kept: 0, fromGate: 0, conflicts: [], notKept: [] };
  const result = await transaction(store, async (tx): Promise<PullResult> => {
    const copies = await loadCopies(tx, phone);
    if (!hasAll(pulled) || !hasAll(copies.base) || !hasAll(copies.working)) { await setBase(tx, phone, pulled); return { outcome: 'new', ...none }; }
    if (CACHE_FILES.every((file) => pulled.get(file)!.data.equals(copies.base.get(file)!.data))) {
      for (const file of CACHE_FILES) await putFile(tx, phone, 'base', file, pulled.get(file)!.data, at);
      return { outcome: 'unchanged', ...none };
    }
    if (!statusOf(copies).edited) { await setBase(tx, phone, pulled); return { outcome: 'refreshed', ...none }; }
    const board = boardOf(pulled);
    const mine = (await loadWorkingState(tx, phone))!;
    const oldBase = decodeWorking(boardOf(copies.base));
    const plan = rebasePlan(oldBase, mine.state, decodeWorking(board), mine.conflicts);
    const locked = !checkRoundTrip(board).ok;
    if (plan.layoutChanged || locked) {
      const count = patchSize(oldBase, mine.state);
      await setBase(tx, phone, pulled);
      return { outcome: 'dropped', ...none, dropped: { count, reason: locked
        ? 'the new pull can\'t be edited (its round-trip check failed)'
        : 'the directory code digits or the area-code mode changed, at the gate or in the working copy' } };
    }
    const built = buildRebase(board, plan, copies.masterCode);
    for (const name of CACHE_FILES) await putFile(tx, phone, 'base', name, pulled.get(name)!.data, at);
    await saveWorkingState(tx, phone, built.state, { baseOk: true, savedAt: mine.savedAt });
    const conflicts = plan.conflicts.filter((conflict) => !built.notKept.some((skipped) => skipped.kind === conflict.kind && skipped.key === conflict.key));
    await setConflicts(tx, phone, conflicts);
    return { outcome: 'rebased', kept: plan.changes.length - built.notKept.length, fromGate: plan.fromGate, conflicts, notKept: built.notKept };
  });
  return { ...result, status: await cacheStatus(store, phone) };
}

/**
 * Decides a conflict: mine keeps the working copy's value; gate takes the gate's (saved like any edit). Returns the
 * status.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param options - Options object.
 * @param options.kind - Item or operation kind.
 * @param options.key - Lookup key, API key, or setting key.
 * @param options.choice - Choice.
 * @returns Promise resolving to `CacheStatus`.
 * @throws HTTP 400/404/409 error on invalid input or conflict.
 */
export async function resolveConflict(store: Store, phone: string, { kind, key, choice }: { kind: unknown; key: unknown; choice: unknown }): Promise<CacheStatus> {
  if (choice !== 'mine' && choice !== 'gate') throw httpError('choice must be "mine" or "gate"', 400);
  const copies = await loadCopies(store, phone);
  const conflict = copies.conflicts.find((item) => item.kind === kind && item.key === String(key));
  if (!conflict) throw httpError('There is no such conflict', 404);
  if (choice === 'gate' && hasAll(copies.working)) {
    const gateValue = itemsOf(decodeWorking(boardOf(copies.base)))[conflict.kind].get(conflict.key) ?? null;
    const work = boardOf(copies.working);
    let built: BoardBuffers;
    try {
      built = withPointer(work.names, buildFiles(boardOf(copies.base), withItem(decodeWorking(work), conflict.kind, conflict.key, gateValue), { masterCode: copies.masterCode }));
    } catch (err) { throw httpError(`Can't take the gate's value: ${(err as Error).message}`, 409); }
    await writeCacheFiles(store, phone, { 'names.bin': built.names, 'phone.bin': built.phone, 'cards.bin': built.cards });
  }
  await setConflicts(store, phone, copies.conflicts.filter((other) => other !== conflict));
  return cacheStatus(store, phone);
}

/**
 * Makes the working copy when there is none yet.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `CacheStatus`.
 */
export async function ensureCache(store: Store, phone: string): Promise<CacheStatus> {
  const status = await cacheStatus(store, phone);
  return status.exists ? status : resetCache(store, phone);
}

/**
 * { data, base, savedTime, baseTime } for each working-copy file (throws 404 when one is missing).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `CacheFiles`.
 */
export async function readCacheFiles(store: Store, phone: string): Promise<CacheFiles> {
  return filesOf(await loadCopies(store, phone));
}
type CacheFiles = Record<string, { data: Buffer; base: Buffer; savedTime: Date; baseTime: Date }>;
function filesOf(copies: Loaded): CacheFiles {
  return Object.fromEntries(CACHE_FILES.map((name) => {
    const work = copies.working.get(name);
    const base = copies.base.get(name);
    if (!work || !base) throw httpError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
    return [name, { data: work.data, base: base.data, savedTime: work.savedAt, baseTime: base.savedAt }];
  }));
}

/**
 * The working copy's files (see readCacheFiles) and status (see cacheStatus) from one build, making the working copy
 * first when there is none yet (see ensureCache).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `{ files: CacheFiles; status: CacheStatus }`.
 */
export async function readCache(store: Store, phone: string): Promise<{ files: CacheFiles; status: CacheStatus }> {
  let copies = await loadCopies(store, phone);
  if (!statusOf(copies).exists) { await resetCache(store, phone); copies = await loadCopies(store, phone); }
  return { files: filesOf(copies), status: statusOf(copies) };
}

/**
 * { data, base, savedTime, baseTime } for one cached file.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param name - Display name or filename.
 * @returns Promise resolving to `{ data: Buffer; base: Buffer; savedTime: Date; baseTime: Date }`.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function readCacheFile(store: Store, phone: string, name: string):
  Promise<{ data: Buffer; base: Buffer; savedTime: Date; baseTime: Date }> {
  const copies = CACHE_FILES.includes(name) ? await loadCopies(store, phone, [name]) : null;
  const work = copies && copies.working.get(name);
  const base = copies && copies.base.get(name);
  if (!work || !base) throw httpError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
  return { data: work.data, base: base.data, savedTime: work.savedAt, baseTime: base.savedAt };
}

/**
 * Saves working-copy files (names.bin, phone.bin and/or cards.bin; the others stay as they are). Each must keep the
 * base file's size, except names.bin, which may switch area-code layout (see sizeOk). The files are decoded into
 * the working copy's values, which are stored only when the files rebuild from them byte for byte; otherwise
 * nothing is saved (409). Refused (409) while the base failed the round-trip check. Returns the changed blocks.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Map of board filenames to binary buffers.
 * @returns Promise resolving to `Record<string, number[]>`.
 */
export async function writeCacheFiles(store: Store, phone: string, files: Record<string, Buffer>): Promise<Record<string, number[]>> {
  return (await saveCacheFiles(store, phone, files)).blocks;
}
/**
 * writeCacheFiles that also returns the new status. With all three files given, the old working copy isn't built.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Map of board filenames to binary buffers.
 * @returns Promise resolving to `{ blocks: Record<string, number[]>; status: CacheStatus }`.
 * @throws HTTP 404/409 error on invalid input or conflict.
 */
export async function saveCacheFiles(store: Store, phone: string, files: Record<string, Buffer>):
  Promise<{ blocks: Record<string, number[]>; status: CacheStatus }> {
  const copies = await loadCopies(store, phone, CACHE_FILES, { build: !CACHE_FILES.every((file) => file in files) });
  for (const name of Object.keys(files)) {
    if (!CACHE_FILES.includes(name) || !copies.hasWorking) {
      throw httpError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
    }
  }
  if (!copies.baseOk) {
    throw httpError('Editing is locked for this gate: its last pull could not be rebuilt byte for byte from its values (round-trip check). Nothing was saved.', 409);
  }
  const merged = new Map(copies.working);
  for (const [name, data] of Object.entries(files)) {
    const base = copies.base.get(name)!.data;
    if (!sizeOk(name, base, data)) throw new Error(`${name} must stay ${base.length} bytes`);
    merged.set(name, { data, savedAt: new Date() });
  }
  const want = boardOf(merged);
  const state = decodeWorking(want);
  let rebuilt: BoardBuffers;
  try { rebuilt = buildFiles(boardOf(copies.base), state, { masterCode: copies.masterCode }); } catch (err) {
    throw httpError(`This change can't be stored as gate values (${(err as Error).message}). Nothing was saved.`, 409);
  }
  const diff = fileDifferences(want, rebuilt);
  if (diff.length) {
    throw httpError(`This change can't be stored as gate values: rebuilding gives different bytes (${diff
      .map((problem) => `${problem.file} ${problem.bytes} at ${problem.offsets.join(' ')}`).join('; ')}). Nothing was saved.`, 409);
  }
  await saveWorkingState(store, phone, state, { baseOk: true });
  return {
    blocks: Object.fromEntries(CACHE_FILES.map((file) => [file, changed(blockMap(copies.base.get(file)!.data, merged.get(file)!.data))])),
    status: statusOf({ ...copies, working: merged }),
  };
}

/**
 * Saves one working-copy file (see writeCacheFiles).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param name - Display name or filename.
 * @param data - Binary or structured payload.
 * @returns Promise resolving to `{ changedBlocks: number[] }`.
 */
export async function writeCacheFile(store: Store, phone: string, name: string, data: Buffer): Promise<{ changedBlocks: number[] }> {
  return { changedBlocks: (await writeCacheFiles(store, phone, { [name]: data }))[name] };
}

/**
 * Once per gate: a working copy stored as files (gate_files 'working', before the values tables) becomes values.
 * It must rebuild byte for byte from base + values; the files are deleted only then. Returns the gates converted.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `string[]`.
 */
export async function migrateWorkingFiles(store: Store): Promise<string[]> {
  const phones = (await all<{ phone: string }>(store, "SELECT DISTINCT phone FROM gate_files WHERE copy = 'working'")).map((row) => row.phone);
  for (const phone of phones) {
    const files = await loadFiles(store, phone, CACHE_FILES);
    await transaction(store, async (tx) => {
      if (hasAll(files.base) && hasAll(files.working)) {
        const work = boardOf(files.working);
        const state = decodeWorking(work);
        const diff = fileDifferences(work, buildFiles(boardOf(files.base), state));
        if (diff.length) throw new Error(`Gate ${phone}: its working copy doesn't rebuild from its values (${JSON.stringify(diff)}); kept as files`);
        const savedAt = new Date(Math.max(...[...files.working.values()].map((file) => file.savedAt.getTime())));
        await saveWorkingState(tx, phone, state, { baseOk: checkRoundTrip(boardOf(files.base)).ok, savedAt });
      }
      await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'working'", [phone]);
    });
  }
  return phones;
}

/**
 * Values the app learned to store after a working copy was saved (setting rows, the extra bytes, the file sizes) are
 * added, decoded from the working copy's files (where such bytes still come from the base); the rest is kept.
 * Returns the gates that got values.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `string[]`.
 */
export async function addMissingValues(store: Store): Promise<string[]> {
  const done: string[] = [];
  for (const { phone, complete } of await all<{ phone: string; complete: boolean }>(store,
    'SELECT phone, extra IS NOT NULL AND sizes IS NOT NULL AS complete FROM gate_working ORDER BY phone')) {
    const have = new Set((await all<{ key: string }>(store, 'SELECT key FROM gate_settings WHERE phone = $1', [phone])).map((row) => row.key));
    if (complete && GATE_SETTING_FIELDS.every((field) => field.secret || have.has(field.key))) continue;
    const copies = await loadCopies(store, phone);
    if (!hasAll(copies.working)) continue;
    const working = decodeWorking(boardOf(copies.working));
    await transaction(store, async (tx) => {
      const missing = decodeGateSettings(copies.working.get('names.bin')!.data).filter((setting) => !setting.secret && !have.has(setting.key));
      await addSettingRows(tx, phone, Object.fromEntries(missing.map((setting) => [setting.key, setting.value])));
      await run(tx, 'UPDATE gate_working SET extra = COALESCE(extra, $2), sizes = COALESCE(sizes, $3) WHERE phone = $1',
        [phone, JSON.stringify(working.extra), JSON.stringify(working.sizes)]);
    });
    done.push(phone);
  }
  return done;
}

/**
 * Once per gate: a newer pull kept in the `pulled` copy (until 2026-11-13) is applied like a residents pull now
 * (applyPull), then the copy is deleted. Returns { phone, outcome }.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `{ phone: string; outcome: PullResult['outcome'] | 'removed' }[]`.
 */
export async function migratePulledCopies(store: Store): Promise<{ phone: string; outcome: PullResult['outcome'] | 'removed' }[]> {
  const out: { phone: string; outcome: PullResult['outcome'] | 'removed' }[] = [];
  for (const { phone } of await all<{ phone: string }>(store, "SELECT DISTINCT phone FROM gate_files WHERE copy = 'pulled' ORDER BY phone")) {
    const { pulled } = await loadFiles(store, phone, CACHE_FILES);
    let outcome: PullResult['outcome'] | 'removed' = 'removed';
    if (hasAll(pulled)) {
      const at = new Date(Math.max(...[...pulled.values()].map((file) => file.savedAt.getTime())));
      outcome = (await applyPull(store, phone, Object.fromEntries([...pulled].map(([name, file]) => [name, file.data])), at)).outcome;
    }
    await run(store, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'pulled'", [phone]);
    out.push({ phone, outcome });
  }
  return out;
}

/**
 * A working-copy file (.bin) or its change map (.map) for download, or null.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param name - Display name or filename.
 * @returns Promise resolving to `Buffer | null`.
 */
export async function cacheFileData(store: Store, phone: string, name: string): Promise<Buffer | null> {
  const bin = CACHE_FILES.find((file) => file === name || mapName(file) === name);
  if (!bin) return null;
  const copies = await loadCopies(store, phone, [bin]);
  const work = copies.working.get(bin);
  const base = copies.base.get(bin);
  if (!work || !base) return null;
  return name === bin ? work.data : blockMap(base.data, work.data);
}

/**
 * Files and maps (keyed by .bin name) for a send. Refused when nothing changed, a file is missing, or conflicts with
 * the gate are still to be decided (Keep mine or Take the gate's).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to the operation result.
 */
export async function prepareSend(store: Store, phone: string) {
  const copies = await loadCopies(store, phone);
  const status = statusOf(copies);
  const fail = (msg: string): never => { throw httpError(msg, 409); };
  if (status.files.some((file) => !file.cached)) fail('The working copy is missing files. Pull residents from the gate.');
  if (status.conflicts.length) {
    fail(`Decide the ${status.conflicts.length} conflict(s) with the gate first (Keep mine or Take the gate's).`);
  }
  if (!status.edited) fail('The working copy has no changes to send.');
  const files: Record<string, Buffer> = {};
  const maps: Record<string, Buffer> = {};
  const changedBlocks: Record<string, number[]> = {};
  for (const name of CACHE_FILES) {
    const data = copies.working.get(name)!.data;
    const base = copies.base.get(name)!.data;
    if (!sizeOk(name, base, data)) fail(`${name} must stay ${base.length} bytes`);
    const map = blockMap(base, data);
    files[name] = data;
    maps[name] = map;
    changedBlocks[name] = changed(map);
  }
  return { files, maps, changedBlocks };
}

/**
 * Compares files pulled after a send with the working copy, or with sent (the files that were sent) when given.
 * differentBlocks lists the 128-byte blocks per file.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param pulled - `Record<string, Buffer | undefined>` value.
 * @param [sent] - `Record<string, Buffer>` value.
 * @returns Promise resolving to the operation result.
 */
export async function verifySend(store: Store, phone: string, pulled: Record<string, Buffer | undefined>, sent?: Record<string, Buffer>) {
  const work = sent ? null : await readCacheFiles(store, phone);
  const differentBlocks: Record<string, number[] | 'size differs'> = {};
  for (const name of CACHE_FILES) {
    const data = sent ? sent[name] : work![name].data;
    const got = pulled[name];
    if (!got || got.length !== data.length) { differentBlocks[name] = 'size differs'; continue; }
    const blocks = changed(blockMap(data, got));
    if (blocks.length) differentBlocks[name] = blocks;
  }
  return { matches: !Object.keys(differentBlocks).length, differentBlocks };
}

/**
 * After a send whose check pull holds what was sent: when the working copy is still what was sent, the pull becomes
 * the base and the working copy (null); when edits were saved during the send, the pull is applied like any residents
 * pull, so they stay on top as unsent changes (its result). Run it while no edit is being saved.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param pulled - `Record<string, Buffer>` value.
 * @param sent - `Record<string, Buffer>` value.
 * @returns Promise resolving to `(PullResult & { status: CacheStatus }) | null`.
 */
export async function acceptSentPull(store: Store, phone: string, pulled: Record<string, Buffer>, sent: Record<string, Buffer>):
  Promise<(PullResult & { status: CacheStatus }) | null> {
  if ((await verifySend(store, phone, sent)).matches) { await replaceBase(store, phone, pulled); return null; }
  return applyPull(store, phone, pulled);
}

/** Pulled files kept in gate_files. Board files (names/phone/cards) and the transaction ring buffer. */
const PULLED_FILES = [...CACHE_FILES, 'rcv_out.bin'];

function findFile(dir: string, name: string): string | null {
  const found = fs.existsSync(dir) && fs.readdirSync(dir).find((entry) => entry.toLowerCase() === name);
  return found ? path.join(dir, found) : null;
}

/**
 * One-time move of the board files kept on disk before gate_files (<root>/<phone>/*.bin, cache/base/*.bin,
 * cache/*.bin and cache/*.map): each copy is stored with its file time, read back and compared, then the files are
 * deleted (camera pictures in <root>/<phone>/snapshots stay). Returns { phone: files moved }, or null when it already ran.
 *
 * @param store - Database store handle.
 * @param root - `string` value.
 * @returns Promise resolving to `Record<string, number> | null`.
 * @throws Error when validation or the underlying operation fails.
 */
export async function importGateFiles(store: Store, root: string): Promise<Record<string, number> | null> {
  if (await getMeta(store, 'gateFilesImported')) return null;
  const moved: Record<string, number> = {};
  const gates = fs.existsSync(root) ? fs.readdirSync(root).filter((entry) => /^\d+$/.test(entry)) : [];
  for (const phone of gates) {
    const dir = path.join(root, phone);
    const sources: [Copy, string, string][] = [];
    for (const name of PULLED_FILES) {
      const file = findFile(dir, name);
      if (file) sources.push(['pulled', name, file]);
    }
    for (const name of CACHE_FILES) {
      const baseFile = findFile(path.join(dir, 'cache', 'base'), name);
      const workingFile = findFile(path.join(dir, 'cache'), name);
      if (baseFile && workingFile) sources.push(['base', name, baseFile], ['working', name, workingFile]);
    }
    if (!sources.length) continue;
    if (await one(store, 'SELECT 1 AS x FROM gate_files WHERE phone = $1', [phone])) {
      throw new Error(`Gate ${phone} already has files in the database; not importing its files from ${dir}`);
    }
    await transaction(store, async (tx) => {
      for (const [copy, name, file] of sources) await putFile(tx, phone, copy, name, fs.readFileSync(file), fs.statSync(file).mtime);
    });
    const back = await loadFiles(store, phone, PULLED_FILES);
    for (const [copy, name, file] of sources) {
      if (!back[copy].get(name)?.data.equals(fs.readFileSync(file))) throw new Error(`Gate ${phone}: ${copy} ${name} did not read back the same`);
    }
    for (const [, , file] of sources) fs.rmSync(file);
    for (const name of CACHE_FILES) fs.rmSync(path.join(dir, 'cache', mapName(name)), { force: true });
    for (const folder of [path.join(dir, 'cache', 'base'), path.join(dir, 'cache')]) {
      if (fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
    }
    moved[phone] = sources.length;
  }
  await setMeta(store, 'gateFilesImported', new Date().toISOString());
  return moved;
}
