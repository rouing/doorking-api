/**
 * @module src/camera-log
 *
 * The snapshot log (table snapshots): frame names and times, which minutes still need footage, and tidying saved files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { phoneDigits, all, run, type Store } from './db.ts';
import type { CameraChannel, SnapshotMinute } from './types.ts';
import { channelsForRelays, frameJobs, NO_FOOTAGE_EVENTS } from './snapshot-files.ts';
import { type CameraConfig, type PendingMinute, SETTLE_MS, type Shifts, type TxRow } from './camera-settings.ts';

const pad = (value: number): string => String(value).padStart(2, '0');
/**
 * Pieces of a video being fetched (grabClipOnce parts, grabClip's best try, saveClip's new video) and their pictures,
 * and finishClip's list of parts.
 */
const LEFTOVER = /\.(rec\d+|best|new)\.(mp4|jpg)$|\.parts\.txt$/;
const DAY_MS = 86400000;
const MAX_ATTEMPTS = 3;
const MAX_MINUTES_PER_RUN = 60;
/**
 * Snapshot folder name for a transaction time: YYYYMMDD-HHMM (local).
 *
 * @param ts - `number | string | Date` value.
 * @returns `string` result.
 */
export function minuteKey(ts: number | string | Date): string {
  const date = new Date(ts);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Playback starttime: YYYY_MM_DD_HH_MM_SS (local).
 *
 * @param date - `Date` value.
 * @returns `string` result.
 */
export function playbackTime(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('_');
}

/**
 * Extra wait before a minute can be fetched when its recording reaches into the next minute.
 *
 * @param cfg - Configuration or settings object.
 * @returns `number` result.
 */
export const afterMs = (cfg: CameraConfig): number => (cfg.mode === 'video' || cfg.framesAfter ? 60000 : 0);

/**
 * Transactions that never get camera footage: the gate's data transfers (RS232, modem), its hold-open schedule
 * (Hold Begin / Hold End), anti-pass back maintenance (Re-Sync, Counter) and the System relay commands (hold, release,
 * 1 hour, H/U) except a momentary open (System Admit, someone let in). They aren't fetched, even with events 'all',
 * nor for one minute on request.
 */
const NO_FOOTAGE = new Set(NO_FOOTAGE_EVENTS);
export const NO_FOOTAGE_MSG = 'Gate data transfers, hold-open events and other gate commands don\'t get camera footage';
/**
 * Footage applies.
 *
 * @param transaction - Transaction record or row.
 * @returns True when the condition holds.
 */
export const footageApplies = (transaction: { eventType?: string; access?: string }): boolean => !NO_FOOTAGE.has(transaction.eventType || '')
  && !(transaction.eventType === 'System' && transaction.access !== 'Admit');
/**
 * A minute whose transactions (rows) are all ones that never get footage (a minute with none isn't).
 *
 * @param rows - List of data rows.
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @returns True when the condition holds.
 */
export function noFootageMinute(rows: TxRow[], minute: string): boolean {
  const at = rows.filter((row) => minuteKey(row.ts) === minute);
  return at.length > 0 && !at.some(footageApplies);
}

/**
 * Every such minute at once (one pass over rows).
 *
 * @param rows - List of data rows.
 * @returns `Set<string>` result.
 */
export function noFootageMinutes(rows: TxRow[]): Set<string> {
  const footage = new Map<string, boolean>(); // minute -> whether a transaction in it gets footage
  for (const row of rows) {
    const minute = minuteKey(row.ts);
    footage.set(minute, footage.get(minute) || footageApplies(row));
  }
  return new Set([...footage].filter(([, gets]) => !gets).map(([minute]) => minute));
}

const wantsSnapshot = (cfg: CameraConfig, row: TxRow): boolean => footageApplies(row)
  && (cfg.events === 'all' || row.access === 'Admit' || row.access === 'Deny');

interface SnapshotRow {
  phone: string; minute: string; status: string; files: string[]; error: string | null; attempts: number;
  video_attempts: number | null; at: string; shifts: Shifts | null; short: Shifts | null;
}

/**
 * { [minute]: { status, files, error, attempts, videoAttempts, at, shifts, short } } for the gate. shifts: { [file]: seconds } for
 * pictures taken that many seconds from the planned time (see NEARBY_SECS). short: { [file]: seconds } for partial
 * videos (kept, fetched again later). videoAttempts: the runs made in video mode.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `Record<string, SnapshotMinute>`.
 */
export async function listSnapshots(store: Store, phone: string): Promise<Record<string, SnapshotMinute>> {
  const rows = await all<SnapshotRow>(store, 'SELECT * FROM snapshots WHERE phone = $1', [phoneDigits(phone)]);
  return Object.fromEntries(rows.map((row) => [row.minute,
    { status: row.status, files: row.files, error: row.error, attempts: row.attempts, videoAttempts: row.video_attempts || 0, at: row.at,
      shifts: row.shifts || {}, short: row.short || {} }]));
}

/**
 * Shifts of.
 *
 * @param files - Map of board filenames to binary buffers.
 * @param [shifts] - `Shifts` value.
 * @returns `Shifts` result.
 */
export const shiftsOf = (files: string[] | undefined, shifts: Shifts = {}): Shifts =>
  Object.fromEntries((files || []).filter((file) => shifts[file]).map((file) => [file, shifts[file]]));

interface SnapshotRecord { status: string; files?: string[]; error?: string | null; shifts?: Shifts; short?: Shifts; video?: boolean }

/**
 * video: the run was in video mode (counted in video_attempts too).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param options - Options object.
 * @param options.status - HTTP status code or relay status string.
 * @param options.files - Map of board filenames to binary buffers.
 * @param options.error - Error object or message.
 * @param options.shifts - Shifts.
 * @param options.short - Map of short video filenames to recorded durations in seconds.
 * @param [options.video] - When `true`, the run was in video mode (also counted in `video_attempts`).
 */
export async function recordSnapshot(store: Store, phone: string, minute: string,
  { status, files, error, shifts, short, video = false }: SnapshotRecord): Promise<void> {
  await run(store, `INSERT INTO snapshots (phone, minute, status, files, error, attempts, at, shifts, video_attempts, short)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)
    ON CONFLICT (phone, minute) DO UPDATE SET status = excluded.status, files = excluded.files, error = excluded.error,
    attempts = snapshots.attempts + 1, at = excluded.at, shifts = excluded.shifts,
    video_attempts = snapshots.video_attempts + excluded.video_attempts, short = excluded.short`,
  [phoneDigits(phone), minute, status, JSON.stringify(files || []), error || null, new Date().toISOString(),
    JSON.stringify(shiftsOf(files, shifts)), video ? 1 : 0, JSON.stringify(shiftsOf(files, short))]);
}

/**
 * A minute folder's saved pictures and videos (a video's first-frame picture not counted) and their bytes.
 *
 * @param folder - `string` value.
 * @returns `{ files: number; bytes: number }` result.
 */
function mediaIn(folder: string): { files: number; bytes: number } {
  const names = fs.readdirSync(folder);
  let files = 0;
  let bytes = 0;
  for (const name of names) {
    bytes += fs.statSync(path.join(folder, name)).size;
    if (name.endsWith('.mp4') || (name.endsWith('.jpg') && !names.includes(name.replace(/\.jpg$/, '.mp4')))) files++;
  }
  return { files, bytes };
}

interface TidyResult { minutes: number; files: number; bytes: number; leftovers: number; leftoverBytes: number; missing: number }

/**
 * Tidies a gate's saved snapshots (<dir>/snapshots): deletes leftover pieces of videos whose fetch was cut off
 * (LEFTOVER), deletes the minute folders older than keepDays (0 = keep forever), and marks the log entries whose
 * files are all gone as removed (status 'removed', no files, error = why) so they are not fetched again; an entry
 * missing only some files lists just the ones left. Call only while no snapshot run or refresh uses the folder.
 * Returns what was deleted: minutes/files/bytes (old minutes), leftovers/leftoverBytes, missing (entries marked).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param dir - Per-gate media directory on disk.
 * @param [keepDays] - Number of days to retain snapshots (`0` = forever).
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `TidyResult`.
 */
export async function tidySnapshots(store: Store, phone: string, dir: string, keepDays = 0, now = Date.now()): Promise<TidyResult> {
  const out: TidyResult = { minutes: 0, files: 0, bytes: 0, leftovers: 0, leftoverBytes: 0, missing: 0 };
  const cutoff = keepDays ? now - keepDays * DAY_MS : null;
  const old = (minute: string) => { const start = minuteStart(minute); return cutoff !== null && start !== null && start < cutoff; };
  const folder = path.join(dir, 'snapshots');
  if (fs.existsSync(folder)) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(folder, entry.name);
      for (const file of fs.readdirSync(sub)) {
        if (!LEFTOVER.test(file)) continue;
        out.leftovers++;
        out.leftoverBytes += fs.statSync(path.join(sub, file)).size;
        fs.rmSync(path.join(sub, file), { force: true });
      }
      if (entry.name === 'live' || !old(entry.name)) {
        if (!fs.readdirSync(sub).length) fs.rmdirSync(sub);
        continue;
      }
      const media = mediaIn(sub);
      out.minutes++;
      out.files += media.files;
      out.bytes += media.bytes;
      fs.rmSync(sub, { recursive: true, force: true });
    }
  }
  const phoneKey = phoneDigits(phone);
  for (const row of await all<SnapshotRow>(store, "SELECT * FROM snapshots WHERE phone = $1 AND status <> 'removed'", [phoneKey])) {
    if (!row.files.length) continue;
    const left = old(row.minute) ? [] : row.files.filter((file) => fs.existsSync(path.join(folder, row.minute, file)));
    if (left.length === row.files.length) continue;
    if (left.length) {
      await run(store, 'UPDATE snapshots SET files = $3, shifts = $4, short = $5 WHERE phone = $1 AND minute = $2',
        [phoneKey, row.minute, JSON.stringify(left), JSON.stringify(shiftsOf(left, row.shifts || {})), JSON.stringify(shiftsOf(left, row.short || {}))]);
      continue;
    }
    if (!old(row.minute)) out.missing++;
    await run(store, `UPDATE snapshots SET status = 'removed', files = '[]', shifts = '{}', short = '{}', error = $3
      WHERE phone = $1 AND minute = $2`, [phoneKey, row.minute, old(row.minute) ? `Deleted after ${keepDays} days` : 'The files are no longer on disk']);
  }
  return out;
}

