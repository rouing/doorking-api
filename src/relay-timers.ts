/**
 * @module src/relay-timers
 *
 * Persisted auto-release timers for live relays ("Safe Hold-Open"). When a gate admin holds a relay open with a
 * duration, a row is saved here so the server automatically releases the relay when time expires — even across restarts.
 */
import { all, one, phoneDigits, run, type Store } from './db.ts';
import { httpError } from './errors.ts';
import type { RelayTimer } from './types.ts';

export const MAX_HOLD_MINUTES = 24 * 60;

interface RelayTimerRow {
  phone: string;
  relay: number;
  release_at: string;
  set_by: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

const fromRow = (row: RelayTimerRow): RelayTimer => ({
  phone: row.phone,
  relay: row.relay,
  releaseAt: row.release_at,
  setBy: row.set_by,
  createdAt: row.created_at,
  attempts: row.attempts,
  lastError: row.last_error,
});

/**
 * Validates `holdMinutes` (1–1440) or an ISO `releaseAt` timestamp (up to 24 hours from `now`) and returns the release `Date`.
 *
 * @param options - Timing options from the relay request body.
 * @param [options.holdMinutes] - Hold duration in minutes (1–1440).
 * @param [options.releaseAt] - Explicit future ISO timestamp within 24 hours.
 * @param [now] - Reference time in milliseconds.
 * @returns Target release `Date`, or `null` when neither option was provided.
 * @throws HTTP 400 error when the duration or timestamp is out of range.
 */
export function parseHoldDuration(
  { holdMinutes, releaseAt }: { holdMinutes?: unknown; releaseAt?: unknown },
  now = Date.now(),
): Date | null {
  if (holdMinutes !== undefined && holdMinutes !== null && holdMinutes !== '') {
    const minutes = Number(holdMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_HOLD_MINUTES) {
      throw httpError(`holdMinutes must be a whole number from 1 to ${MAX_HOLD_MINUTES}`);
    }
    return new Date(now + minutes * 60000);
  }
  if (releaseAt !== undefined && releaseAt !== null && releaseAt !== '') {
    const parsed = new Date(String(releaseAt));
    const ms = parsed.getTime();
    if (Number.isNaN(ms) || ms <= now + 15000 || ms > now + MAX_HOLD_MINUTES * 60000) {
      throw httpError('releaseAt must be a valid time between 1 minute and 24 hours from now');
    }
    return parsed;
  }
  return null;
}

/**
 * Saves or replaces the auto-release timer for one relay on a gate.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param relay - Relay number (0–18).
 * @param releaseAt - Timestamp when the relay should be released.
 * @param setBy - Username or API key actor who set the timer.
 * @returns Promise resolving to the saved `RelayTimer`.
 */
export async function setRelayTimer(store: Store, phone: string, relay: number, releaseAt: Date, setBy: string): Promise<RelayTimer> {
  const phoneKey = phoneDigits(phone);
  const now = new Date().toISOString();
  await run(store, `INSERT INTO relay_timers (phone, relay, release_at, set_by, created_at, attempts, last_error)
    VALUES ($1, $2, $3, $4, $5, 0, NULL)
    ON CONFLICT (phone, relay) DO UPDATE SET release_at = excluded.release_at, set_by = excluded.set_by,
    created_at = excluded.created_at, attempts = 0, last_error = NULL`,
  [phoneKey, relay, releaseAt.toISOString(), setBy, now]);
  const row = (await one<RelayTimerRow>(store, 'SELECT * FROM relay_timers WHERE phone = $1 AND relay = $2', [phoneKey, relay]))!;
  return fromRow(row);
}

/**
 * Removes an auto-release timer for one relay (called on manual release, cancel, or completed auto-release).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param relay - Relay number (0–18).
 * @returns Promise resolving to `true` if a timer existed and was removed.
 */
export async function clearRelayTimer(store: Store, phone: string, relay: number): Promise<boolean> {
  return (await run(store, 'DELETE FROM relay_timers WHERE phone = $1 AND relay = $2', [phoneDigits(phone), relay])) > 0;
}

/**
 * Lists active auto-release timers for a gate, ordered by relay number.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `RelayTimer[]`.
 */
export async function listRelayTimers(store: Store, phone: string): Promise<RelayTimer[]> {
  const rows = await all<RelayTimerRow>(store, 'SELECT * FROM relay_timers WHERE phone = $1 ORDER BY relay', [phoneDigits(phone)]);
  return rows.map(fromRow);
}

/**
 * Returns all timers whose `release_at` is at or before `now`.
 *
 * @param store - Database store handle.
 * @param [now] - Reference `Date` (defaults to current time).
 * @returns Promise resolving to due `RelayTimer[]`.
 */
export async function dueRelayTimers(store: Store, now = new Date()): Promise<RelayTimer[]> {
  const rows = await all<RelayTimerRow>(store, 'SELECT * FROM relay_timers WHERE release_at <= $1 ORDER BY release_at', [now.toISOString()]);
  return rows.map(fromRow);
}

/**
 * Records a failed auto-release attempt and returns the updated attempt count.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param relay - Relay number (0–18).
 * @param error - Failure message from DKS Cloud.
 * @returns Promise resolving to the new `attempts` count.
 */
export async function recordRelayTimerFailure(store: Store, phone: string, relay: number, error: string): Promise<number> {
  const row = await one<{ attempts: number }>(store,
    'UPDATE relay_timers SET attempts = attempts + 1, last_error = $3 WHERE phone = $1 AND relay = $2 RETURNING attempts',
    [phoneDigits(phone), relay, error.slice(0, 300)]);
  return row ? row.attempts : 0;
}
