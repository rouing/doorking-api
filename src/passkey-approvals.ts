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

export const PUSH_APPROVAL_TTL_MS = 3 * 60000;
export type PushApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PushApprovalCreated {
  id: string;
  numberMatch: number;
  choices: [number, number, number];
  challenge: string;
  expiresAt: string;
}

export interface PushApprovalRequesterView {
  id: string;
  status: PushApprovalStatus;
  approvalCode?: string;
  expiresAt: string;
}

export interface PushApprovalPendingItem {
  id: string;
  deviceLabel: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
  choices: [number, number, number];
  challenge: string;
}

export interface PushApprovalPendingInternal extends PushApprovalPendingItem {
  numberMatch: number;
}

export type PushApprovalActionResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; status: 'approved' | 'denied' | 'expired' | 'not_found' };

interface PushApprovalEntry {
  id: string;
  username: string;
  sessionTokenHash: string;
  deviceLabel: string;
  ip: string;
  numberMatch: number;
  choices: [number, number, number];
  challenge: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  approvalCode?: string;
  createdAt: number;
  expiresAt: number;
}

const normUser = (username: string) => String(username || '').trim().toLowerCase();

function generateNumberChoices(): { numberMatch: number; choices: [number, number, number] } {
  const numberMatch = crypto.randomInt(10, 100);
  const picked = new Set<number>([numberMatch]);
  while (picked.size < 3) picked.add(crypto.randomInt(10, 100));
  const arr = [...picked];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { numberMatch, choices: arr as [number, number, number] };
}

/**
 * In-memory push-notification passkey approval requests (3-minute TTL) with 2-digit number matching
 * and per-request challenge for hardware ECDSA P-256 verification.
 */
export class PasskeyPushApprovals {
  private readonly requests = new Map<string, PushApprovalEntry>();

  create(
    username: string,
    sessionTokenHash: string,
    { deviceLabel = 'Another device', ip = '' }: { deviceLabel?: string; ip?: string },
    now = Date.now(),
  ): PushApprovalCreated {
    this.sweep(now);
    const id = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('base64url');
    const { numberMatch, choices } = generateNumberChoices();
    const expiresAt = now + PUSH_APPROVAL_TTL_MS;
    this.requests.set(id, {
      id,
      username: normUser(username),
      sessionTokenHash,
      deviceLabel: String(deviceLabel || 'Another device').trim().slice(0, 80) || 'Another device',
      ip: String(ip || '').trim().slice(0, 64),
      numberMatch,
      choices,
      challenge,
      status: 'pending',
      createdAt: now,
      expiresAt,
    });
    return {
      id,
      numberMatch,
      choices: [...choices] as [number, number, number],
      challenge,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  getForRequester(
    username: string,
    sessionTokenHash: string,
    id: string,
    now = Date.now(),
  ): PushApprovalRequesterView | null {
    const entry = this.requests.get(id);
    if (!entry || entry.username !== normUser(username) || entry.sessionTokenHash !== sessionTokenHash) return null;
    if (entry.status === 'pending' && entry.expiresAt <= now) {
      entry.status = 'expired';
    }
    return {
      id: entry.id,
      status: entry.status,
      ...(entry.status === 'approved' && entry.approvalCode ? { approvalCode: entry.approvalCode } : {}),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  listPendingForUser(username: string, now = Date.now()): PushApprovalPendingItem[] {
    const user = normUser(username);
    const out: PushApprovalPendingItem[] = [];
    for (const entry of this.requests.values()) {
      if (entry.username !== user) continue;
      if (entry.status !== 'pending') continue;
      if (entry.expiresAt <= now) {
        entry.status = 'expired';
        continue;
      }
      out.push({
        id: entry.id,
        deviceLabel: entry.deviceLabel,
        ip: entry.ip,
        createdAt: new Date(entry.createdAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
        choices: [...entry.choices] as [number, number, number],
        challenge: entry.challenge,
      });
    }
    return out;
  }

  getPending(username: string, id: string, now = Date.now()): PushApprovalPendingInternal | null {
    const entry = this.requests.get(id);
    if (!entry || entry.username !== normUser(username) || entry.status !== 'pending') return null;
    if (entry.expiresAt <= now) {
      entry.status = 'expired';
      return null;
    }
    return {
      id: entry.id,
      deviceLabel: entry.deviceLabel,
      ip: entry.ip,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      choices: [...entry.choices] as [number, number, number],
      challenge: entry.challenge,
      numberMatch: entry.numberMatch,
    };
  }

  approve(
    username: string,
    id: string,
    pickedNumber: number,
    approvalCode: string,
    now = Date.now(),
  ): PushApprovalActionResult {
    const entry = this.requests.get(id);
    if (!entry || entry.username !== normUser(username)) return { ok: false, status: 'not_found' };
    if (entry.status !== 'pending') return { ok: false, status: entry.status };
    if (entry.expiresAt <= now) {
      entry.status = 'expired';
      return { ok: false, status: 'expired' };
    }
    if (Number(pickedNumber) !== entry.numberMatch) {
      entry.status = 'denied';
      return { ok: false, status: 'denied' };
    }
    entry.status = 'approved';
    entry.approvalCode = approvalCode;
    return { ok: true, status: 'approved' };
  }

  deny(username: string, id: string, now = Date.now()): PushApprovalActionResult {
    const entry = this.requests.get(id);
    if (!entry || entry.username !== normUser(username)) return { ok: false, status: 'not_found' };
    if (entry.status !== 'pending') return { ok: false, status: entry.status };
    if (entry.expiresAt <= now) {
      entry.status = 'expired';
      return { ok: false, status: 'expired' };
    }
    entry.status = 'denied';
    return { ok: true, status: 'denied' };
  }

  sweep(now = Date.now()): void {
    for (const [id, entry] of this.requests) {
      if (entry.expiresAt <= now) this.requests.delete(id);
    }
  }
}