/**
 * Deletes the saved footage of minutes whose transactions (rows) all never get footage (noFootageMinutes) and marks
 * them removed (error = why), so they are neither shown nor fetched again. Call only while no snapshot run or refresh
 * uses the folder. Returns { minutes, files, bytes }.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param dir - Per-gate media directory on disk.
 * @param rows - List of data rows.
 * @returns Promise resolving to `{ minutes: number; files: number; bytes: number }`.
 */
export async function removeNoFootageSnapshots(store: Store, phone: string, dir: string, rows: TxRow[]):
  Promise<{ minutes: number; files: number; bytes: number }> {
  const phoneKey = phoneDigits(phone);
  const out = { minutes: 0, files: 0, bytes: 0 };
  const noFootage = noFootageMinutes(rows);
  for (const row of await all<SnapshotRow>(store, "SELECT * FROM snapshots WHERE phone = $1 AND status <> 'removed'", [phoneKey])) {
    if (!noFootage.has(row.minute)) continue;
    const sub = path.join(dir, 'snapshots', row.minute);
    if (fs.existsSync(sub)) {
      const media = mediaIn(sub);
      out.files += media.files;
      out.bytes += media.bytes;
      fs.rmSync(sub, { recursive: true, force: true });
    }
    await run(store, `UPDATE snapshots SET status = 'removed', files = '[]', shifts = '{}', short = '{}', error = $3
      WHERE phone = $1 AND minute = $2`, [phoneKey, row.minute, NO_FOOTAGE_MSG]);
    out.minutes++;
  }
  return out;
}

