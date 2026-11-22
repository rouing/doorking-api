/**
 * @module src/schedules
 *
 * Scheduled transfers (DoorKing32's Scheduled Transfers, reworked): each gate has its own list of entries, each
 * with days of the week, a time (server local time, 24-hour HH:MM) and the transfers to run. Entries run with the
 * gate's DKS login (gate-list.ts); `user` is who last saved the entry. A time missed while the server was stopped
 * runs once at the next check, like DoorKing32's past-due jobs.
 */
import crypto from 'node:crypto';
import { all, one, run, phoneDigits } from './db.ts';
import type { Store } from './db.ts';
import type { Schedule, ScheduleInput } from './types.ts';
import { httpError } from './errors.ts';
import { SCHEDULE_ACTIONS } from './shared.ts';

// Transfers in the order they run: send first (it ends with a check pull of residents), then the pulls, then
// camera snapshots.

interface ScheduleRow {
  id: string; phone: string; username: string; data: ScheduleInput; created_at: string;
  last_due: string | null; last_run: string | null; last_result: string | null; last_error: string | null;
}

type Timed = Pick<ScheduleInput, 'days' | 'time'>;
type RunFields = Partial<Record<'lastDue' | 'lastRun' | 'lastResult' | 'lastError', unknown>>;


/**
 * Validates and normalizes a schedule payload (`days`: 0–6 = Sun–Sat, `time`: 24-hour `HH:MM`, `actions`, `enabled`).
 *
 * @param body - Unvalidated schedule input.
 * @returns Normalized `ScheduleInput`.
 * @throws HTTP 400 error on invalid input.
 */
export function normalizeSchedule(body: unknown): ScheduleInput {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as {
    days?: unknown; time?: unknown; actions?: unknown; enabled?: unknown;
  };
  const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!days.length) throw httpError('Pick at least one day');
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(input.time || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw httpError('Time must be HH:MM (24-hour)');
  const actions = SCHEDULE_ACTIONS.filter((action) => Array.isArray(input.actions) && input.actions.includes(action));
  if (!actions.length) throw httpError('Pick at least one transfer');
  const time = `${match[1].padStart(2, '0')}:${match[2]}`;
  return { days, time, actions, enabled: input.enabled !== false };
}

/**
 * The schedule's time on the day `offset` days from `now`'s calendar date.
 *
 * @param schedule - Schedule days and time.
 * @param now - Reference local `Date`.
 * @param offset - Whole day offset from `now` (negative = past, positive = future).
 * @returns Computed local `Date`.
 */
function at(schedule: Timed, now: Date, offset: number): Date {
  const [hours, minutes] = schedule.time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes, 0, 0);
}

/**
 * The latest time at or before `now` the schedule was due, or null.
 *
 * @param schedule - Scheduled transfer entry.
 * @param [now] - Reference local `Date` (defaults to `new Date()`).
 * @returns Latest due `Date`, or `null`.
 */
export function lastDue(schedule: Timed, now: Date = new Date()): Date | null {
  for (let i = 0; i >= -7; i--) {
    const date = at(schedule, now, i);
    if (date <= now && schedule.days.includes(date.getDay())) return date;
  }
  return null;
}

/**
 * The next time after `now` the schedule is due, or null.
 *
 * @param schedule - Scheduled transfer entry.
 * @param [now] - Reference local `Date` (defaults to `new Date()`).
 * @returns Next due `Date`, or `null`.
 */
export function nextDue(schedule: Timed, now: Date = new Date()): Date | null {
  for (let i = 0; i <= 7; i++) {
    const date = at(schedule, now, i);
    if (date > now && schedule.days.includes(date.getDay())) return date;
  }
  return null;
}

/**
 * Due when enabled and its latest due time is after the one last handled (set to the save time on each save,
 * so a new or edited entry waits for its next time).
 *
 * @param schedule - Scheduled transfer entry.
 * @param [now] - Reference local `Date` (defaults to `new Date()`).
 * @returns True when the schedule is enabled and due.
 */
