// Gate camera snapshots. A gate can have a Dahua recorder, reached through Dahua's P2P cloud by the dahua-p2p
// package's relay tunnel (the bridge, run in this process). After a transactions pull, frames from the recording during each new
// transaction's minute are saved with ffmpeg to <gate dir>/snapshots/<YYYYMMDD-HHMM>/ch<N>-<SS>.jpg, and frames
// from the minute after it to ch<N>-a<SS>.jpg. In video mode each channel's recording from the start of the
// minute for VIDEO_SECS is saved instead, as ch<N>.mp4 with a first-frame picture ch<N>.jpg.
// Recorder playback takes local time (verified 2026-10-19); clockOffset (seconds) is added to the gate's time.
// Playback streams at about real-time speed, so a clip takes about VIDEO_SECS to fetch (verified 2026-10-19).
// The recorder password is encrypted in the database (see db.ts) and given only to ffmpeg (the tunnel needs just the serial).
import fs from 'node:fs';
import path from 'node:path';
import { phoneDigits, run, type Store } from './db.ts';
import type { CameraChannel, SnapshotMinute } from './types.ts';
import { posterFile } from './snapshot-files.ts';
import { afterMs, finished, frameJobs, frameOfFile, listSnapshots, minuteStart, NO_FOOTAGE_MSG, NO_RECORDING_MSG, noFootageMinute, pendingMinutes, playbackTime, recordSnapshot, shiftsOf } from './camera-log.ts';
import { createCameraRunner, NO_CONNECTION, STOPPED_MSG } from './camera-runner.ts';
import { type CameraConfig, CLIP_TRIES, type FrameJob, getCameraSettings, type Log, NO_VIDEO_MSG, type PendingMinute, type Recorder, SETTLE_MS, type Shifts, type TxRow, type WithPassword } from './camera-settings.ts';
import { httpError } from './errors.ts';

type CameraRunner = ReturnType<typeof createCameraRunner>;
// When the recorder has no recording at a frame's time, these seconds around it are tried (once each) and the
// first picture saved instead.
const NEARBY_SECS = [-2, 2];
const CLIP_MAX_PARTS = 8; // most parts joined into one video
const CLIP_GAP_STEP = 5; // seconds a video request moves on past a gap in the recording
const CLIP_SHORT_SECS = 5; // a video this much shorter than VIDEO_SECS counts as cut off
const CLIP_RESUMES = 2;
const VIDEO_SECS = 120;
type CodedError = Error & { code?: string; status?: number };
type RecorderConfig = CameraConfig & WithPassword;

type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: CodedError };