/**
 * Deletes every saved picture (<dir>/snapshots, live pictures included) and the gate's snapshot log.
 * Returns { minutes, files }: log rows and picture files removed.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param dir - Per-gate media directory on disk.
 * @returns Promise resolving to `{ minutes: number; files: number }`.
 */
export async function deleteSnapshots(store: Store, phone: string, dir: string): Promise<{ minutes: number; files: number }> {
  const minutes = await run(store, 'DELETE FROM snapshots WHERE phone = $1', [phoneDigits(phone)]);
  const folder = path.join(dir, 'snapshots');
  let files = 0;
  if (fs.existsSync(folder)) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const names = fs.readdirSync(path.join(folder, entry.name));
      files += names.filter((name) => name.endsWith('.mp4') || (name.endsWith('.jpg') && !names.includes(name.replace(/\.jpg$/, '.mp4')))).length;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return { minutes, files };
}

/**
 * The recorder answers 404 for a playback time it has no recording of; after one more try (see grabFrame) the
 * frame counts as not recorded and is not asked for on later runs.
 */
export const NO_RECORDING = /404 Not Found|No recording at this time/i;
export const NO_RECORDING_MSG = 'No recording at this time';
/**
 * A minute is finished when every frame was saved or has no recording.
 *
 * @param snapshot - `{ error?: string | null }` value.
 * @returns True when the condition holds.
 */
export const finished = (snapshot: { error?: string | null }): boolean => !snapshot.error || String(snapshot.error).split('; ').every((part) => NO_RECORDING.test(part));

/**
 * Relays triggered in each wanted transaction minute (used to filter camera channels mapped to specific relays).
 *
 * @param cfg - Camera settings.
 * @param rows - Transaction rows.
 * @returns Map from `YYYYMMDD-HHMM` to set of triggered relay numbers (or `null` when no relay fired).
 */
