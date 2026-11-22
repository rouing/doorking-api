// Camera settings, live views and snapshots.
import * as dk from '../../index.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route } from '../routing.ts';
import { logger } from '../../src/logging.ts';

export function camerasRoutes(modules: Modules): Route[] {
  const { cameras, store } = modules.context;
  const { cameraTransactions } = modules.editing;
  const { forgetSnapRun, queueSnapshots, refreshSnapshot, saveCameras, sendImage, sendVideo, snapRunOf, stopSnapshots } = modules.snapshots;
  return [
    // Camera settings for this gate (shared by every account that manages it). The password is never returned;
    // PUT with a blank password keeps the saved one. Body: { enabled, serial, username, password,
    // channels: [{ channel, name }], clockOffset, frames, framesAfter, clipTries, events: 'access'|'all', backfillHours }.
    route('GET', `${G}/cameras`, 'gate', async ({ gate }) => [200, { settings: await dk.getCameraSettings(store, gate.phoneNumber) }]),
    route('PUT', `${G}/cameras`, 'gate-admin', ({ session, gate, body }) => saveCameras(session, gate, body)),
    route('DELETE', `${G}/cameras`, 'gate-admin', async ({ session, gate }) => {
      const removed = await dk.deleteCameraSettings(store, gate.phoneNumber);
      if (removed) {
        await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'camera', summary: 'Removed camera settings' });
        logger('camera').info`Gate ${gate.phoneNumber}: camera settings removed by ${session.user}`;
      }
      return [200, { removed }];
    }),

    // Grabs a live frame from each saved channel; frames are at .../snapshots/live/ch<N>.jpg.
    route('POST', `${G}/cameras/test`, 'gate-admin', async ({ session, gate }) => {
      const cfg = await dk.recorderSettings(store, gate.phoneNumber);
      if (!cfg) return [404, { error: 'Save the camera settings first' }];
      const channels = await dk.liveSnapshots(cameras, cfg, gate.dir);
      logger('camera')[channels.some((channel) => channel.error) ? 'warn' : 'info']`Gate ${gate.phoneNumber}: camera test by ${session.user}: ${channels
      .map((channel) => `channel ${channel.channel} ${channel.error ? `failed (${channel.error})` : 'ok'}`).join(', ')}`;
      return [200, { channels }];
    }),
    // Live view of a saved channel as MJPEG for an <img> (?quality=high: the main stream, else the sub stream).
    // The stream ends when the browser drops the request; 502 { error } when no picture came.
    route('GET', `${G}/cameras/live/:channel`, 'gate', async ({ session, gate, params, req, res }) => {
      const cfg = await dk.recorderSettings(store, gate.phoneNumber);
      if (!cfg) return [404, { error: 'Save the camera settings first' }];
      const channel = Number(params.channel);
      if (!cfg.channels.some((saved) => saved.channel === channel)) return [404, { error: 'Not a saved channel' }];
      const sub = new URL(req.url!, 'http://localhost').searchParams.get('quality') !== 'high';
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const name = `Gate ${gate.phoneNumber}: live view of channel ${channel} (${sub ? 'low' : 'high'})`;
      const started = Date.now();
      logger('camera').info`${name} opened by ${session.user}`;
      try {
        await cameras.liveStream(cfg, channel, res, { sub, signal: abort.signal, onStart: () => {
          logger('camera').info`${name}: first picture after ${Math.round((Date.now() - started) / 1000)} s`;
          res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          });
        } });
      } catch (err) {
        if (!res.headersSent && !abort.signal.aborted) return [502, { error: (err as Error).message }];
        logger('camera').error`${name} failed: ${(err as Error).message}`;
      }
      logger('camera').info`${name} ended after ${Math.round((Date.now() - started) / 1000)} s${abort.signal.aborted ? ' (closed in the browser)' : ''}`;
      if (!res.writableEnded) res.end();
      return undefined;
    }),

    // Snapshot log by minute (YYYYMMDD-HHMM, matching each transaction's `minute`) and the current/last run.
    route('GET', `${G}/snapshots`, 'gate', async ({ gate }) => [200, {
      snapshots: await dk.listSnapshots(store, gate.phoneNumber), run: snapRunOf(gate.phoneNumber),
    }]),
    // { minute } (optional, YYYYMMDD-HHMM): snapshot only that transaction's minute.
    route('POST', `${G}/snapshots/run`, 'gate', async ({ gate, body }) => {
      if (!await dk.getCameraSettings(store, gate.phoneNumber)) return [404, { error: 'Save the camera settings first' }];
      const minute = body && body.minute ? String(body.minute) : undefined;
      if (minute) {
        if (dk.minuteStart(minute) === null) return [400, { error: 'Not a transaction minute' }];
        if (dk.noFootageMinute(await cameraTransactions(gate.phoneNumber), minute)) return [400, { error: dk.NO_FOOTAGE_MSG }];
        const cur = snapRunOf(gate.phoneNumber);
        if (cur && cur.state === 'running') return [409, { error: 'Wait for the snapshot run to finish, or stop it' }];
      }
      queueSnapshots(gate.phoneNumber, gate.dir, minute);
      return [202, { ok: true }];
    }),
    route('POST', `${G}/snapshots/stop`, 'gate', ({ session, gate }) => {
      const stopped = stopSnapshots(gate.phoneNumber);
      if (stopped) logger('camera').info`Gate ${gate.phoneNumber}: snapshot run stopped by ${session.user}`;
      return [200, { stopped }];
    }),
    // Deletes every saved picture and the snapshot log (refused while a run is going).
    route('DELETE', `${G}/snapshots`, 'gate-admin', async ({ session, gate }) => {
      const cur = snapRunOf(gate.phoneNumber);
      if (cur && cur.state === 'running') return [409, { error: 'Stop the snapshot run first' }];
      const out = await dk.deleteSnapshots(store, gate.phoneNumber, gate.dir);
      forgetSnapRun(gate.phoneNumber);
      if (out.minutes || out.files) {
        await dk.addEvent(store, gate.phoneNumber, { user: session.user, action: 'camera', summary: `Deleted all camera snapshots (${out.files} pictures)` });
        logger('camera').info`Gate ${gate.phoneNumber}: all snapshots deleted by ${session.user} (${out.minutes} minutes, ${out.files} files)`;
      }
      return [200, out];
    }),
    // Fetches one picture again: { snapshot } (the minute's log entry); 502 { error } when no picture was saved.
    route('POST', `${G}/snapshots/:minute/:file/refresh`, 'gate', async ({ gate, params }) => {
      const cur = snapRunOf(gate.phoneNumber);
      if (cur && cur.state === 'running') return [409, { error: 'Wait for the snapshot run to finish, or stop it' }];
      if (dk.noFootageMinute(await cameraTransactions(gate.phoneNumber), params.minute)) return [400, { error: dk.NO_FOOTAGE_MSG }];
      const running = snapRunOf(gate.phoneNumber); // checked again: a run may have started while the transactions were read
      if (running && running.state === 'running') return [409, { error: 'Wait for the snapshot run to finish, or stop it' }];
      return [200, { snapshot: await refreshSnapshot(gate.phoneNumber, gate.dir, params.minute, params.file) }];
    }),
    route('GET', `${G}/snapshots/:minute/:file`, 'gate', ({ gate, params, req, res }) => {
      const file = dk.snapshotFile(gate.dir, params.minute, params.file);
      if (!file) return [404, { error: 'Snapshot not found' }];
      if (file.endsWith('.mp4')) {
        sendVideo(req, res, file);
        return undefined;
      }
      sendImage(res, file);
      return undefined;
    }),
  ];
}
