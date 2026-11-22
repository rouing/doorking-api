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

const CAMERA_EVENTS: CameraSettings['events'][] = ['access', 'all']; // access: admitted/denied entries only
const CAMERA_MODES: CameraSettings['mode'][] = ['snapshots', 'video'];

export const CLIP_TRIES = 2; // default whole-video tries before a cut-off video fails (setting clipTries)
const MAX_CLIP_TRIES = 5;
export const NO_VIDEO_MSG = 'The recorder sent no video';

const MAX_CHANNELS = 8;

export const SETTLE_MS = 90000; // a minute this recent may not be fully recorded yet
const KEEP_DAYS = [15, 30, 60, 90, 0]; // how long saved snapshots are kept (setting keepDays); 0 = forever

const int = (value: unknown, def: number): number => (value === undefined || value === null || value === '' ? def : Number(value));

type CameraBody = Partial<Record<'enabled' | 'serial' | 'username' | 'clockOffset' | 'frames' | 'framesAfter' | 'events'
  | 'mode' | 'backfillHours' | 'clipTries' | 'keepDays' | 'channels', unknown>>;

// The checked settings; throws 400 (httpError) on bad input. channels: [{ channel: 1-64, name }].
export function normalizeCameraSettings(body: unknown): CameraConfig {
  const input = (body || {}) as CameraBody;
  const serial = String(input.serial || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(serial)) throw httpError('Recorder serial must be 6-32 letters and digits');
  const username = String(input.username || '').trim().slice(0, 64);
  if (!username) throw httpError('Recorder username is required');
  const channels: CameraChannel[] = [];
  for (const item of (Array.isArray(input.channels) ? input.channels : []) as ({ channel?: unknown; name?: unknown } | null)[]) {
    if (!item || item.channel === '' || item.channel == null) continue;
    const channel = Number(item.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 64) throw httpError('Channels must be 1-64');
    if (channels.some((listed) => listed.channel === channel)) throw httpError(`Channel ${channel} is listed twice`);
    channels.push({ channel, name: String(item.name || '').trim().slice(0, 40) });
  }
  if (!channels.length || channels.length > MAX_CHANNELS) throw httpError(`List 1-${MAX_CHANNELS} channels`);
  const clockOffset = int(input.clockOffset, 0);
  if (!Number.isInteger(clockOffset) || Math.abs(clockOffset) > 86400) throw httpError('Clock offset must be whole seconds within a day');
  const frames = int(input.frames, 3);
  if (!Number.isInteger(frames) || frames < 1 || frames > 6) throw httpError('Frames per transaction must be 1-6');
  const framesAfter = int(input.framesAfter, 0);
  if (!Number.isInteger(framesAfter) || framesAfter < 0 || framesAfter > 6) throw httpError('Frames after the minute must be 0-6');
  const events = (input.events || 'access') as CameraSettings['events'];
  if (!CAMERA_EVENTS.includes(events)) throw httpError(`Events must be ${CAMERA_EVENTS.join(' or ')}`);
  const mode = (input.mode || 'snapshots') as CameraSettings['mode'];
  if (!CAMERA_MODES.includes(mode)) throw httpError(`Save must be ${CAMERA_MODES.join(' or ')}`);
  const backfillHours = int(input.backfillHours, 24);
  if (!Number.isInteger(backfillHours) || backfillHours < 0 || backfillHours > 720) throw httpError('Look-back hours must be 0-720');
  const clipTries = int(input.clipTries, CLIP_TRIES);
  if (!Number.isInteger(clipTries) || clipTries < 1 || clipTries > MAX_CLIP_TRIES) throw httpError(`Video tries must be 1-${MAX_CLIP_TRIES}`);
  const keepDays = int(input.keepDays, 0);
  if (!KEEP_DAYS.includes(keepDays)) throw httpError('Keep pictures must be 15, 30, 60 or 90 days, or forever');
  return { enabled: input.enabled !== false, serial, username, channels, clockOffset, mode, frames, framesAfter, clipTries, events,
    backfillHours, keepDays };
}

interface CameraRow { phone: string; data: CameraSettings; password: string; saved_by: string; saved_at: string }

// The gate's camera settings, or null (without the recorder password: see recorderSettings).
export async function getCameraSettings(store: Store, phone: string): Promise<CameraSettings | null> {
  const row = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  return row ? { ...row.data, savedBy: row.saved_by, savedAt: row.saved_at } : null;
}

// The same with the recorder password, for connecting to the recorder.
export async function recorderSettings(store: Store, phone: string): Promise<(CameraSettings & WithPassword) | null> {
  const row = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  return row ? { ...row.data, savedBy: row.saved_by, savedAt: row.saved_at, password: decrypt(store, row.password) } : null;
}

// Saves the settings; a blank password keeps the saved one. Throws 400 on bad input.
export async function saveCameraSettings(store: Store, phone: string, user: string, body: unknown): Promise<CameraSettings | null> {
  const settings = normalizeCameraSettings(body);
  const password = String((body && (body as { password?: unknown }).password) || '');
  const old = await one<{ password: string }>(store, 'SELECT password FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!password && !old) throw httpError('Recorder password is required');
  await run(store, `INSERT INTO cameras (phone, data, password, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET data = excluded.data, password = excluded.password, saved_by = excluded.saved_by,
    saved_at = excluded.saved_at`,
  [phoneDigits(phone), JSON.stringify(settings), password ? encrypt(store, password) : old!.password, String(user), new Date().toISOString()]);
  return getCameraSettings(store, phone);
}

export async function deleteCameraSettings(store: Store, phone: string): Promise<boolean> {
  return (await run(store, 'DELETE FROM cameras WHERE phone = $1', [phoneDigits(phone)])) > 0;
}