export function minuteRelays(cfg: CameraConfig, rows: TxRow[]): Map<string, Set<number | null>> {
  const out = new Map<string, Set<number | null>>();
  for (const row of rows) {
    if (!wantsSnapshot(cfg, row)) continue;
    const minute = minuteKey(row.ts);
    let set = out.get(minute);
    if (!set) { set = new Set(); out.set(minute, set); }
    if (row.relays?.length) {
      for (const r of row.relays) set.add(r);
    } else {
      set.add(row.relay ?? null);
    }
  }
  return out;
}

/**
 * A logged minute still to fetch. Video mode: until every channel has its video, a minute with only pictures
 * is fetched again (its picture runs do not count); after a video run, finished and tries count as usual.
 *
 * @param cfg - Configuration or settings object.
 * @param snapshot - `SnapshotMinute` value.
 * @param [channels] - Filtered channel subset for this minute (defaults to `cfg.channels`).
 * @returns True when the condition holds.
 */
function needsRun(cfg: CameraConfig, snapshot: SnapshotMinute, channels: CameraChannel[] = cfg.channels): boolean {
  if (snapshot.status === 'removed') return false;
  if (!channels.length) return false;
  if (cfg.mode !== 'video') return !finished(snapshot) && snapshot.attempts < MAX_ATTEMPTS;
  if (frameJobs(cfg, channels).every(({ file }) => snapshot.files.includes(file) && !(snapshot.short || {})[file])) return false;
  return !snapshot.videoAttempts || (!finished(snapshot) && snapshot.videoAttempts < MAX_ATTEMPTS);
}

/**
 * Minutes still to snapshot, newest first: wanted transactions within backfillHours (and keepDays), not finished,
 * not removed, and not tried MAX_ATTEMPTS times (see needsRun). rows: transaction rows ({ ts, access }).
 *
 * @param cfg - Configuration or settings object.
 * @param rows - Transaction rows (`{ ts, access, eventType, relay }`).
 * @param done - Map of recorded snapshot minutes.
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns `PendingMinute[]` result.
 */
export function pendingMinutes(cfg: CameraConfig, rows: TxRow[], done: Record<string, SnapshotMinute>, now = Date.now()): PendingMinute[] {
  const since = Math.max(now - cfg.backfillHours * 3600000, cfg.keepDays ? now - cfg.keepDays * DAY_MS : -Infinity);
  const relaysByMinute = minuteRelays(cfg, rows);
  const seen = new Map<string, PendingMinute>();
  for (const row of rows) {
    if (!wantsSnapshot(cfg, row) || row.ts < since || row.ts > now - SETTLE_MS - afterMs(cfg)) continue;
    const minute = minuteKey(row.ts);
    if (seen.has(minute)) continue;
    const channels = channelsForRelays(cfg.channels, relaysByMinute.get(minute) || new Set());
    if (!channels.length) continue;
    const snapshot = done[minute];
    if (snapshot && !needsRun(cfg, snapshot, channels)) continue;
    seen.set(minute, { minute, ts: new Date(row.ts).setSeconds(0, 0), channels });
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_MINUTES_PER_RUN);
}

/**
 * ch<N>-<SS>.jpg / ch<N>-a<SS>.jpg -> { channel, off } (off in seconds from the minute's start), ch<N>.mp4 ->
 * { channel, off: 0, video: true }, or null.
 *
 * @param file - File path or filename.
 * @returns `{ channel: number; off: number; video?: boolean } | null` result.
 */
export function frameOfFile(file: unknown): { channel: number; off: number; video?: boolean } | null {
  const video = /^ch(\d{1,2})\.mp4$/.exec(String(file));
  if (video) return Number(video[1]) >= 1 && Number(video[1]) <= 64 ? { channel: Number(video[1]), off: 0, video: true } : null;
  const match = /^ch(\d{1,2})-(a?)(\d{2})\.jpg$/.exec(String(file));
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 64 || Number(match[3]) > 59) return null;
  return { channel: Number(match[1]), off: (match[2] ? 60 : 0) + Number(match[3]) };
}

/**
 * YYYYMMDD-HHMM -> the minute's start (local, ms), or null.
 *
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @returns `number | null` result.
 */
export function minuteStart(minute: unknown): number | null {
  const match = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(String(minute));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime() : null;
}

/**
 * Saved snapshot or video path, or null when the names are not snapshot names or the file is missing.
 *
 * @param dir - Per-gate media directory on disk.
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param file - File path or filename.
 * @returns `string | null` result.
 */
export function snapshotFile(dir: string, minute: string, file: string): string | null {
  if (!/^(\d{8}-\d{4}|live)$/.test(minute) || !/^ch\d{1,2}((-a?\d{2})?\.jpg|\.mp4)$/.test(file)) return null;
  const full = path.join(dir, 'snapshots', minute, file);
  return fs.existsSync(full) ? full : null;
}