// Runs fns with at most `limit` at a time; returns their settled results in order.
async function settleAll<T>(fns: (() => Promise<T>)[], limit: number): Promise<Settled<T>[]> {
  const out = new Array<Settled<T>>(fns.length);
  let next = 0;
  const worker = async () => {
    while (next < fns.length) {
      const i = next++;
      try { out[i] = { value: await fns[i]() }; } catch (err) { out[i] = { error: err as CodedError }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return out;
}

// The frames of a minute still to grab: { kept, jobs } (kept: files in have that are on disk). Partial videos
// (short: { [file]: seconds }) are kept and grabbed again.
function missingFrames(cfg: CameraConfig, dir: string, minute: string, have: string[] = [], short: Shifts = {}):
  { kept: string[]; jobs: FrameJob[] } {
  const folder = path.join(dir, 'snapshots', minute);
  const kept = have.filter((f) => fs.existsSync(path.join(folder, f)));
  const jobs = frameJobs(cfg).filter(({ file }) => !kept.includes(file) || short[file]);
  return { kept, jobs };
}

const playbackQuery = (channel: number, at: number): string => `/cam/playback?channel=${channel}&starttime=${playbackTime(new Date(at))}`;
const clipQuery = (channel: number, at: number, secs = VIDEO_SECS): string =>
  `${playbackQuery(channel, at)}&endtime=${playbackTime(new Date(at + secs * 1000))}`;

const isShort = (secs: number): boolean => secs < VIDEO_SECS - CLIP_SHORT_SECS;
// short (file -> seconds) lists the videos that were cut off.
const noteShort = (short: Shifts, file: string, secs: number): void => {
  if (!isShort(secs)) {
    delete short[file];
    return;
  }
  short[file] = Math.round(secs);
};
const moveClip = (from: string, to: string): void => {
  fs.renameSync(from, to);
  if (fs.existsSync(posterFile(from))) fs.renameSync(posterFile(from), posterFile(to));
};
const dropClip = (file: string): void => { fs.rmSync(file, { force: true }); fs.rmSync(posterFile(file), { force: true }); };

interface ClipOptions { signal?: AbortSignal; onRetry?: (error: Error) => void; log?: Log }
interface ClipResult { secs: number; error: CodedError | null }

// Saves channel's VIDEO_SECS of video from time at (ms) to outFile (.mp4) and its first frame to
// posterFile(outFile). When the stream ends early (the P2P connection dropped; seen 2026-10-19) or sends no video
// (also seen), the rest is asked for from where it stopped (gaps in the recording are skipped; see grabClipOnce),
// and the parts are joined. A
// video still more than CLIP_SHORT_SECS short is asked for again from the start, up to cfg.clipTries (default
// CLIP_TRIES) times; the longest one is kept. Returns { secs, error }: the saved video's seconds and, when it is
// short, why. Throws when no video was saved. log(message) gets resumes and short videos.
async function grabClip(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, outFile: string,
  opts: ClipOptions = {}): Promise<ClipResult> {
  const name = path.basename(outFile);
  const { log = () => {} } = opts;
  const tries = cfg.clipTries || CLIP_TRIES;
  const best = outFile.replace(/\.mp4$/, '.best.mp4');
  let bestSecs = 0;
  let error: CodedError | null = null;
  for (let i = 1; i <= tries; i++) {
    let secs: number;
    try {
      secs = await grabClipOnce(runner, cfg, channel, at, outFile, opts);
    } catch (err) {
      if (!bestSecs || (err as Error).message === STOPPED_MSG) { dropClip(best); throw err; }
      error = err as CodedError;
      break;
    }
    if (!isShort(secs)) { dropClip(best); return { secs, error: null }; }
    const longer = secs > bestSecs;
    log(`${name}: the recorder sent ${Math.round(secs)} s of ${VIDEO_SECS} s, ${longer ? 'kept it' : 'deleted it (not longer than the one kept)'}${i < tries ? ', trying again' : ''}`);
    if (!longer) {
      dropClip(outFile);
      continue;
    }
    moveClip(outFile, best);
    bestSecs = secs;
  }
  moveClip(best, outFile);
  return { secs: bestSecs, error: error || new Error(`The recorder sent only ${Math.round(bestSecs)} s of ${VIDEO_SECS} s of video`) };
}

// grabClip to file, which may already hold a video of have seconds (0: none; VIDEO_SECS when complete): the new
// video replaces it when complete or longer. Returns { secs, error, saved } for the video in file (saved: the new
// one). Throws when there is no video in file.
async function saveClip(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, file: string, have: number,
  opts: ClipOptions = {}): Promise<ClipResult & { saved: boolean }> {
  // Always fetched beside the video and moved in when done, so a crash never leaves a cut-off ch<N>.mp4.
  const tmp = file.replace(/\.mp4$/, '.new.mp4');
  const { log = () => {} } = opts;
  let r: ClipResult;
  try {
    r = await grabClip(runner, cfg, channel, at, tmp, { ...opts, log: (message) => log(message.replace(path.basename(tmp), path.basename(file))) });
  } catch (err) {
    dropClip(tmp);
    if (!have || (err as Error).message === STOPPED_MSG) throw err;
    return { secs: have, error: err as CodedError, saved: false };
  }
  if (have && r.error && r.secs <= have) { dropClip(tmp); return { secs: have, error: r.error, saved: false }; }
  moveClip(tmp, file);
  return { ...r, saved: true };
}

// Seconds of the video file in a minute's folder: 0 when missing or not in the snapshot log (logged false: a file left
// by a crash), its short seconds when partial, else VIDEO_SECS.
const clipHave = (folder: string, file: string, logged: boolean, short: Shifts = {}): number =>
  (logged && fs.existsSync(path.join(folder, file)) ? short[file] || VIDEO_SECS : 0);

// One try of grabClip; returns the saved video's seconds plus the seconds the recorder has no recording of.
// A playback stream stops at a gap in the recording (a 404 just after it; a 15 s gap was seen 2026-10-20), so
// on "No recording" the request moves on CLIP_GAP_STEP seconds (once each) until the recording starts again.
// The stream also stops a second or two before a gap, so the rest is asked for while each part brings video (up to
// CLIP_MAX_PARTS parts); CLIP_RESUMES limits only the requests that bring none.
async function grabClipOnce(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, outFile: string,
  { signal, onRetry, log = () => {} }: ClipOptions = {}): Promise<number> {
  const name = path.basename(outFile);
  const files: string[] = [];
  const parts: string[] = [];
  let got = 0; // whole seconds covered: saved, or not recorded
  let skipped = 0; // of those, not recorded
  let gap = 0; // not recorded since the last part
  let empty = 0; // requests that brought no video
  const logGap = (end: string) => log(`${name}: no recording from +${got - gap} s to ${end}, skipped it`);
  try {
    for (let n = 0; empty <= CLIP_RESUMES && parts.length < CLIP_MAX_PARTS && got < VIDEO_SECS - CLIP_SHORT_SECS; n++) {
      const part = outFile.replace(/\.mp4$/, `.rec${n}.mp4`);
      const secs = VIDEO_SECS - got;
      files.push(part);
      if (n && !gap) log(`${name}: ${got ? `the recorder stopped after ${got} s, asking for the rest` : 'no video received, asking again'}`);
      try {
        await runner.grabFrame(cfg, clipQuery(channel, at + got * 1000, secs), part, { signal, onRetry, video: secs, once: gap > 0 });
      } catch (err) {
        const { message } = err as Error;
        if (message === STOPPED_MSG) throw err;
        if (message === NO_RECORDING_MSG) {
          const step = Math.min(CLIP_GAP_STEP, secs);
          got += step;
          skipped += step;
          gap += step;
          continue;
        }
        if (!parts.length) throw err;
        log(`${name}: the rest from +${got} s failed: ${message}`);
        break;
      }
      if (gap) { logGap(`+${got} s`); gap = 0; }
      const d = Math.floor(await runner.clipSeconds(part));
      if (d < 1) { empty++; continue; }
      parts.push(part);
      got += d;
    }
    if (gap && parts.length) logGap('the end');
    if (!parts.length) throw new Error(skipped ? NO_RECORDING_MSG : NO_VIDEO_MSG);
    return (await runner.finishClip(parts, outFile, posterFile(outFile))) + skipped;
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
}

// Grabs channel's frame at time at (ms); when the recorder has no recording then, tries NEARBY_SECS once each.
// Returns the seconds the saved picture is from at (0 when taken at at); otherwise throws the first error.
async function grabNearby(runner: CameraRunner, cfg: Recorder, channel: number, at: number, outFile: string,
  { signal, onRetry, log = () => {} }: ClipOptions = {}): Promise<number> {
  try {
    await runner.grabFrame(cfg, playbackQuery(channel, at), outFile, { signal, onRetry });
    return 0;
  } catch (err) {
    if ((err as Error).message !== NO_RECORDING_MSG) throw err;
    for (const second of NEARBY_SECS) {
      const query = playbackQuery(channel, at + second * 1000);
      try {
        await runner.grabFrame(cfg, query, outFile, { signal, once: true });
        log(`${path.basename(outFile)}: no recording at the planned time, took ${second > 0 ? '+' : ''}${second} s instead (${query})`);
        return second;
      } catch (e2) {
        const err = e2 as CodedError;
        if (err.message === STOPPED_MSG || err.code === NO_CONNECTION) throw e2;
      }
    }
    throw err;
  }
}

// Frames for one minute: each channel at each frame offset, skipping files already saved (have), one at a
// time over the tunnel. onFrame runs after each grab; signal stops the minute. Once the recorder cannot be
// reached (error code NO_CONNECTION) the minute's other frames are not tried. Returns { files, errors,
// stopped, unreachable, shifts, short } with files including have, shifts { [file]: seconds } for the new pictures
// taken off their planned time (see grabNearby) and short the minute's partial videos (see listSnapshots; given
// ones are grabbed again and kept unless a longer one comes). log(message) gets each retried, shifted and failed frame.
async function snapshotMinute(runner: CameraRunner, cfg: RecorderConfig, dir: string, { minute, ts }: PendingMinute, have: string[] = [],
  { signal, onFrame = () => {}, log = () => {}, short: given = {} }: { signal?: AbortSignal; onFrame?: () => void; log?: Log; short?: Shifts } = {}) {
  const folder = path.join(dir, 'snapshots', minute);
  fs.mkdirSync(folder, { recursive: true });
  const { kept, jobs } = missingFrames(cfg, dir, minute, have, given);
  let unreachable = null as CodedError | null;
  const shifts: Shifts = {};
  const short: Shifts = { ...given };
  const partialErrors: string[] = [];
  const results = await settleAll(jobs.map(({ channel, off, file, video }) => async () => {
    if (signal && signal.aborted) throw new Error(STOPPED_MSG);
    if (unreachable) throw unreachable;
    const at = ts + (cfg.clockOffset + off) * 1000;
    const query = video ? clipQuery(channel, at) : playbackQuery(channel, at);
    const onRetry = (error: Error) => log(`${minute}/${file} failed, trying again (${query}): ${error.message}`);
    try {
      if (!video) {
        const shift = await grabNearby(runner, cfg, channel, at, path.join(folder, file), { signal, onRetry, log: (message) => log(`${minute}/${message}`) });
        if (shift) shifts[file] = shift;
        return file;
      }
      const clip = await saveClip(runner, cfg, channel, at, path.join(folder, file), clipHave(folder, file, have.includes(file), given),
        { signal, onRetry, log: (message) => log(`${minute}/${message}`) });
      noteShort(short, file, clip.secs);
      if (clip.error) {
        if (clip.error.code === NO_CONNECTION) unreachable = clip.error;
        partialErrors.push(clip.error.message);
        log(`${minute}/${file} partial video kept (${Math.round(clip.secs)} s, ${query}): ${clip.error.message}`);
      }
    } catch (e) {
      const err = e as CodedError;
      if (err.code === NO_CONNECTION) unreachable = err;
      if (err.message !== STOPPED_MSG) log(`${minute}/${file} failed (${query}): ${err.message}`);
      throw e;
    } finally {
      if (!(signal && signal.aborted)) onFrame();
    }
    return file;
  }), 1);
  const stopped = Boolean(signal && signal.aborted);
  const files = [...new Set([...kept, ...results.filter((result) => result.value).map((result) => result.value as string)])];
  const errors = [...new Set([...results.filter((result) => result.error && result.error.message !== STOPPED_MSG).map((result) => (result.error as CodedError).message),
    ...partialErrors])];
  return { files, errors, stopped, unreachable: unreachable ? unreachable.message : null, shifts, short };
}

// Fetches one frame (or video) of a minute again (the picture's refresh button). The new picture replaces the
// saved one only once it is saved. The snapshot log gets the file; once every frame of the current settings is on disk the
// minute is done (attempts unchanged). Returns the minute's log entry; when no picture is saved, throws the
// grab's error with status 502 (the old picture, if any, is kept). A partial video is saved (marked short) only
// when longer than the saved one. log(message) gets retries and failures.
export async function refreshSnapshot(store: Store, runner: CameraRunner, phone: unknown, dir: string, minute: string, file: string,
  { log: logTo = () => {} }: { log?: Log } = {}): Promise<SnapshotMinute | undefined> {
  const cfg = await getCameraSettings(store, phone, { withPassword: true });
  if (!cfg) throw httpError('Save the camera settings first', 404);
  const frame = frameOfFile(file);
  const start = minuteStart(minute);
  if (!frame || start === null) throw httpError('Not a snapshot picture');
  const log = (m: string) => logTo(`Gate ${phone}: ${m}`);
  const folder = path.join(dir, 'snapshots', minute);
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, file.replace(/\.(jpg|mp4)$/, '.new.$1'));
  const at = start + (cfg.clockOffset + frame.off) * 1000;
  const query = frame.video ? clipQuery(frame.channel, at) : playbackQuery(frame.channel, at);
  const opts: ClipOptions = {
    onRetry: (e) => log(`${minute}/${file} refresh failed, trying again (${query}): ${e.message}`),
    log: (message) => log(`${minute}/${message.replace(path.basename(tmp), file)}`),
  };
  const snapshot = (await listSnapshots(store, phone))[minute];
  const short: Shifts = { ...(snapshot ? snapshot.short : {}) };
  const refreshVideo = async (): Promise<{ shift: number; clipError: CodedError | null }> => {
    const clip = await saveClip(runner, cfg, frame.channel, at, path.join(folder, file),
      clipHave(folder, file, Boolean(snapshot && snapshot.files.includes(file)), short), { ...opts, log: (message) => log(`${minute}/${message}`) });
    if (!clip.saved) throw clip.error;
    noteShort(short, file, clip.secs);
    if (clip.error) log(`${minute}/${file} refresh saved a partial video (${Math.round(clip.secs)} s, ${query}): ${clip.error.message}`);
    return { shift: 0, clipError: clip.error };
  };
  const refreshPicture = async (): Promise<{ shift: number; clipError: CodedError | null }> => {
    const shift = await grabNearby(runner, cfg, frame.channel, at, tmp, opts);
    fs.renameSync(tmp, path.join(folder, file));
    return { shift, clipError: null };
  };
  let shift = 0;
  let clipError: CodedError | null = null;
  try {
    ({ shift, clipError } = await (frame.video ? refreshVideo() : refreshPicture()));
  } catch (err) {
    const { message } = err as Error;
    if (!frame.video) fs.rmSync(tmp, { force: true });
    log(`${minute}/${file} refresh failed (${query}): ${message}`);
    throw httpError(message, 502);
  }
  const files = [...new Set([...(snapshot ? snapshot.files : []), file])].filter((f) => fs.existsSync(path.join(folder, f)));
  const complete = !missingFrames(cfg, dir, minute, files, short).jobs.length;
  const status = complete ? 'done' : clipError ? 'partial' : snapshot && snapshot.status !== 'failed' ? snapshot.status : 'partial';
  const shifts = { ...(snapshot ? snapshot.shifts : {}), [file]: shift };
  const error = complete ? null : clipError ? clipError.message : (snapshot && snapshot.error) || null;
  await run(store, `INSERT INTO snapshots (phone, minute, status, files, error, attempts, at, shifts, short)
    VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
    ON CONFLICT (phone, minute) DO UPDATE SET status = excluded.status, files = excluded.files, error = excluded.error, at = excluded.at,
    shifts = excluded.shifts, short = excluded.short`,
  [phoneDigits(phone), minute, status, JSON.stringify(files), error, new Date().toISOString(),
    JSON.stringify(shiftsOf(files, shifts)), JSON.stringify(shiftsOf(files, short))]);
  return (await listSnapshots(store, phone))[minute];
}

// A live frame from each channel, to check the settings: <dir>/snapshots/live/ch<N>.jpg.
export async function liveSnapshots(runner: CameraRunner, cfg: RecorderConfig, dir: string):
  Promise<(CameraChannel & { error?: string; file?: string })[]> {
  const folder = path.join(dir, 'snapshots', 'live');
  fs.mkdirSync(folder, { recursive: true });
  const results = await settleAll(cfg.channels.map(({ channel }) => () => runner.grabFrame(cfg,
    `/cam/realmonitor?channel=${channel}&subtype=0`, path.join(folder, `ch${channel}.jpg`))), 3);
  return cfg.channels.map((channel, i) => ({ ...channel, ...(results[i].error ? { error: results[i].error.message } : { file: `ch${channel.channel}.jpg` }) }));
}

export interface SnapshotProgress {
  minutes: number; minutesDone: number; frames: number; framesDone: number; current: string | null;
  byMinute: Record<string, { frames: number; done: number }>;
}
export interface SnapshotResult { minutes: number; done: number; partial: number; failed: number; stopped: boolean; error?: string }
interface RunSnapshotsOptions {
  now?: number; onStatus?: Log; onProgress?: (p: SnapshotProgress) => void; signal?: AbortSignal; log?: Log; minute?: string;
}

// Snapshots the gate's pending minutes (see pendingMinutes). rows: transaction rows. Returns null when the gate
// has no enabled camera settings, else { minutes, done, partial, failed, stopped }. done: every frame saved or
// not recorded; partial: some frames saved, others to try again on a later run; failed: no frame saved.
// onProgress gets { minutes, minutesDone, frames, framesDone, current, byMinute }: current is the minute being
// fetched (or null), byMinute { "<minute>": { frames, done } } the minutes not finished yet in this run.
// signal (AbortSignal) stops the run; the minute
// in progress is not recorded, so the next run does it again. When the recorder cannot be reached the run
// ends after that minute and the result also has error (the reason); the next run carries on.
// log(message) gets frame retries and failures, minutes not done, and why the run ended early.
// minute (YYYYMMDD-HHMM): snapshot only that minute (one transaction's button), whatever its transaction type,
// age or tries so far; a minute too recent to be recorded yet ends the run with error.
export async function runSnapshots(store: Store, runner: CameraRunner, phone: unknown, dir: string, rows: TxRow[],
  { now = Date.now(), onStatus = () => {}, onProgress = () => {}, signal, log: logTo = () => {}, minute }: RunSnapshotsOptions = {}):
  Promise<SnapshotResult | null> {
  const log = (m: string) => logTo(`Gate ${phone}: ${m}`);
  const cfg = await getCameraSettings(store, phone, { withPassword: true });
  if (!cfg || !cfg.enabled) return null;
  const known = await listSnapshots(store, phone);
  const start = minute ? minuteStart(minute) : null;
  if (minute && start === null) throw httpError('Not a transaction minute');
  if (minute && noFootageMinute(rows, minute)) throw httpError(NO_FOOTAGE_MSG);
  const tooRecent = start !== null && start > now - SETTLE_MS - afterMs(cfg);
  const pending: PendingMinute[] = !minute ? pendingMinutes(cfg, rows, known, now) : tooRecent ? [] : [{ minute, ts: start! }];
  const out: SnapshotResult = { minutes: pending.length, done: 0, partial: 0, failed: 0, stopped: false };
  if (tooRecent) out.error = 'This minute may not be recorded yet; try again in a few minutes';
  const byMinute: SnapshotProgress['byMinute'] = Object.fromEntries(pending.map((p) => [p.minute,
    { frames: missingFrames(cfg, dir, p.minute, known[p.minute]?.files, known[p.minute]?.short).jobs.length, done: 0 }]));
  const progress = {
    minutes: pending.length, minutesDone: 0, framesDone: 0,
    frames: Object.values(byMinute).reduce((n, m) => n + m.frames, 0), current: null as string | null,
  };
  const report = () => onProgress({ ...progress,
    byMinute: Object.fromEntries(Object.entries(byMinute).map(([k, m]) => [k, { ...m }])) });
  report();
  for (const p of pending) {
    if (signal && signal.aborted) { out.stopped = true; break; }
    progress.current = p.minute;
    report();
    const onFrame = () => { progress.framesDone++; byMinute[p.minute].done++; report(); };
    const { files, errors, stopped, unreachable, shifts, short } = await snapshotMinute(runner, cfg, dir, p, known[p.minute]?.files,
      { signal, onFrame, log, short: known[p.minute]?.short });
    if (stopped) { out.stopped = true; break; }
    progress.minutesDone++;
    progress.current = null;
    delete byMinute[p.minute];
    report();
    const status: 'failed' | 'done' | 'partial' = !files.length ? 'failed' : finished({ error: errors.join('; ') }) ? 'done' : 'partial';
    await recordSnapshot(store, phone, p.minute, { status, files, error: errors.join('; '), shifts: { ...known[p.minute]?.shifts, ...shifts },
      short, video: cfg.mode === 'video' });
    out[status]++;
    onStatus(`${p.minute}: ${files.length} frames${errors.length ? ` (${errors.join('; ')})` : ''}`);
    if (errors.length) log(`${p.minute} ${status}: ${files.length} frames saved (${errors.join('; ')})`);
    if (unreachable) { out.error = unreachable; log(`Snapshot run ended early: ${unreachable}`); break; }
  }
  return out;
}