export function scheduleIsDue(schedule: Timed & { enabled?: boolean; lastDue?: string | null }, now: Date = new Date()): boolean {
  if (!schedule.enabled) return false;
  const due = lastDue(schedule, now);
  return Boolean(due) && due! > new Date(schedule.lastDue || 0);
}

function fromRow(row: ScheduleRow, now: Date = new Date()): Schedule {
  const schedule = { id: row.id, phoneNumber: row.phone, user: row.username, ...row.data, createdAt: row.created_at,
    lastDue: row.last_due, lastRun: row.last_run, lastResult: row.last_result, lastError: row.last_error };
  const next = schedule.enabled ? nextDue(schedule, now) : null;
  return { ...schedule, nextRun: next ? next.toISOString() : null };
}

/**
 * All entries (phone omitted) or one gate's, ordered by time.
 *
 * @param store - Database store handle.
 * @param [phone] - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `Schedule[]`.
 */
export async function listSchedules(store: Store, phone?: string): Promise<Schedule[]> {
  const rows = phone
    ? await all<ScheduleRow>(store, 'SELECT * FROM schedules WHERE phone = $1 ORDER BY created_at', [phoneDigits(phone)])
    : await all<ScheduleRow>(store, 'SELECT * FROM schedules ORDER BY created_at');
  return rows.map((row) => fromRow(row)).sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Get schedule.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Unique record identifier.
 * @returns Promise resolving to `Schedule | null`.
 */
export async function getSchedule(store: Store, phone: string, id: string): Promise<Schedule | null> {
  const row = await one<ScheduleRow>(store, 'SELECT * FROM schedules WHERE phone = $1 AND id = $2', [phoneDigits(phone), String(id)]);
  return row ? fromRow(row) : null;
}

/**
 * Creates (no id) or replaces an entry; `user` becomes its owner. Throws 400 on bad input, 404 on unknown id.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param user - Local account username (or actor name for audit logs).
 * @param body - Parsed JSON request body.
 * @param [id] - Unique record identifier.
 * @returns Promise resolving to `Schedule | null`.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function saveSchedule(store: Store, phone: string, user: string, body: unknown, id: string | null = null): Promise<Schedule | null> {
  const schedule = normalizeSchedule(body);
  const now = new Date().toISOString();
  const data = JSON.stringify(schedule);
  if (id) {
    const changes = await run(store, 'UPDATE schedules SET username = $1, data = $2, last_due = $3 WHERE phone = $4 AND id = $5',
      [String(user), data, now, phoneDigits(phone), String(id)]);
    if (!changes) throw httpError('Schedule not found', 404);
    return getSchedule(store, phone, id);
  }
  const newId = crypto.randomBytes(8).toString('hex');
  await run(store, 'INSERT INTO schedules (id, phone, username, data, created_at, last_due) VALUES ($1, $2, $3, $4, $5, $6)',
    [newId, phoneDigits(phone), String(user), data, now, now]);
  return getSchedule(store, phone, newId);
}

/**
 * Delete schedule.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Unique record identifier.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function deleteSchedule(store: Store, phone: string, id: string): Promise<void> {
  const changes = await run(store, 'DELETE FROM schedules WHERE phone = $1 AND id = $2', [phoneDigits(phone), String(id)]);
  if (!changes) throw httpError('Schedule not found', 404);
}

/**
 * Updates the run fields: lastDue, lastRun, lastResult, lastError (only those given).
 *
 * @param store - Database store handle.
 * @param id - Unique record identifier.
 * @param fields - Field names or field updates.
 */
export async function updateScheduleRun(store: Store, id: string, fields: RunFields): Promise<void> {
  const cols = { lastDue: 'last_due', lastRun: 'last_run', lastResult: 'last_result', lastError: 'last_error' } as const;
  const keys = (Object.keys(cols) as (keyof typeof cols)[]).filter((key) => key in fields);
  if (!keys.length) return;
  await run(store, `UPDATE schedules SET ${keys.map((key, i) => `${cols[key]} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
    [...keys.map((key) => (fields[key] == null ? null : String(fields[key]))), String(id)]);
}
