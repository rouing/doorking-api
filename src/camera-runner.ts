// Runs the dahua-p2p bridges (relay tunnels) and ffmpeg: single frames, videos and live views.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openTunnel } from 'dahua-p2p';
import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import { NO_RECORDING, NO_RECORDING_MSG } from './camera-log.ts';
import { type Log, NO_VIDEO_MSG, type Recorder } from './camera-settings.ts';

const LIVE_FPS = 8;
const LIVE_WIDTH = 960;
const LIVE_MAX_MS = 15 * 60000; // longest live view stream
const BIN_DIR = path.join(import.meta.dirname, '..', 'tools', 'bin');
// Hides secrets (and any user:pass@ in URLs) in tool output.
export function maskSecrets(text: unknown, secrets: string[] = []): string {
  let out = String(text || '').replace(/(rtsp:\/\/)[^@\s/]+@/gi, '$1***@');
  for (const secret of secrets.filter(Boolean)) {
    for (const v of new Set([secret, encodeURIComponent(secret)])) out = out.split(v).join('***');
  }
  return out;
}

// ffmpeg's path by platform: Windows ffmpeg.exe (x64; runs emulated on arm64), Linux ffmpeg-linux-<x64|arm64>.
const archName = (arch: string): string => (arch === 'arm64' ? 'arm64' : 'x64');
export const ffmpegExe = (binDir = BIN_DIR, arch: string = process.arch, platform: string = process.platform): string => path.join(binDir,
  platform === 'win32' ? 'ffmpeg.exe' : `ffmpeg-linux-${archName(arch)}`);
// The bundled ffmpeg when tools/bin has it (it is not in the git repository: too large), else ffmpeg on the PATH.
export const ffmpegCommand = (binDir = BIN_DIR): string => (fs.existsSync(ffmpegExe(binDir)) ? ffmpegExe(binDir) : 'ffmpeg');

