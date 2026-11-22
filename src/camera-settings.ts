/**
 * @module src/camera-settings
 *
 * Camera settings: their types, limits and validation (Zod), and the cameras table.
 */
import { z } from 'zod';
import { encrypt, decrypt, phoneDigits, one, run, type Store } from './db.ts';
import type { CameraSettings } from './types.ts';
import { httpError } from './errors.ts';

/** Settings as validated by normalizeCameraSettings; with the recorder password for the runner. */
export type CameraConfig = Omit<CameraSettings, 'savedBy' | 'savedAt'>;
export type WithPassword = { password: string };
export interface Recorder { serial: string; username: string; password: string }

export type Shifts = Record<string, number>;
export type Log = (message: string) => void;
/** Transaction rows as read by transactions.ts (only the fields used here). */
export interface TxRow { ts: number; access?: string; eventType?: string }
export interface PendingMinute { minute: string; ts: number }

const CAMERA_EVENTS = ['access', 'all'] as const; // access: admitted/denied entries only
const CAMERA_MODES = ['snapshots', 'video'] as const;

export const CLIP_TRIES = 2; // default whole-video tries before a cut-off video fails (setting clipTries)
const MAX_CLIP_TRIES = 5;
const MAX_CHANNELS = 8;
export const NO_VIDEO_MSG = 'The recorder sent no video';
export const SETTLE_MS = 90000; // a minute this recent may not be fully recorded yet
const KEEP_DAYS = [15, 30, 60, 90, 0]; // how long saved snapshots are kept (setting keepDays); 0 = forever

const intField = (def: number, min: number, max: number, msg: string) =>
  z.preprocess((value) => (value === undefined || value === null || value === '' ? def : Number(value)),
    z.int({ error: msg }).min(min, { error: msg }).max(max, { error: msg }));

const ChannelsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && item.channel !== '' && item.channel != null) : []),
  z.array(z.object({
    channel: z.preprocess((value) => Number(value), z.int({ error: 'Channels must be 1-64' }).min(1, { error: 'Channels must be 1-64' }).max(64, { error: 'Channels must be 1-64' })),
    name: z.preprocess((value) => String(value || '').trim().slice(0, 40), z.string()),
  }))
    .min(1, { error: `List 1-${MAX_CHANNELS} channels` })
    .max(MAX_CHANNELS, { error: `List 1-${MAX_CHANNELS} channels` })
    .superRefine((list, ctx) => {
      const seen = new Set<number>();
      for (const item of list) {
        if (seen.has(item.channel)) {
          ctx.addIssue({ code: 'custom', message: `Channel ${item.channel} is listed twice` });
          return;
        }
        seen.add(item.channel);
      }
    }),
);

const CameraConfigSchema = z.object({
  enabled: z.unknown().optional().transform((value) => value !== false),
  serial: z.preprocess((value) => String(value || '').trim(), z.string().regex(/^[A-Za-z0-9]{6,32}$/, { error: 'Recorder serial must be 6-32 letters and digits' })),
  username: z.preprocess((value) => String(value || '').trim().slice(0, 64), z.string().min(1, { error: 'Recorder username is required' })),
  channels: ChannelsSchema,
  clockOffset: intField(0, -86400, 86400, 'Clock offset must be whole seconds within a day'),
  mode: z.preprocess((value) => value || 'snapshots', z.enum(CAMERA_MODES, { error: `Save must be ${CAMERA_MODES.join(' or ')}` })),
  frames: intField(3, 1, 6, 'Frames per transaction must be 1-6'),
  framesAfter: intField(0, 0, 6, 'Frames after the minute must be 0-6'),
  clipTries: intField(CLIP_TRIES, 1, MAX_CLIP_TRIES, `Video tries must be 1-${MAX_CLIP_TRIES}`),
  events: z.preprocess((value) => value || 'access', z.enum(CAMERA_EVENTS, { error: `Events must be ${CAMERA_EVENTS.join(' or ')}` })),
  backfillHours: intField(24, 0, 720, 'Look-back hours must be 0-720'),
  keepDays: z.preprocess((value) => (value === undefined || value === null || value === '' ? 0 : Number(value)),
    z.int({ error: 'Keep pictures must be 15, 30, 60 or 90 days, or forever' })
      .refine((days) => KEEP_DAYS.includes(days), { error: 'Keep pictures must be 15, 30, 60 or 90 days, or forever' })),
});

/**
 * The checked settings; throws 400 (httpError) on bad input.
 *
 * @param body - Unvalidated camera settings payload (`channels: [{ channel: 1-64, name }]`).
 * @returns Validated `CameraConfig`.
 * @throws HTTP 400 error on invalid input.
 */
export function normalizeCameraSettings(body: unknown): CameraConfig {
  const parsed = CameraConfigSchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  if (!parsed.success) throw httpError(parsed.error.issues[0].message);
  return parsed.data as CameraConfig;
}

interface CameraRow { phone: string; data: CameraSettings; password: string; saved_by: string; saved_at: string }

/**
 * The gate's camera settings, or null (without the recorder password: use recorderSettings).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `CameraSettings | null`.
 */
export async function getCameraSettings(store: Store, phone: string): Promise<CameraSettings | null> {
  const row = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  return row ? { ...row.data, savedBy: row.saved_by, savedAt: row.saved_at } : null;
}

/**
 * The same with the recorder password, for connecting to the recorder.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `(CameraSettings & WithPassword) | null`.
 */
export async function recorderSettings(store: Store, phone: string): Promise<(CameraSettings & WithPassword) | null> {
  const row = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  return row ? { ...row.data, savedBy: row.saved_by, savedAt: row.saved_at, password: decrypt(store, row.password) } : null;
}

/**
 * Saves the settings; a blank password keeps the saved one. Throws 400 on bad input.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param user - Local account username (or actor name for audit logs).
 * @param body - Parsed JSON request body.
 * @returns Promise resolving to `CameraSettings | null`.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export async function saveCameraSettings(store: Store, phone: string, user: string, body: unknown): Promise<CameraSettings | null> {
  const settings = normalizeCameraSettings(body);
  const password = String((body && typeof body === 'object' && (body as { password?: unknown }).password) || '');
  const old = await one<{ password: string }>(store, 'SELECT password FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!password && !old) throw httpError('Recorder password is required');
  await run(store, `INSERT INTO cameras (phone, data, password, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET data = excluded.data, password = excluded.password, saved_by = excluded.saved_by,
    saved_at = excluded.saved_at`,
  [phoneDigits(phone), JSON.stringify(settings), password ? encrypt(store, password) : old!.password, String(user), new Date().toISOString()]);
  return getCameraSettings(store, phone);
}

/**
 * Delete camera settings.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function deleteCameraSettings(store: Store, phone: string): Promise<boolean> {
  return (await run(store, 'DELETE FROM cameras WHERE phone = $1', [phoneDigits(phone)])) > 0;
}
