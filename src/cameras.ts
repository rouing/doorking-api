/**
 * @module src/cameras
 *
 * Gate camera snapshots. A gate can have a Dahua recorder, reached through Dahua's P2P cloud by the dahua-p2p
 * package's relay tunnel (the bridge, run in this process). After a transactions pull, frames from the recording during each new
 * transaction's minute are saved with ffmpeg to <gate dir>/snapshots/<YYYYMMDD-HHMM>/ch<N>-<SS>.jpg, and frames
 * from the minute after it to ch<N>-a<SS>.jpg. In video mode each channel's recording from the start of the
 * minute for VIDEO_SECS is saved instead, as ch<N>.mp4 with a first-frame picture ch<N>.jpg.
 * Recorder playback takes local time (verified 2026-10-19); clockOffset (seconds) is added to the gate's time.
 * Playback streams at about real-time speed, so a clip takes about VIDEO_SECS to fetch (verified 2026-10-19).
 * The recorder password is encrypted in the database (see db.ts) and given only to ffmpeg (the tunnel needs just the serial).
 */
import fs from 'node:fs';
import path from 'node:path';
import { phoneDigits, run, type Store } from './db.ts';
import type { CameraChannel, SnapshotMinute } from './types.ts';
import { frameJobs, posterFile, type FrameJob } from './snapshot-files.ts';
import { afterMs, finished, frameOfFile, listSnapshots, minuteStart, NO_FOOTAGE_MSG, NO_RECORDING_MSG, noFootageMinute, pendingMinutes, playbackTime, recordSnapshot, shiftsOf } from './camera-log.ts';
import { createCameraRunner, NO_CONNECTION, STOPPED_MSG } from './camera-runner.ts';
import { type CameraConfig, CLIP_TRIES, recorderSettings, type Log, NO_VIDEO_MSG, type PendingMinute, type Recorder, SETTLE_MS, type Shifts, type TxRow, type WithPassword } from './camera-settings.ts';
import { httpError } from './errors.ts';

type CameraRunner = ReturnType<typeof createCameraRunner>;
/**
 * When the recorder has no recording at a frame's time, these seconds around it are tried (once each) and the
 * first picture saved instead.
 */
const NEARBY_SECS = [-2, 2];
const CLIP_MAX_PARTS = 8; // most parts joined into one video
const CLIP_GAP_STEP = 5; // seconds a video request moves on past a gap in the recording
const CLIP_SHORT_SECS = 5; // a video this much shorter than VIDEO_SECS counts as cut off
const CLIP_RESUMES = 2;
const VIDEO_SECS = 120;
type CodedError = Error & { code?: string; status?: number };
type RecorderConfig = CameraConfig & WithPassword;

type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: CodedError };

/**
 * Runs fns with at most `limit` at a time; returns their settled results in order.
 *
 * @param fns - `(() => Promise<T>)[]` value.
 * @param limit - Maximum number of rows to return.
 * @returns Promise resolving to `Settled<T>[]`.
 */
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

/**
 * The frames of a minute still to grab: { kept, jobs } (kept: files in have that are on disk). Partial videos
 * (short: { [file]: seconds }) are kept and grabbed again.
 *
 * @param cfg - Configuration or settings object.
 * @param dir - Per-gate media directory on disk.
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param [have] - `string[]` value.
 * @param [short] - { [file]: seconds }.
 * @returns `{ kept: string[]; jobs: FrameJob[] }` result.
 */
function missingFrames(cfg: CameraConfig, dir: string, minute: string, have: string[] = [], short: Shifts = {}):
  { kept: string[]; jobs: FrameJob[] } {
  const folder = path.join(dir, 'snapshots', minute);
  const kept = have.filter((name) => fs.existsSync(path.join(folder, name)));
  const jobs = frameJobs(cfg).filter(({ file }) => !kept.includes(file) || short[file]);
  return { kept, jobs };
}

const playbackQuery = (channel: number, at: number): string => `/cam/playback?channel=${channel}&starttime=${playbackTime(new Date(at))}`;
const clipQuery = (channel: number, at: number, secs = VIDEO_SECS): string =>
  `${playbackQuery(channel, at)}&endtime=${playbackTime(new Date(at + secs * 1000))}`;