// Outside Windows, adds the execute bit when it is missing (lost when the files are copied from Windows).
function executable(file: string): string {
  if (process.platform === 'win32') return file;
  try {
    const { mode } = fs.statSync(file);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch { /* spawn reports a missing file */ }
  return file;
}

// Runs the bridges and ffmpeg. One bridge (relay tunnel) per recorder (serial + username), started on first use and
// stopped after idleMs unused; it is replaced when its tunnel closes. A frame that fails is tried once more after
// retryWaitMs (a recorder 404 is not always final): on a new bridge when the tunnel closed or the stream never
// opened. A frame cut off in transfer (decoder errors; saved as
// a part-green picture) is deleted and tried once more straight away.
// A bridge that cannot connect (fails or times out before listening) is started again after connectWaitMs,
// then twice that, up to connectTries times; after that the error has code NO_CONNECTION.
// log(message) gets bridge starts, connections, unexpected closes and idle stops, each bridge connection
// failure, and live views retried on a new bridge.
// Videos (grabFrame's video option) are copied without re-encoding to a fragmented MP4 file of up to VIDEO_SECS,
// within clipMs (ffmpeg's MPEG-TS writer refuses the recorder's H.265 stream, verified 2026-10-19); finishClip
// turns that into the .mp4 and its first-frame picture. A bridge is not stopped as idle while a grab is using it.
const STREAM_NOT_OPENED = /Invalid data found|End of file|Connection refused/i;
const DAMAGED = /error while decoding|concealing|corrupt|Invalid NAL|Could not find ref|missing picture|PPS id|SPS id/i;
const DAMAGED_MSG = 'Picture damaged in transfer';
export const STOPPED_MSG = 'Stopped';
export const NO_CONNECTION = 'NO_CONNECTION';

// Waits ms; rejects with "Stopped" when signal aborts.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
    const onAbort = () => { clearTimeout(timer); reject(new Error(STOPPED_MSG)); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// kill: stops the bridge (its tunnel and local port).
interface Bridge {
  kill: () => void; port: Promise<number>; password: string; lines: string[];
  timer?: ReturnType<typeof setTimeout>; busy?: number; dead?: boolean; connected?: boolean;
}

interface CameraRunnerOptions {
  binDir?: string; ffmpegPath?: string; idleMs?: number; readyMs?: number; grabMs?: number; clipExtraMs?: number;
  connectTries?: number; connectWaitMs?: number; retryWaitMs?: number; log?: Log;
}
interface GrabOptions { signal?: AbortSignal; onRetry?: (error: Error) => void; once?: boolean; video?: number }
interface LiveOptions { sub?: boolean; signal?: AbortSignal; onStart?: () => void; maxMs?: number }

// ffmpegPath: the ffmpeg program to run; empty = ffmpegCommand(binDir).
export function createCameraRunner({ binDir = BIN_DIR, ffmpegPath = '', idleMs = 120000, readyMs = 45000, grabMs = 45000,
  clipExtraMs = 60000, connectTries = 3, connectWaitMs = 10000, retryWaitMs = 2000, log = () => {} }: CameraRunnerOptions = {}) {
  const bridges = new Map<string, Bridge>();

  function stop(key: string): void {
    const b = bridges.get(key);
    if (!b) return;
    bridges.delete(key);
    clearTimeout(b.timer);
    b.kill();
  }

  // The dahua-p2p package's relay tunnel (reliable PTCP layer), exposing the recorder's RTSP port on a local port. It
  // carries one stream at a time (later ones wait) and retries while the recorder still holds an earlier session.
  function start(key: string, cfg: Recorder): Bridge {
    const b = { password: cfg.password, lines: [] } as unknown as Bridge;
    let closeTunnel = () => {};
    let server: { close: () => void } | null = null;
    let killed = false;
    b.kill = () => { killed = true; server?.close(); closeTunnel(); };
    const note = (line: string) => { b.lines.push(line); if (b.lines.length > 20) b.lines.shift(); };
    const tail = () => (b.lines.length ? `: ${maskSecrets(b.lines.slice(-3).join(' | '), [cfg.password])}` : '');
    log(`Recorder ${cfg.serial}: starting bridge`);
    const ended = (why: string) => {
      b.dead = true;
      if (bridges.get(key) === b) {
        bridges.delete(key); clearTimeout(b.timer);
        if (b.connected && !killed) log(`Recorder ${cfg.serial}: bridge closed (${why})${tail()}`);
      }
    };
    b.port = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const opening = openTunnel({ serial: cfg.serial, log: note });
      let opened = false;
      try {
        const tunnel = await Promise.race([
          opening,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Camera bridge did not connect within ${readyMs / 1000} s${tail()}`)), readyMs); }),
        ]);
        opened = true;
        closeTunnel = () => tunnel.close('stopped');
        if (killed) { tunnel.close('stopped'); throw new Error('Camera bridge stopped'); }
        tunnel.on('closed', (reason) => { server?.close(); ended(String(reason || 'closed')); });
        const srv = await tunnel.listen(0, 554, '127.0.0.1');
        server = srv;
        b.connected = true;
        log(`Recorder ${cfg.serial}: bridge connected (${tunnel.stats.handshakeMs} ms)`);
        return (srv.address() as AddressInfo).port;
      } catch (err) {
        // Close what is open: a tunnel whose local port failed (closeTunnel and server are no-ops before it opened), or
        // one that connects after the timeout.
        server?.close();
        closeTunnel();
        if (!opened) opening.then((late) => late.close('timed out'), () => {});
        ended((err as Error).message);
        throw new Error(`Camera bridge: ${maskSecrets((err as Error).message, [cfg.password])}`);
      } finally { clearTimeout(timer); }
    })();
    b.port.catch(() => {});
    return b;
  }

  // The bridge's local port, starting the bridge when needed.
  function bridge(cfg: Recorder): { key: string; port: Promise<number>; b: Bridge } {
    const key = `${cfg.serial}|${cfg.username}`;
    let b = bridges.get(key);
    if (b && (b.password !== cfg.password || b.dead)) { stop(key); b = undefined; }
    if (!b) { b = start(key, cfg); bridges.set(key, b); }
    idle(key, b);
    return { key, port: b.port, b };
  }

  function idle(key: string, b: Bridge): void {
    clearTimeout(b.timer);
    if (!b.busy && bridges.get(key) === b) {
      b.timer = setTimeout(() => { log(`Recorder ${key.split('|')[0]}: bridge stopped after ${idleMs / 1000} s idle`); stop(key); }, idleMs);
    }
  }

  // video: seconds of video to save instead of one frame.
  function ffmpeg(url: string, outFile: string, secrets: string[], signal?: AbortSignal, video = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
      const input = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000)];
      const args = video
        ? [...input, '-i', url, '-t', String(video), '-map', '0:v:0', '-c', 'copy',
          '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov', '-y', outFile]
        : [...input, '-fflags', '+discardcorrupt', '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', outFile];
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      const timer = setTimeout(() => proc.kill(), video ? video * 1000 + clipExtraMs : grabMs + 5000);
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (error) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(`ffmpeg: ${error.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) { fs.rmSync(outFile, { force: true }); return reject(new Error(STOPPED_MSG)); }
        const saved = code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
        if (saved && (video || !DAMAGED.test(err))) return resolve();
        fs.rmSync(outFile, { force: true });
        if (saved) return reject(new Error(DAMAGED_MSG));
        const last = maskSecrets(err.trim().split(/\r?\n/).pop(), secrets);
        if (NO_RECORDING.test(last)) return reject(new Error(NO_RECORDING_MSG));
        reject(new Error(last || (code === null ? `No ${video ? 'video' : 'picture'} before the time limit` : `ffmpeg exited (code ${code})`)));
      });
    });
  }

  // Runs ffmpeg on local files: { code, err } (err: the last 4000 characters of its output).
  function localFfmpeg(args: string[], ms = 60000): Promise<{ code: number | null; err: string }> {
    return new Promise((resolve) => {
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), ['-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
      const timer = setTimeout(() => proc.kill(), ms);
      proc.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, err: error.message }); });
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
  }

  // A local video file's duration in seconds (0 when unreadable).
  async function clipSeconds(file: string): Promise<number> {
    const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec((await localFfmpeg(['-i', file], 30000)).err);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  }

  // Joins the recorded parts (in order) into outFile (.mp4, playable while loading; H.265 tagged hvc1 so Safari
  // plays it) and saves the first keyframe to poster. Returns the video's duration in seconds; throws when it has
  // less than a second of video.
  async function finishClip(parts: string[], outFile: string, poster: string): Promise<number> {
    const list = `${outFile}.parts.txt`;
    const input = parts.length > 1 ? ['-f', 'concat', '-safe', '0', '-i', list] : ['-i', parts[0]];
    const drop = () => { fs.rmSync(outFile, { force: true }); fs.rmSync(poster, { force: true }); };
    if (parts.length > 1) fs.writeFileSync(list, parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''));
    try {
      const tag = /Video: hevc/.test((await localFfmpeg(['-i', parts[0]], 30000)).err) ? ['-tag:v', 'hvc1'] : [];
      const r = await localFfmpeg(['-loglevel', 'error', '-skip_frame', 'nokey', ...input,
        '-map', '0:v:0', '-c', 'copy', ...tag, '-movflags', '+faststart', '-y', outFile,
        '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', poster]);
      if (r.code !== 0 || !fs.existsSync(outFile) || !fs.statSync(outFile).size) {
        drop();
        throw new Error(`Could not save the video: ${r.err.trim().split(/\r?\n/).pop() || `ffmpeg exited (code ${r.code})`}`);
      }
    } finally {
      fs.rmSync(list, { force: true });
    }
    const secs = await clipSeconds(outFile);
    if (secs < 1) { drop(); throw new Error(NO_VIDEO_MSG); }
    return secs;
  }

  // Saves one frame from rtsp://<bridge><pathQuery> (e.g. /cam/playback?channel=1&starttime=...) to outFile.
  // signal (AbortSignal) stops the grab: it rejects with "Stopped". onRetry(error) runs before the second try.
  // once: no second try (bridge connection tries still apply). video: seconds of the stream to save instead (see
  // above).
  async function grabFrame(cfg: Recorder, pathQuery: string, outFile: string,
    { signal, onRetry = () => {}, once = false, video = 0 }: GrabOptions = {}): Promise<void> {
    let retried = once;
    for (let fails = 0; ;) {
      if (signal && signal.aborted) throw new Error(STOPPED_MSG);
      const { key, port, b } = bridge(cfg);
      let localPort: number;
      try {
        localPort = await port;
      } catch (err) {
        const { message } = err as Error;
        if (signal && signal.aborted) throw new Error(STOPPED_MSG);
        if (bridges.get(key) === b) stop(key);
        log(`Recorder ${cfg.serial}: bridge did not connect (try ${fails + 1} of ${connectTries}): ${message}`);
        if (++fails >= connectTries) throw Object.assign(new Error(`Could not reach the recorder after ${fails} tries (${message})`), { code: NO_CONNECTION });
        await pause(connectWaitMs * fails, signal);
        continue;
      }
      try {
        const url = `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${localPort}${pathQuery}`;
        b.busy = (b.busy || 0) + 1;
        clearTimeout(b.timer);
        try {
          return await ffmpeg(url, outFile, [cfg.password], signal, video);
        } finally {
          b.busy--;
          idle(key, b);
        }
      } catch (e) {
        const err = e as Error;
        if (retried || err.message === STOPPED_MSG || (signal && signal.aborted)) throw e;
        retried = true;
        onRetry(err);
        if (err.message === DAMAGED_MSG) continue;
        if (bridges.get(key) === b && (b.dead || STREAM_NOT_OPENED.test(err.message))) stop(key);
        await pause(retryWaitMs, signal);
      }
    }
  }

  // Writes the live picture of one channel to out as MJPEG (multipart/x-mixed-replace; boundary=frame; up to
  // LIVE_WIDTH wide, LIVE_FPS a second). sub: the recorder's lower-resolution sub stream. onStart() runs before
  // the first write. Ends (resolves) when signal aborts, the stream stops, or after maxMs. Rejects when no
  // picture came; the stream is tried once more on a new bridge when the first try got none.
  async function liveStream(cfg: Recorder, channel: number | string, out: Writable,
    { sub = true, signal, onStart = () => {}, maxMs = LIVE_MAX_MS }: LiveOptions = {}): Promise<void> {
    const pathQuery = `/cam/realmonitor?channel=${channel}&subtype=${sub ? 1 : 0}`;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) return;
      const { key, port, b } = bridge(cfg);
      try {
        const localPort = await port;
        const url = `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${localPort}${pathQuery}`;
        b.busy = (b.busy || 0) + 1;
        clearTimeout(b.timer);
        try {
          return await mjpeg(url, out, [cfg.password], { signal, onStart, maxMs });
        } finally {
          b.busy--;
          idle(key, b);
        }
      } catch (err) {
        if (attempt || (signal && signal.aborted)) throw err;
        log(`Recorder ${cfg.serial}: live view of channel ${channel} failed, trying a new bridge: ${(err as Error).message}`);
        if (bridges.get(key) === b) stop(key);
      }
    }
  }

  function mjpeg(url: string, out: Writable, secrets: string[],
    { signal, onStart, maxMs }: { signal?: AbortSignal; onStart: () => void; maxMs: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return resolve();
      const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000),
        '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', url, '-map', '0:v:0', '-an',
        '-vf', `fps=${LIVE_FPS},scale=w='min(${LIVE_WIDTH},iw)':h=-2`, '-c:v', 'mjpeg', '-q:v', '6',
        '-f', 'mpjpeg', '-boundary_tag', 'frame', 'pipe:1'];
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let started = false;
      const firstTimer = setTimeout(() => proc.kill(), grabMs + 5000);
      const endTimer = setTimeout(() => proc.kill(), maxMs);
      proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      proc.stdout.on('data', (c) => {
        if (!started) { started = true; clearTimeout(firstTimer); onStart(); }
        if (!out.write(c)) { proc.stdout.pause(); out.once('drain', () => proc.stdout.resume()); }
      });
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (error) => {
        clearTimeout(firstTimer);
        clearTimeout(endTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(`ffmpeg: ${error.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(firstTimer);
        clearTimeout(endTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (started || (signal && signal.aborted)) return resolve();
        const last = maskSecrets(err.trim().split(/\r?\n/).pop(), secrets);
        reject(new Error(last || (code === null ? 'No picture before the time limit' : `ffmpeg exited (code ${code})`)));
      });
    });
  }

  const stopAll = () => { for (const key of [...bridges.keys()]) stop(key); };
  return { grabFrame, clipSeconds, finishClip, liveStream, stopAll, running: () => bridges.size };
}
