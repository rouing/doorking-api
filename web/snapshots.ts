// Camera snapshot runs, their clean-up, camera settings changes, and picture/video replies.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as dk from '../index.ts';
import type { CameraChannel } from '../src/types.ts';
import type { Body, Gate, Reply, Session, SnapRun } from './context.ts';
import type { ContextModule } from './context.ts';
import type { EditingModule } from './editing.ts';
import { logger, logMessages } from '../src/logging.ts';

export function createSnapshots(deps: ContextModule & EditingModule) {
  const { cameras, config, gateData, ROOT, store } = deps;
  // Camera snapshots: one run at a time per gate, separate from the gate connection. A run asked for while one
  // is running starts again when it ends. stopSnapshots ends a run after killing the frame in progress.
  const snapRuns = new Map<string, SnapRun>(); // phone -> { state, startedAt, finishedAt?, log, progress?, result?, error?, again?, stopping? }
  const snapAborts = new Map<string, AbortController>(); // phone -> AbortController of the running run
  const snapRefreshes = new Map<string, Promise<unknown>>(); // phone -> Promise of the last single-picture refresh (they run one at a time)
  const snapTidies = new Map<string, Promise<void>>(); // phone -> the snapshot clean-up running now (one at a time per gate)

  // Fetches one picture again (refresh button), after the gate's earlier refreshes.
  function refreshSnapshot(phone: string, dir: string, minute: string, file: string) {
    const p = Promise.all([snapRefreshes.get(phone), snapTidies.get(phone)]).catch(() => {}).then(() =>
      dk.refreshSnapshot(store, cameras, phone, dir, minute, file, { log: logMessages('camera') }));
    snapRefreshes.set(phone, p);
    p.catch(() => {}).finally(() => { if (snapRefreshes.get(phone) === p) snapRefreshes.delete(phone); });
    return p;
  }
  const SNAPSHOT_TIDY_MS = config.cameras.tidyMinutes * 60000;
  const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
  // Tidies a gate's saved snapshots (dk.tidySnapshots with its keepDays) and logs what was deleted. inRun: called by
  // the gate's snapshot run, which waited for refreshes; otherwise skipped while a run or refresh is going.
  // One clean-up per gate at a time: a caller arriving while one runs shares it, so two never delete under each other.
  function tidyGateSnapshots(phone: string, dir: string, inRun = false): Promise<void> {
    const running = snapTidies.get(phone);
    if (running) return running;
    const cur = snapRuns.get(phone);
    if (!inRun && ((cur && cur.state === 'running') || snapRefreshes.has(phone))) return Promise.resolve();
    const p = tidyNow(phone, dir).finally(() => { if (snapTidies.get(phone) === p) snapTidies.delete(phone); });
    snapTidies.set(phone, p);
    return p;
  }
  async function tidyNow(phone: string, dir: string): Promise<void> {
    const cfg = await dk.getCameraSettings(store, phone);
    const keep = (cfg && cfg.keepDays) || 0;
    const tidied = await dk.tidySnapshots(store, phone, dir, keep);
    if (tidied.minutes) {
      await dk.addEvent(store, phone, { user: 'app', action: 'camera',
        summary: `Deleted camera snapshots older than ${keep} days (${tidied.files} pictures and videos, ${tidied.minutes} minutes, ${mb(tidied.bytes)})` });
      logger('camera').info`Gate ${phone}: deleted ${tidied.minutes} snapshot minutes older than ${keep} days (${tidied.files} files, ${mb(tidied.bytes)})`;
    }
    const tx = (await gateData(phone)).transactions;
    const n = await dk.removeNoFootageSnapshots(store, phone, dir, tx ? tx.rows : []);
    if (n.minutes) {
      await dk.addEvent(store, phone, { user: 'app', action: 'camera',
        summary: `Deleted camera footage of ${n.minutes} minutes with only gate data transfers, hold-open events or other gate commands (${n.files} pictures and videos, ${mb(n.bytes)})` });
      logger('camera').info`Gate ${phone}: deleted the footage of ${n.minutes} no-footage minutes (${n.files} files, ${mb(n.bytes)})`;
    }
    if (tidied.leftovers) logger('camera').info`Gate ${phone}: deleted ${tidied.leftovers} leftover video pieces (${mb(tidied.leftoverBytes)})`;
    if (tidied.missing) logger('camera').info`Gate ${phone}: ${tidied.missing} snapshot log entries marked removed (their files are no longer on disk)`;
  }
  // Every gate with camera settings or a snapshots folder.
  // Every gate with camera settings or a snapshots folder (folders named by gate phone digits only, so a copy such as
  // 5550100.bak is never taken for the gate). Skipped while the previous round still runs.
  let tidyingAll = false;
  async function tidyAllSnapshots(): Promise<void> {
    if (tidyingAll) return;
    tidyingAll = true;
    try {
      const phones = new Set((await dk.all<{ phone: string }>(store, 'SELECT phone FROM cameras')).map((r) => r.phone));
      if (fs.existsSync(ROOT)) for (const d of fs.readdirSync(ROOT)) if (/^\d+$/.test(d) && fs.existsSync(path.join(ROOT, d, 'snapshots'))) phones.add(d);
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
    const r = { state: 'running', startedAt: new Date(), log: [], ...(minute ? { minute } : {}) } as Omit<SnapRun, 'done'> as SnapRun;
    const ac = new AbortController();
    snapRuns.set(phone, r);
    snapAborts.set(phone, ac);
    Object.defineProperty(r, 'done', { enumerable: false, value: (async () => {
      logger('camera').info`Gate ${phone}: snapshot run started${minute ? ` for ${minute}` : ''}`;
      try {
        await (snapRefreshes.get(phone) || Promise.resolve()).catch(() => {});
        await tidyGateSnapshots(phone, dir, true);
        const tx = (await gateData(phone)).transactions;
        r.result = await dk.runSnapshots(store, cameras, phone, dir, tx ? tx.rows : [], {
          onStatus: (line) => { r.log.push(line); if (r.log.length > 200) r.log.shift(); },
          onProgress: (p) => { r.progress = p; },
          signal: ac.signal,
          log: logMessages('camera'),
          minute,
        });
        r.state = r.result && r.result.stopped ? 'stopped' : 'done';
        const counts = r.result ? `: ${r.result.done} saved, ${r.result.partial || 0} missing some frames, ${r.result.failed} without a picture`
          : ': camera settings not saved or off';
        logger('camera').info`Gate ${phone}: snapshot run ${r.state}${counts}`;
      } catch (err) {
        const { message } = err as Error;
        r.state = 'failed';
        r.error = message;
        logger('camera').error`Gate ${phone}: snapshot run failed: ${message}`;
      }
      r.finishedAt = new Date();
      if (snapAborts.get(phone) === ac) snapAborts.delete(phone);
      if (r.again && !ac.signal.aborted) queueSnapshots(phone, dir);
      return r;
    })() });
    return r.done;
  }
  // Scheduled snapshots: waits for a run started since `since` (the one a scheduled transactions pull queues),
  // else queues one. Returns { error } or { note }.
  async function scheduledSnapshots(phone: string, dir: string, since: Date): Promise<{ error?: string; note?: string }> {
    const cfg = await dk.getCameraSettings(store, phone);
    if (!cfg || !cfg.enabled) return { note: 'Snapshots skipped: camera settings not saved or off' };
    const cur = snapRuns.get(phone);
    const r = await (cur && cur.state === 'running' && cur.startedAt >= since ? cur.done : queueSnapshots(phone, dir));
    if (r.state === 'failed') return { error: r.error };
    if (!r.result) return { note: 'Snapshots skipped: camera settings not saved or off' };
    const counts = `${r.result.done} saved, ${r.result.partial || 0} missing some frames, ${r.result.failed} without a picture`;
    if (r.state === 'stopped') return { error: `stopped (${counts})` };
    if (r.result.error) return { error: `${r.result.error} (${counts})` };
    return { note: `Snapshots: ${counts}` };
  }
  // Stops every running snapshot run (server shutdown).
  function stopAllSnapshots(): void {
    for (const phone of [...snapAborts.keys()]) stopSnapshots(phone);
  }
  function stopSnapshots(phone: string): boolean {
    const ac = snapAborts.get(phone);
    if (!ac) return false;
    snapRuns.get(phone)!.stopping = true;
    ac.abort();
    return true;
  }
  const CAMERA_LABELS: Record<string, string> = {
    enabled: 'Enabled', serial: 'Recorder serial', username: 'Username', channels: 'Channels', clockOffset: 'Clock offset (s)',
    mode: 'Save', frames: 'Frames per transaction', framesAfter: 'Frames after the minute', clipTries: 'Video tries', events: 'Transactions', backfillHours: 'Look back (hours)',
    keepDays: 'Keep pictures',
  };
  const cameraText = (k: string, v: unknown): string => (k === 'keepDays' ? (v ? `${v} days` : 'Forever') : v == null ? '' : k === 'channels'
    ? (v as CameraChannel[]).map((channel) => `${channel.channel}${channel.name ? ` ${channel.name}` : ''}`).join(', ') : String(v));
  // Saves the gate's camera settings and records the change (never the password) in the gate's history.
  async function saveCameras(session: Session, gate: Gate, body: Body): Promise<Reply> {
    const was: Record<string, unknown> = { ...await dk.getCameraSettings(store, gate.phoneNumber) };
    const out = await dk.saveCameraSettings(store, gate.phoneNumber, session.user, body);
    const now: Record<string, unknown> = { ...out };
    const fields = Object.keys(CAMERA_LABELS).map((k) => ({ field: CAMERA_LABELS[k], from: cameraText(k, was[k]), to: cameraText(k, now[k]) }))
      .filter((f) => f.from !== f.to);
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
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(fs.readFileSync(file));
  }
  // Sends an .mp4, honouring a single "Range: bytes=start-end" request (needed to seek, and by Safari to play).
  function sendVideo(req: IncomingMessage, res: ServerResponse, file: string) {
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      return fs.createReadStream(file).pipe(res);
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  return { snapRuns, refreshSnapshot, SNAPSHOT_TIDY_MS, tidyAllSnapshots, queueSnapshots, scheduledSnapshots, stopAllSnapshots, stopSnapshots, saveCameras, sendImage, sendVideo };
}

export type SnapshotsModule = ReturnType<typeof createSnapshots>;