const isShort = (secs: number): boolean => secs < VIDEO_SECS - CLIP_SHORT_SECS;
/**
 * short (file -> seconds) lists the videos that were cut off.
 *
 * @param short - Map of short video filenames to recorded durations in seconds.
 * @param file - File path or filename.
 * @param secs - `number` value.
 */
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

/**
 * Saves channel's VIDEO_SECS of video from time at (ms) to outFile (.mp4) and its first frame to
 * posterFile(outFile). When the stream ends early (the P2P connection dropped; seen 2026-10-19) or sends no video
 * (also seen), the rest is asked for from where it stopped (gaps in the recording are skipped; see grabClipOnce),
 * and the parts are joined. A
 * video still more than CLIP_SHORT_SECS short is asked for again from the start, up to cfg.clipTries (default
 * CLIP_TRIES) times; the longest one is kept. Returns { secs, error }: the saved video's seconds and, when it is
 * short, why. Throws when no video was saved. log(message) gets resumes and short videos.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param channel - Recorder camera channel number (1–64).
 * @param at - Timestamp (`Date` or milliseconds).
 * @param outFile - Destination file path on disk.
 * @param [opts] - Optional settings.
 * @returns Promise resolving to `ClipResult`.
 * @throws Error when validation or the underlying operation fails.
 */
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

/**
 * grabClip to file, which may already hold a video of have seconds (0: none; VIDEO_SECS when complete): the new
 * video replaces it when complete or longer. Returns { secs, error, saved } for the video in file (saved: the new
 * one). Throws when there is no video in file.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param channel - Recorder camera channel number (1–64).
 * @param at - Timestamp (`Date` or milliseconds).
 * @param file - File path or filename.
 * @param have - `number` value.
 * @param [opts] - Optional settings.
 * @returns Promise resolving to `ClipResult & { saved: boolean }`.
 * @throws Error when validation or the underlying operation fails.
 */
async function saveClip(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, file: string, have: number,
  opts: ClipOptions = {}): Promise<ClipResult & { saved: boolean }> {
  /** Always fetched beside the video and moved in when done, so a crash never leaves a cut-off ch<N>.mp4. */
  const tmp = file.replace(/\.mp4$/, '.new.mp4');
  const { log = () => {} } = opts;
  let result: ClipResult;
  try {
    result = await grabClip(runner, cfg, channel, at, tmp, { ...opts, log: (message) => log(message.replace(path.basename(tmp), path.basename(file))) });
  } catch (err) {
    dropClip(tmp);
    if (!have || (err as Error).message === STOPPED_MSG) throw err;
    return { secs: have, error: err as CodedError, saved: false };
  }
  if (have && result.error && result.secs <= have) { dropClip(tmp); return { secs: have, error: result.error, saved: false }; }
  moveClip(tmp, file);
  return { ...result, saved: true };
}

/**
 * Seconds of the video file in a minute's folder: 0 when missing or not in the snapshot log (logged false: a file left
 * by a crash), its short seconds when partial, else VIDEO_SECS.
 *
 * @param folder - `string` value.
 * @param file - File path or filename.
 * @param logged - `boolean` value.
 * @param [short] - Map of short video filenames to recorded durations in seconds.
 * @returns `number` result.
 */
const clipHave = (folder: string, file: string, logged: boolean, short: Shifts = {}): number =>
  (logged && fs.existsSync(path.join(folder, file)) ? short[file] || VIDEO_SECS : 0);

/**
 * One try of grabClip; returns the saved video's seconds plus the seconds the recorder has no recording of.
 * A playback stream stops at a gap in the recording (a 404 just after it; a 15 s gap was seen 2026-10-20), so
 * on "No recording" the request moves on CLIP_GAP_STEP seconds (once each) until the recording starts again.
 * The stream also stops a second or two before a gap, so the rest is asked for while each part brings video (up to
 * CLIP_MAX_PARTS parts); CLIP_RESUMES limits only the requests that bring none.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param channel - Recorder camera channel number (1–64).
 * @param at - Timestamp (`Date` or milliseconds).
 * @param outFile - Destination file path on disk.
 * @param [options] - Options object.
 * @param [options.signal] - AbortSignal to cancel the operation.
 * @param [options.onRetry] - On retry.
 * @param [options.log] - Callback receiving progress or diagnostic messages.
 * @returns Promise resolving to `number`.
 * @throws Error when validation or the underlying operation fails.
 */
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
      const seconds = Math.floor(await runner.clipSeconds(part));
      if (seconds < 1) { empty++; continue; }
      parts.push(part);
      got += seconds;
    }
    if (gap && parts.length) logGap('the end');
    if (!parts.length) throw new Error(skipped ? NO_RECORDING_MSG : NO_VIDEO_MSG);
    return (await runner.finishClip(parts, outFile, posterFile(outFile))) + skipped;
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
  }
}

