/**
 * @module src/passkey-approvals
 *
 * Approving another device: a signed-in session that has just confirmed with a passkey creates a one-time code; a
 * session of the same account on another device enters it to add a passkey there (one with no passkey of its own to
 * confirm with, e.g. when the account's passkey is on a laptop that can't scan a QR code). Codes are kept in memory
 * for APPROVAL_MS, one per account (a new one replaces it), and are dropped after MAX_WRONG wrong tries or when a
 * passkey is added.
 */
import crypto from 'node:crypto';

export const APPROVAL_MS = 10 * 60000;
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;
const MAX_WRONG = 5;

interface Approval { code: string; expires: number; wrong: number }

/**
 * The code as typed: case and anything but letters and digits ignored ("abcd-efgh" is ABCDEFGH).
 *
 * @param given - Unvalidated caller input.
 * @returns Computed result.
 */
const normalized = (given: unknown) => String(given ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PasskeyApprovals {
  private readonly approvals = new Map<string, Approval>(); // username -> its code

  /**
   * Create.
   *
   * @param username - Local account username.
   * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
   * @returns `{ code: string; expiresAt: string }` result.
   */
  create(username: string, now = Date.now()): { code: string; expiresAt: string } {
    const code = Array.from({ length: CODE_LENGTH }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
    this.approvals.set(username, { code, expires: now + APPROVAL_MS, wrong: 0 });
    return { code, expiresAt: new Date(now + APPROVAL_MS).toISOString() };
  }

  /**
   * True when `given` is the account's current code. A wrong code counts against it.
   *
   * @param username - Local account username.
   * @param given - Unvalidated caller input.
   * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
   * @returns True when the condition holds.
   */
  accepts(username: string, given: unknown, now = Date.now()): boolean {
    const approval = this.approvals.get(username);
    if (!approval || approval.expires < now) return false;
    const typed = Buffer.from(normalized(given));
    const right = typed.length === CODE_LENGTH && crypto.timingSafeEqual(typed, Buffer.from(approval.code));
    if (right) return true;
    approval.wrong++;
    if (approval.wrong >= MAX_WRONG) this.approvals.delete(username);
    return false;
  }

  /**
   * Drop.
   *
   * @param username - Local account username.
   */
  drop(username: string): void {
    this.approvals.delete(username);
  }

  /**
   * Sweep.
   *
   * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
   */
  sweep(now = Date.now()): void {
    for (const [username, approval] of this.approvals) if (approval.expires < now) this.approvals.delete(username);
  }
}
