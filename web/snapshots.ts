// Camera snapshot runs, their clean-up, camera settings changes, and picture/video replies.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as dk from '../index.ts';
import type { CameraChannel } from '../src/types.ts';
import type { Body, Gate, Reply, Session, SnapRun } from './context.ts';
import type { ContextModule } from './context.ts';
import type { EditingModule } from './editing.ts';
import { logger, logMessages } from '../src/logging.ts';

export function createSnapshots(deps: ContextModule & EditingModule) {
  const { cameras, cameraTransactions, config, ROOT, store } = deps;
  // Camera snapshots: one run at a time per gate, separate from the gate connection. A run asked for while one
  // is running starts again when it ends. stopSnapshots ends a run after killing the frame in progress.
  const snapRuns = new Map<string, SnapRun>(); // phone -> { state, startedAt, finishedAt?, log, progress?, result?, error?, again?, stopping? }
  const snapAborts = new Map<string, AbortController>(); // phone -> AbortController of the running run
  const snapRefreshes = new Map<string, Promise<unknown>>(); // phone -> Promise of the last single-picture refresh (they run one at a time)
  const snapTidies = new Map<string, Promise<void>>(); // phone -> the snapshot clean-up running now (one at a time per gate)

  // Fetches one picture again (refresh button), after the gate's earlier refreshes.
  function refreshSnapshot(phone: string, dir: string, minute: string, file: string) {
    const run = Promise.all([snapRefreshes.get(phone), snapTidies.get(phone)]).catch(() => {}).then(() =>
      dk.refreshSnapshot(store, cameras, { phone, dir, minute, file }, { log: logMessages('camera') }));
    snapRefreshes.set(phone, run);
    run.catch(() => {}).finally(() => { if (snapRefreshes.get(phone) === run) snapRefreshes.delete(phone); });
    return run;
  }
  const SNAPSHOT_TIDY_MS = config.cameras.tidyMinutes * 60000;
  const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
  // Tidies a gate's saved snapshots (dk.tidySnapshots with its keepDays) and logs what was deleted. inRun: called by
  // the gate's snapshot run, which waited for refreshes; otherwise skipped while a run or refresh is going. rows: the
  // gate's transactions (cameraTransactions) when the caller has read them.
  // One clean-up per gate at a time: a caller arriving while one runs shares it, so two never delete under each other.
  function tidyGateSnapshots(phone: string, dir: string, { inRun = false, rows }: { inRun?: boolean; rows?: dk.TxRow[] } = {}): Promise<void> {
    const running = snapTidies.get(phone);
    if (running) return running;
    const cur = snapRuns.get(phone);
    if (!inRun && ((cur && cur.state === 'running') || snapRefreshes.has(phone))) return Promise.resolve();
    const run = tidyNow(phone, dir, rows).finally(() => { if (snapTidies.get(phone) === run) snapTidies.delete(phone); });
    snapTidies.set(phone, run);
    return run;
  }
  async function tidyNow(phone: string, dir: string, rows?: dk.TxRow[]): Promise<void> {
    const cfg = await dk.getCameraSettings(store, phone);
    const keep = (cfg && cfg.keepDays) || 0;
    const tidied = await dk.tidySnapshots(store, phone, dir, keep);
    if (tidied.minutes) {
      await dk.addEvent(store, phone, { user: 'app', action: 'camera',
        summary: `Deleted camera snapshots older than ${keep} days (${tidied.files} pictures and videos, ${tidied.minutes} minutes, ${mb(tidied.bytes)})` });
      logger('camera').info`Gate ${phone}: deleted ${tidied.minutes} snapshot minutes older than ${keep} days (${tidied.files} files, ${mb(tidied.bytes)})`;
    }
    const removed = await dk.removeNoFootageSnapshots(store, phone, dir, rows || await cameraTransactions(phone));
    if (removed.minutes) {
      await dk.addEvent(store, phone, { user: 'app', action: 'camera',
        summary: `Deleted camera footage of ${removed.minutes} minutes with only gate data transfers, hold-open events or other gate commands (${removed.files} pictures and videos, ${mb(removed.bytes)})` });
      logger('camera').info`Gate ${phone}: deleted the footage of ${removed.minutes} no-footage minutes (${removed.files} files, ${mb(removed.bytes)})`;
    }
    if (tidied.leftovers) logger('camera').info`Gate ${phone}: deleted ${tidied.leftovers} leftover video pieces (${mb(tidied.leftoverBytes)})`;
    if (tidied.missing) logger('camera').info`Gate ${phone}: ${tidied.missing} snapshot log entries marked removed (their files are no longer on disk)`;
  }
  // Every gate with camera settings or a snapshots folder (folders named by gate phone digits only, so a copy such as
  // 5550100.bak is never taken for the gate). Skipped while the previous round still runs.
  let tidyingAll = false;
  async function tidyAllSnapshots(): Promise<void> {
    if (tidyingAll) return;
    tidyingAll = true;
    try {
      const phones = new Set((await dk.all<{ phone: string }>(store, 'SELECT phone FROM cameras')).map((row) => row.phone));
      if (fs.existsSync(ROOT)) for (const name of fs.readdirSync(ROOT)) if (/^\d+$/.test(name) && fs.existsSync(path.join(ROOT, name, 'snapshots'))) phones.add(name);
      for (const phone of phones) {
        try { await tidyGateSnapshots(phone, path.join(ROOT, phone)); } catch (err) {
          logger('camera').error`Gate ${phone}: snapshot clean-up failed: ${(err as Error).message}`;
        }
      }
    } finally { tidyingAll = false; }
  }
  // minute: snapshot only that transaction minute (callers refuse it while a run is going). Returns a promise of
  // the finished run (the follow-up run when one was already running).
  function queueSnapshots(phone: string, dir: string, minute?: string): Promise<SnapRun> {
    const cur = snapRuns.get(phone);
    if (cur && cur.state === 'running') {
      cur.again = true;
      return cur.done.then(() => (snapRuns.get(phone) === cur ? cur : snapRuns.get(phone)!.done));
    }
    const run = { state: 'running', startedAt: new Date(), log: [], ...(minute ? { minute } : {}) } as Omit<SnapRun, 'done'> as SnapRun;
    const abort = new AbortController();
    snapRuns.set(phone, run);
    snapAborts.set(phone, abort);
    Object.defineProperty(run, 'done', { enumerable: false, value: (async () => {
      logger('camera').info`Gate ${phone}: snapshot run started${minute ? ` for ${minute}` : ''}`;
      try {
        await (snapRefreshes.get(phone) || Promise.resolve()).catch(() => {});
        const rows = await cameraTransactions(phone);
        await tidyGateSnapshots(phone, dir, { inRun: true, rows });
        run.result = await dk.runSnapshots(store, cameras, phone, dir, rows, {
          onStatus: (line) => { run.log.push(line); if (run.log.length > 200) run.log.shift(); },
          onProgress: (progress) => { run.progress = progress; },
          signal: abort.signal,
          log: logMessages('camera'),
          minute,
        });
        run.state = run.result && run.result.stopped ? 'stopped' : 'done';
        const counts = run.result ? `: ${run.result.done} saved, ${run.result.partial || 0} missing some frames, ${run.result.failed} without a picture`
          : ': camera settings not saved or off';
        logger('camera').info`Gate ${phone}: snapshot run ${run.state}${counts}`;
      } catch (err) {
        const { message } = err as Error;
        run.state = 'failed';
        run.error = message;
        logger('camera').error`Gate ${phone}: snapshot run failed: ${message}`;
      }
      run.finishedAt = new Date();
      if (snapAborts.get(phone) === abort) snapAborts.delete(phone);
      if (run.again && !abort.signal.aborted) queueSnapshots(phone, dir);
      return run;
    })() });
    return run.done;
  }
  // Scheduled snapshots: waits for a run started since `since` (the one a scheduled transactions pull queues),
  // else queues one. Returns { error } or { note }.
  async function scheduledSnapshots(phone: string, dir: string, since: Date): Promise<{ error?: string; note?: string }> {
    const cfg = await dk.getCameraSettings(store, phone);
    if (!cfg || !cfg.enabled) return { note: 'Snapshots skipped: camera settings not saved or off' };
    const cur = snapRuns.get(phone);
    const run = await (cur && cur.state === 'running' && cur.startedAt >= since ? cur.done : queueSnapshots(phone, dir));
    if (run.state === 'failed') return { error: run.error };
    if (!run.result) return { note: 'Snapshots skipped: camera settings not saved or off' };
    const counts = `${run.result.done} saved, ${run.result.partial || 0} missing some frames, ${run.result.failed} without a picture`;
    if (run.state === 'stopped') return { error: `stopped (${counts})` };
    if (run.result.error) return { error: `${run.result.error} (${counts})` };
    return { note: `Snapshots: ${counts}` };
  }
  // Stops every running snapshot run (server shutdown).
  function stopAllSnapshots(): void {
    for (const phone of [...snapAborts.keys()]) stopSnapshots(phone);
  }
  function stopSnapshots(phone: string): boolean {
    const abort = snapAborts.get(phone);
    if (!abort) return false;
    snapRuns.get(phone)!.stopping = true;
    abort.abort();
    return true;
  }
  const CAMERA_LABELS: Record<string, string> = {
    enabled: 'Enabled', serial: 'Recorder serial', username: 'Username', channels: 'Channels', clockOffset: 'Clock offset (s)',
    mode: 'Save', frames: 'Frames per transaction', framesAfter: 'Frames after the minute', clipTries: 'Video tries', events: 'Transactions', backfillHours: 'Look back (hours)',
    keepDays: 'Keep pictures',
  };
  const cameraText = (key: string, value: unknown): string => (key === 'keepDays' ? (value ? `${value} days` : 'Forever') : value == null ? '' : key === 'channels'
    ? (value as CameraChannel[]).map((channel) => `${channel.channel}${channel.name ? ` ${channel.name}` : ''}`).join(', ') : String(value));
  // Saves the gate's camera settings and records the change (never the password) in the gate's history.
  async function saveCameras(session: Session, gate: Gate, body: Body): Promise<Reply> {
    const was: Record<string, unknown> = { ...await dk.getCameraSettings(store, gate.phoneNumber) };
    const out = await dk.saveCameraSettings(store, gate.phoneNumber, session.user, body);
    const now: Record<string, unknown> = { ...out };
    const fields = Object.keys(CAMERA_LABELS).map((key) => ({ field: CAMERA_LABELS[key], from: cameraText(key, was[key]), to: cameraText(key, now[key]) }))
      .filter((field) => field.from !== field.to);
    if (body.password) fields.push({ field: 'Password', from: '', to: 'changed' });
    if (fields.length) {
      await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'camera', summary: 'Changed camera settings',
        details: [{ key: 'cameras', label: 'Camera settings', change: 'changed', fields }] });
      logger('camera').info`Gate ${gate.phoneNumber}: camera settings changed by ${session.user} (${fields.map((field) => field.field).join(', ')})`;
    }
    if (out && (out.keepDays || 0) !== ((was.keepDays as number) || 0)) await tidyGateSnapshots(gate.phoneNumber, gate.dir);
    return [200, out];
  }
  function sendImage(res: ServerResponse, file: string) {
    let data: Buffer;
    try { data = fs.readFileSync(file); } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Snapshot not found' }));
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(data);
  }
  // Sends an .mp4, honouring a single "Range: bytes=start-end" request (needed to seek, and by Safari to play).
  // The file is opened first (a clean-up deleting it then can't break the reply); pipeline closes it when the browser
  // cancels the request (as it does on every seek) or a read fails.
  function sendVideo(req: IncomingMessage, res: ServerResponse, file: string) {
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Snapshot not found' }));
    }
    const send = (stream: fs.ReadStream) => pipeline(stream, res, () => {});
    const size = fs.fstatSync(fd).size;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      return send(fs.createReadStream('', { fd }));
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      fs.closeSync(fd);
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return send(fs.createReadStream('', { fd, start, end }));
  }
  const snapRunOf = (phone: string): SnapRun | null => snapRuns.get(phone) || null;
  const forgetSnapRun = (phone: string) => { snapRuns.delete(phone); };
  // A single-picture refresh or a clean-up of the gate's snapshots is running.
  const snapshotWorkFor = (phone: string): boolean => snapRefreshes.has(phone) || snapTidies.has(phone);
  return { snapRunOf, snapshotWorkFor, forgetSnapRun, refreshSnapshot, SNAPSHOT_TIDY_MS, tidyAllSnapshots, queueSnapshots, scheduledSnapshots, stopAllSnapshots, stopSnapshots, saveCameras, sendImage, sendVideo };
}

export type SnapshotsModule = ReturnType<typeof createSnapshots>;