/**
 * Grabs channel's frame at time at (ms); when the recorder has no recording then, tries NEARBY_SECS once each.
 * Returns the seconds the saved picture is from at (0 when taken at at); otherwise throws the first error.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param channel - Recorder camera channel number (1–64).
 * @param at - Timestamp (`Date` or milliseconds).
 * @param outFile - Destination file path on disk.
 * @param [options] - Options object.
 * @param [options.signal] - AbortSignal to cancel the operation.
 * @param [options.onRetry] - On retry.
 * @param [options.log] - Callback receiving progress or diagnostic messages.
 * @returns Promise resolving to `number`.
 * @throws Error when validation or the underlying operation fails.
 */
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
      } catch (retryError) {
        const err = retryError as CodedError;
        if (err.message === STOPPED_MSG || err.code === NO_CONNECTION) throw retryError;
      }
    }
    throw err;
  }
}

/**
 * Frames for one minute: each channel at each frame offset, skipping files already saved (have), one at a
 * time over the tunnel. onFrame runs after each grab; signal stops the minute. Once the recorder cannot be
 * reached (error code NO_CONNECTION) the minute's other frames are not tried. Returns { files, errors,
 * stopped, unreachable, shifts, short } with files including have, shifts { [file]: seconds } for the new pictures
 * taken off their planned time (see grabNearby) and short the minute's partial videos (see listSnapshots; given
 * ones are grabbed again and kept unless a longer one comes). log(message) gets each retried, shifted and failed frame.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param dir - Per-gate media directory on disk.
 * @param options - Options object.
 * @param options.minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param options.ts - Ts.
 * @param [have] - `string[]` value.
 * @param [options6] - Options object.
 * @param [options6.signal] - AbortSignal to cancel the operation.
 * @param [options6.onFrame] - On frame.
 * @param [options6.log] - Callback receiving progress or diagnostic messages.
 * @param [options6.short] - Map of short video filenames to recorded durations in seconds.
 * @returns Promise resolving to the operation result.
 */
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
    } catch (caught) {
      const err = caught as CodedError;
      if (err.code === NO_CONNECTION) unreachable = err;
      if (err.message !== STOPPED_MSG) log(`${minute}/${file} failed (${query}): ${err.message}`);
      throw err;
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

/**
 * Fetches one frame (or video) of a minute again (the picture's refresh button). The new picture replaces the
 * saved one only once it is saved. The snapshot log gets the file; once every frame of the current settings is on disk the
 * minute is done (attempts unchanged). Returns the minute's log entry; when no picture is saved, throws the
 * grab's error with status 502 (the old picture, if any, is kept). A partial video is saved (marked short) only
 * when longer than the saved one. log(message) gets retries and failures.
 * Which saved picture or video: the gate, its media folder, the minute and the file name.
 */
export interface SnapshotFileRef { phone: string; dir: string; minute: string; file: string }

/**
 * Refresh snapshot.
 *
 * @param store - Database store handle.
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param ref - Target snapshot file reference (`phone`, `dir`, `minute`, `file`).
 * @param [options] - Options object.
 * @param [options.log] - Callback receiving progress or diagnostic messages.
 * @returns Promise resolving to `SnapshotMinute | undefined`.
 */
export async function refreshSnapshot(store: Store, runner: CameraRunner, ref: SnapshotFileRef,
  { log: logTo = () => {} }: { log?: Log } = {}): Promise<SnapshotMinute | undefined> {
  const target = await refreshTarget(store, ref);
  const log = (message: string) => logTo(`Gate ${ref.phone}: ${message}`);
  const short: Shifts = { ...target.snapshot.short };
  const { shift, clipError } = await fetchAgain(runner, target, short, log);
  await saveRefreshed(store, target, { shift, clipError, short });
  return (await listSnapshots(store, ref.phone))[ref.minute];
}

/**
 * What refreshSnapshot fetches: the recorder settings, the file's channel and offset, when it was taken (at, ms), the
 * minute's log entry and folder. Only a minute in the snapshot log, from one of the configured cameras.
 */
interface RefreshTarget extends SnapshotFileRef {
  cfg: RecorderConfig; frame: { channel: number; off: number; video?: boolean }; at: number; snapshot: SnapshotMinute; folder: string;
}
async function refreshTarget(store: Store, ref: SnapshotFileRef): Promise<RefreshTarget> {
  const cfg = await recorderSettings(store, ref.phone);
  if (!cfg) throw httpError('Save the camera settings first', 404);
  const frame = frameOfFile(ref.file);
  const start = minuteStart(ref.minute);
  if (!frame || start === null) throw httpError('Not a snapshot picture');
  const snapshot = (await listSnapshots(store, ref.phone))[ref.minute];
  if (!snapshot || !cfg.channels.some((channel) => channel.channel === frame.channel)) throw httpError('Snapshot not found', 404);
  const folder = path.join(ref.dir, 'snapshots', ref.minute);
  return { ...ref, cfg, frame, at: start + (cfg.clockOffset + frame.off) * 1000, snapshot, folder };
}

/**
 * Fetches the file again (a video: the rest of it, noted in short; a picture: the nearest recorded second). 502 when
 * nothing could be saved.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param options - Options object.
 * @param options.cfg - Configuration or settings object.
 * @param options.frame - Frame.
 * @param options.at - Timestamp (`Date` or milliseconds).
 * @param options.snapshot - Snapshot.
 * @param options.folder - Folder.
 * @param options.minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param options.file - File path or filename.
 * @param short - Map of short video filenames to recorded durations in seconds.
 * @param log - Callback receiving progress or diagnostic messages.
 * @returns Promise resolving to `{ shift: number; clipError: CodedError | null }`.
 * @throws HTTP 502 error on invalid input or conflict.
 */
async function fetchAgain(runner: CameraRunner, { cfg, frame, at, snapshot, folder, minute, file }: RefreshTarget, short: Shifts,
  log: (message: string) => void): Promise<{ shift: number; clipError: CodedError | null }> {
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, file.replace(/\.(jpg|mp4)$/, '.new.$1'));
  const query = frame.video ? clipQuery(frame.channel, at) : playbackQuery(frame.channel, at);
  const opts: ClipOptions = {
    onRetry: (error) => log(`${minute}/${file} refresh failed, trying again (${query}): ${error.message}`),
    log: (message) => log(`${minute}/${message.replace(path.basename(tmp), file)}`),
  };
  try {
    if (!frame.video) {
      const shift = await grabNearby(runner, cfg, frame.channel, at, tmp, opts);
      fs.renameSync(tmp, path.join(folder, file));
      return { shift, clipError: null };
    }
    const clip = await saveClip(runner, cfg, frame.channel, at, path.join(folder, file),
      clipHave(folder, file, snapshot.files.includes(file), short), { ...opts, log: (message) => log(`${minute}/${message}`) });
    if (!clip.saved) throw clip.error;
    noteShort(short, file, clip.secs);
    if (clip.error) log(`${minute}/${file} refresh saved a partial video (${Math.round(clip.secs)} s, ${query}): ${clip.error.message}`);
    return { shift: 0, clipError: clip.error };
  } catch (err) {
    const { message } = err as Error;
    if (!frame.video) fs.rmSync(tmp, { force: true });
    log(`${minute}/${file} refresh failed (${query}): ${message}`);
    throw httpError(message, 502);
  }
}

