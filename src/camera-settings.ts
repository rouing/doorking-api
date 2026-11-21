// Camera settings: their types, limits and validation, and the cameras table.
import { encrypt, decrypt, phoneDigits, one, run, type Store } from './db.ts';
import type { CameraChannel, CameraSettings } from './types.ts';
import { httpError } from './errors.ts';

// Settings as validated by normalizeCameraSettings; with the recorder password for the runner.
export type CameraConfig = Omit<CameraSettings, 'savedBy' | 'savedAt'>;
export type WithPassword = { password: string };
export interface Recorder { serial: string; username: string; password: string }

export type Shifts = Record<string, number>;
export type Log = (message: string) => void;
// Transaction rows as read by transactions.ts (only the fields used here).
export interface TxRow { ts: number; access?: string; eventType?: string }
export interface PendingMinute { minute: string; ts: number }
export interface FrameJob { channel: number; off: number; file: string; video?: boolean }

const CAMERA_EVENTS: CameraSettings['events'][] = ['access', 'all']; // access: admitted/denied entries only
const CAMERA_MODES: CameraSettings['mode'][] = ['snapshots', 'video'];

export const CLIP_TRIES = 2; // default whole-video tries before a cut-off video fails (setting clipTries)
const MAX_CLIP_TRIES = 5;
export const NO_VIDEO_MSG = 'The recorder sent no video';

const MAX_CHANNELS = 8;

export const SETTLE_MS = 90000; // a minute this recent may not be fully recorded yet
const KEEP_DAYS = [15, 30, 60, 90, 0]; // how long saved snapshots are kept (setting keepDays); 0 = forever

const int = (v: unknown, def: number): number => (v === undefined || v === null || v === '' ? def : Number(v));

type CameraBody = Partial<Record<'enabled' | 'serial' | 'username' | 'clockOffset' | 'frames' | 'framesAfter' | 'events'
  | 'mode' | 'backfillHours' | 'clipTries' | 'keepDays' | 'channels', unknown>>;

// Returns { settings } or { error }. channels: [{ channel: 1-64, name }].
export function normalizeCameraSettings(body: unknown): { settings: CameraConfig; error?: undefined } | { settings?: undefined; error: string } {
  const b = (body || {}) as CameraBody;
  const serial = String(b.serial || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(serial)) return { error: 'Recorder serial must be 6-32 letters and digits' };
  const username = String(b.username || '').trim().slice(0, 64);
  if (!username) return { error: 'Recorder username is required' };
  const channels: CameraChannel[] = [];
  for (const c of (Array.isArray(b.channels) ? b.channels : []) as ({ channel?: unknown; name?: unknown } | null)[]) {
    if (!c || c.channel === '' || c.channel == null) continue;
    const channel = Number(c.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 64) return { error: 'Channels must be 1-64' };
    if (channels.some((x) => x.channel === channel)) return { error: `Channel ${channel} is listed twice` };
    channels.push({ channel, name: String(c.name || '').trim().slice(0, 40) });
  }
  if (!channels.length || channels.length > MAX_CHANNELS) return { error: `List 1-${MAX_CHANNELS} channels` };
  const clockOffset = int(b.clockOffset, 0);
  if (!Number.isInteger(clockOffset) || Math.abs(clockOffset) > 86400) return { error: 'Clock offset must be whole seconds within a day' };
  const frames = int(b.frames, 3);
  if (!Number.isInteger(frames) || frames < 1 || frames > 6) return { error: 'Frames per transaction must be 1-6' };
  const framesAfter = int(b.framesAfter, 0);
  if (!Number.isInteger(framesAfter) || framesAfter < 0 || framesAfter > 6) return { error: 'Frames after the minute must be 0-6' };
  const events = (b.events || 'access') as CameraSettings['events'];
  if (!CAMERA_EVENTS.includes(events)) return { error: `Events must be ${CAMERA_EVENTS.join(' or ')}` };
  const mode = (b.mode || 'snapshots') as CameraSettings['mode'];
  if (!CAMERA_MODES.includes(mode)) return { error: `Save must be ${CAMERA_MODES.join(' or ')}` };
  const backfillHours = int(b.backfillHours, 24);
  if (!Number.isInteger(backfillHours) || backfillHours < 0 || backfillHours > 720) return { error: 'Look-back hours must be 0-720' };
  const clipTries = int(b.clipTries, CLIP_TRIES);
  if (!Number.isInteger(clipTries) || clipTries < 1 || clipTries > MAX_CLIP_TRIES) return { error: `Video tries must be 1-${MAX_CLIP_TRIES}` };
  const keepDays = int(b.keepDays, 0);
  if (!KEEP_DAYS.includes(keepDays)) return { error: 'Keep pictures must be 15, 30, 60 or 90 days, or forever' };
  return { settings: { enabled: b.enabled !== false, serial, username, channels, clockOffset, mode, frames, framesAfter, clipTries, events,
    backfillHours, keepDays } };
}

interface CameraRow { phone: string; data: CameraSettings; password: string; saved_by: string; saved_at: string }

// The gate's camera settings (password only with withPassword), or null.
export function getCameraSettings(store: Store, phone: unknown, opts: { withPassword: true }): Promise<(CameraSettings & WithPassword) | null>;
export function getCameraSettings(store: Store, phone: unknown, opts?: { withPassword?: boolean }): Promise<CameraSettings | null>;
export async function getCameraSettings(store: Store, phone: unknown, { withPassword = false }: { withPassword?: boolean } = {}): Promise<CameraSettings | null> {
  const row = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!row) return null;
  return { ...row.data, savedBy: row.saved_by, savedAt: row.saved_at, ...(withPassword && { password: decrypt(store, row.password) }) };
}

// Saves the settings; a blank password keeps the saved one. Throws 400 on bad input.
export async function saveCameraSettings(store: Store, phone: unknown, user: unknown, body: unknown): Promise<CameraSettings | null> {
  const { settings, error } = normalizeCameraSettings(body);
  if (error) throw httpError(error);
  const password = String((body && (body as { password?: unknown }).password) || '');
  const old = await one<{ password: string }>(store, 'SELECT password FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!password && !old) throw httpError('Recorder password is required');
  await run(store, `INSERT INTO cameras (phone, data, password, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET data = excluded.data, password = excluded.password, saved_by = excluded.saved_by,
    saved_at = excluded.saved_at`,
  [phoneDigits(phone), JSON.stringify(settings), password ? encrypt(store, password) : old!.password, String(user), new Date().toISOString()]);
  return getCameraSettings(store, phone);
}

export async function deleteCameraSettings(store: Store, phone: unknown): Promise<boolean> {
  return (await run(store, 'DELETE FROM cameras WHERE phone = $1', [phoneDigits(phone)])) > 0;
}