/**
 * The minute's status after a refresh: done once every frame is saved; else partial when this video came short or the
 * minute had failed, otherwise as it was.
 *
 * @param complete - `boolean` value.
 * @param clipError - `CodedError | null` value.
 * @param previous - `string` value.
 * @returns `string` result.
 */
function refreshedStatus(complete: boolean, clipError: CodedError | null, previous: string): string {
  if (complete) return 'done';
  if (clipError || previous === 'failed') return 'partial';
  return previous;
}

/**
 * Records the refreshed file in the minute's log entry.
 *
 * @param store - Database store handle.
 * @param options - Options object.
 * @param options.cfg - Configuration or settings object.
 * @param options.snapshot - Snapshot.
 * @param options.folder - Folder.
 * @param options.phone - Gate system phone number (digits or formatted).
 * @param options.dir - Per-gate media directory on disk.
 * @param options.minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param options.file - File path or filename.
 * @param options3 - Options object.
 * @param options3.shift - Shift.
 * @param options3.clipError - Clip error.
 * @param options3.short - Map of short video filenames to recorded durations in seconds.
 */
async function saveRefreshed(store: Store, { cfg, snapshot, folder, phone, dir, minute, file }: RefreshTarget,
  { shift, clipError, short }: { shift: number; clipError: CodedError | null; short: Shifts }): Promise<void> {
  const files = [...new Set([...snapshot.files, file])].filter((name) => fs.existsSync(path.join(folder, name)));
  const complete = !missingFrames(cfg, dir, minute, files, short).jobs.length;
  const status = refreshedStatus(complete, clipError, snapshot.status);
  const shifts = { ...snapshot.shifts, [file]: shift };
  const error = complete ? null : clipError ? clipError.message : snapshot.error || null;
  await run(store, `INSERT INTO snapshots (phone, minute, status, files, error, attempts, at, shifts, short)
    VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
    ON CONFLICT (phone, minute) DO UPDATE SET status = excluded.status, files = excluded.files, error = excluded.error, at = excluded.at,
    shifts = excluded.shifts, short = excluded.short`,
  [phoneDigits(phone), minute, status, JSON.stringify(files), error, new Date().toISOString(),
    JSON.stringify(shiftsOf(files, shifts)), JSON.stringify(shiftsOf(files, short))]);
}

/**
 * A live frame from each channel, to check the settings: <dir>/snapshots/live/ch<N>.jpg.
 *
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param cfg - Configuration or settings object.
 * @param dir - Per-gate media directory on disk.
 * @returns Promise resolving to `(CameraChannel & { error?: string; file?: string })[]`.
 */
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
  now?: number; onStatus?: Log; onProgress?: (progress: SnapshotProgress) => void; signal?: AbortSignal; log?: Log; minute?: string;
}

/**
 * Snapshots the gate's pending minutes (see pendingMinutes). rows: transaction rows. Returns null when the gate
 * has no enabled camera settings, else { minutes, done, partial, failed, stopped }. done: every frame saved or
 * not recorded; partial: some frames saved, others to try again on a later run; failed: no frame saved.
 * onProgress gets { minutes, minutesDone, frames, framesDone, current, byMinute }: current is the minute being
 * fetched (or null), byMinute { "<minute>": { frames, done } } the minutes not finished yet in this run.
 * signal (AbortSignal) stops the run; the minute
 * in progress is not recorded, so the next run does it again. When the recorder cannot be reached the run
 * ends after that minute and the result also has error (the reason); the next run carries on.
 * log(message) gets frame retries and failures, minutes not done, and why the run ended early.
 * minute (YYYYMMDD-HHMM): snapshot only that minute (one transaction's button), whatever its transaction type,
 * age or tries so far; a minute too recent to be recorded yet ends the run with error.
 *
 * @param store - Database store handle.
 * @param runner - Camera runner managing dahua-p2p bridges and ffmpeg.
 * @param phone - Gate system phone number (digits or formatted).
 * @param dir - Per-gate media directory on disk.
 * @param rows - Transaction rows.
 * @param [options] - Options object.
 * @param [options.now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @param [options.onStatus] - Callback receiving progress lines.
 * @param [options.onProgress] - Callback receiving snapshot progress updates.
 * @param [options.signal] - AbortSignal to cancel the operation.
 * @param [options.log] - Callback receiving progress or diagnostic messages.
 * @param [options.minute] - Transaction minute key (`YYYYMMDD-HHMM`).
 * @returns Promise resolving to `SnapshotResult | null`.
 */
export async function runSnapshots(store: Store, runner: CameraRunner, phone: string, dir: string, rows: TxRow[],
  { now = Date.now(), onStatus = () => {}, onProgress = () => {}, signal, log: logTo = () => {}, minute }: RunSnapshotsOptions = {}):
  Promise<SnapshotResult | null> {
  const log = (message: string) => logTo(`Gate ${phone}: ${message}`);
  const cfg = await recorderSettings(store, phone);
  if (!cfg || !cfg.enabled) return null;
  const known = await listSnapshots(store, phone);
  const { pending, tooRecent } = minutesToFetch(cfg, rows, known, minute, now);
  const out: SnapshotResult = { minutes: pending.length, done: 0, partial: 0, failed: 0, stopped: false };
  if (tooRecent) out.error = 'This minute may not be recorded yet; try again in a few minutes';
  const progress = snapshotProgress(pending, (item) => missingFrames(cfg, dir, item, known[item]?.files, known[item]?.short).jobs.length, onProgress);
  for (const item of pending) {
    if (signal && signal.aborted) { out.stopped = true; break; }
    progress.starting(item.minute);
    const { files, errors, stopped, unreachable, shifts, short } = await snapshotMinute(runner, cfg, dir, item, known[item.minute]?.files,
      { signal, onFrame: () => progress.frameSaved(item.minute), log, short: known[item.minute]?.short });
    if (stopped) { out.stopped = true; break; }
    progress.finished(item.minute);
    const status: 'failed' | 'done' | 'partial' = !files.length ? 'failed' : finished({ error: errors.join('; ') }) ? 'done' : 'partial';
    await recordSnapshot(store, phone, item.minute, { status, files, error: errors.join('; '), shifts: { ...known[item.minute]?.shifts, ...shifts },
      short, video: cfg.mode === 'video' });
    out[status]++;
    onStatus(`${item.minute}: ${files.length} frames${errors.length ? ` (${errors.join('; ')})` : ''}`);
    if (errors.length) log(`${item.minute} ${status}: ${files.length} frames saved (${errors.join('; ')})`);
    if (unreachable) { out.error = unreachable; log(`Snapshot run ended early: ${unreachable}`); break; }
  }
  return out;
}

/**
 * The minutes a run fetches: every pending one, or the one asked for (none while it may not be recorded yet: tooRecent).
 *
 * @param cfg - Configuration or settings object.
 * @param rows - List of data rows.
 * @param known - Map of existing snapshot log entries by minute.
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param now - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns `{ pending: PendingMinute[]; tooRecent: boolean }` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
function minutesToFetch(cfg: RecorderConfig, rows: TxRow[], known: Record<string, SnapshotMinute>, minute: string | undefined, now: number):
  { pending: PendingMinute[]; tooRecent: boolean } {
  if (!minute) return { pending: pendingMinutes(cfg, rows, known, now), tooRecent: false };
  const start = minuteStart(minute);
  if (start === null) throw httpError('Not a transaction minute');
  if (noFootageMinute(rows, minute)) throw httpError(NO_FOOTAGE_MSG);
  const tooRecent = start > now - SETTLE_MS - afterMs(cfg);
  return { pending: tooRecent ? [] : [{ minute, ts: start }], tooRecent };
}

/**
 * A run's progress, reported (onProgress) as each minute starts, each frame is saved and each minute ends.
 * framesOf(minute): the frames still to fetch for it.
 *
 * @param pending - `PendingMinute[]` value.
 * @param framesOf - `(minute: string) => number` value.
 * @param onProgress - Callback receiving snapshot progress updates.
 * @returns Operation result.
 */
function snapshotProgress(pending: PendingMinute[], framesOf: (minute: string) => number, onProgress: (progress: SnapshotProgress) => void) {
  const byMinute: SnapshotProgress['byMinute'] = Object.fromEntries(pending.map((item) => [item.minute, { frames: framesOf(item.minute), done: 0 }]));
  const state = {
    minutes: pending.length, minutesDone: 0, framesDone: 0,
    frames: Object.values(byMinute).reduce((total, counts) => total + counts.frames, 0), current: null as string | null,
  };
  const report = () => onProgress({ ...state, byMinute: Object.fromEntries(Object.entries(byMinute).map(([key, counts]) => [key, { ...counts }])) });
  report();
  return {
    starting: (minute: string) => { state.current = minute; report(); },
    frameSaved: (minute: string) => { state.framesDone++; byMinute[minute].done++; report(); },
    finished: (minute: string) => { state.minutesDone++; state.current = null; delete byMinute[minute]; report(); },
  };
}
