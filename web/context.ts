/**
 * @module web/context
 *
 * Shared server state: settings, database, log, and gate access for a signed-in user.
 */
import path from 'node:path';
import * as dk from '../index.ts';
import type { RecordChange } from '../src/audit.ts';
import type { SnapshotProgress, SnapshotResult } from '../src/cameras.ts';
import type { GatePrefs, GateRole } from '../src/types.ts';
import { logger, logMessages } from '../src/logging.ts';

export type Body = Record<string, unknown>; // request JSON, checked by each handler
export type Reply = readonly [number, unknown];
/**
 * tokenHash identifies the session row; gate: the phone number the web UI has open. apiKey: the request came with an
 * API key (then user is "api:<key name>" and there is no session row). strongAt: last passkey confirmation (ms) or null.
 */
export interface Session {
  tokenHash: string; user: string; gate: string | null; mustChangePassword: boolean; strongAt: number | null; signedInAt: number; apiKey?: { phone: string; role: GateRole };
}
/**
 * A managed gate as seen by one user: role is theirs, actor their username (for History); user/password are the
 * gate's DKS login (what buildSessionRequest and the relay calls read).
 */
export type Gate = dk.GateRecord & { role: GateRole; actor: string; user: string; password: string; dir: string };
export interface JobState {
  state: 'idle' | 'running' | 'done' | 'failed'; what?: string; phoneNumber?: string; user?: string; account?: string; // account: the DKS login (lower case)
  startedAt?: Date; finishedAt?: Date; log: string[]; error?: string; adding?: boolean;
}
/** adding: the first pull of a gate being added; it is saved as a managed gate only when that pull succeeds. */
export interface JobInfo { scheduled?: boolean; details?: RecordChange[]; adding?: boolean }
export interface PullSteps { prepare?: () => Promise<unknown>; afterPull?: (log: (line: string) => void) => Promise<void> }
export interface SnapRun {
  state: 'running' | 'done' | 'stopped' | 'failed'; startedAt: Date; finishedAt?: Date; log: string[]; minute?: string;
  progress?: SnapshotProgress; result?: SnapshotResult | null; error?: string; again?: boolean; stopping?: boolean;
  done: Promise<SnapRun>;
}
/** What the server is built from (created by web/server.ts, the entry point). */
export interface Services {
  config: dk.ServerConfig; store: dk.Store; cameras: ReturnType<typeof dk.createCameraRunner>; mailer: dk.Mailer | null;
}
export interface PrefsChange { before: Record<string, unknown>; after: Record<string, unknown> }
export type SessionRequest = ReturnType<typeof dk.buildSessionRequest>;

/**
 * Create context.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
export function createContext(deps: Services) {
  /**
   * A field of the body that is a JSON object (not an array), or null.
   *
   * @param body - Parsed JSON request body.
   * @param key - Lookup key, API key, or setting key.
   * @returns `Body | null` result.
   */
  const objectField = (body: Body, key: string): Body | null => {
    const v = body[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Body : null;
  };
  const HERE = import.meta.dirname;
  const config = deps.config;
  const HOST = config.server.host;
  const PORT = config.server.port;
  /**
   * Public name served by an HTTPS reverse proxy (Caddy) in front of this server, e.g. gate.example.com. Empty = local only.
   */
  const PUBLIC_HOST = config.server.publicHost;
  const ROOT = config.paths.media; // one folder per gate: media/<phone digits>
  const store = deps.store;
  const IDLE_MS = config.security.sessionIdleMinutes * 60000;
  const MAX_AGE_MS = config.security.sessionMaxHours * 3600000;
  const STEP_UP_MS = config.security.stepUpMinutes * 60000;
  const MAX_BODY_BYTES = 10000;
  /**
   * Failed password sign-ins: after MAX_FAILED_SIGN_INS within SIGN_IN_WINDOW_MS (per user name, client address and
   * both; see signInKeys), sign-in is refused for the rest of the window, so a guessing script gets nowhere.
   */
  const MAX_FAILED_SIGN_INS = config.security.maxFailedSignIns;
  const SIGN_IN_WINDOW_MS = config.security.signInWindowMinutes * 60000;
  /** Gate-match defaults for the login form; the browser can override them in the Connect panel. */
  const defaults = config.gateDefaults;
  const client = () => new dk.DksCloudClient({ url: config.dks.url, log: logMessages('dks', 'debug') });
  const cameras = deps.cameras;
  /**
   * Email (src/email.ts): off when config.json has no email.host. Emails go through the outbox; sendEmails() runs every
   * 30 s and right after an email is queued. APP is the address links point to.
   */
  const mailer = deps.mailer;
  const APP = config.email.appUrl;
  const NO_EMAIL = 'Email isn\'t set up on this server (config.json → email). Ask the person who runs it.';
  /**
   * A .catch handler for background work: the failure goes to the log (console and file).
   *
   * @param area - `string` value.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @returns Computed result.
   */
  const logged = (area: string, what: string) => (err: unknown) => logger(area).error`${what}: ${(err as Error).message}`;
  const NO_GATE = 'Gate not found, or you have no access to it';
  const ADMIN_ONLY = 'Only a gate admin can do this. Your access to this gate is read only.';
  /**
   * The managed gate as `actor` sees it, with their role ('admin' for scheduled runs).
   *
   * @param rec - `dk.GateRecord` value.
   * @param role - Gate access role (`admin` or `readonly`).
   * @param actor - Username or API key identifier performing the action.
   * @returns `Gate` result.
   */
  function asGate(rec: dk.GateRecord, role: GateRole, actor: string): Gate {
    return { ...rec, role, actor, user: rec.dksUser, password: rec.dksPassword, dir: path.join(ROOT, rec.phoneNumber) };
  }
  /**
   * The gate named in the URL, if the signed-in user has access to it.
   *
   * @param session - Authenticated user or API-key session.
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to `Gate`.
   * @throws HTTP 404 error on invalid input or conflict.
   */
  async function gateFor(session: { user: string }, phone: string): Promise<Gate> {
    const [rec, role] = await Promise.all([dk.getGate(store, phone), dk.accessOf(store, phone, session.user)]);
    if (!rec || !role) throw dk.httpError(NO_GATE, 404);
    return asGate(rec, role, session.user);
  }
  const prefsOf = (phone: string): Promise<GatePrefs> => dk.getPrefs(store, phone);
  const siteNameOf = async (phone: string): Promise<string> => ((await prefsOf(phone)).gateConfig || {}).siteName || '';
  const gateInfo = async (gate: { phoneNumber: string; role: GateRole; addedAt: string }) => ({
    phoneNumber: gate.phoneNumber, siteName: await siteNameOf(gate.phoneNumber), addedAt: gate.addedAt, role: gate.role,
  });
  /**
   * Runs fn after the gate's earlier queued work: changes to a gate's working copy and prefs run one at a time, so
   * each History entry holds exactly its own change.
   */
  const gateQueues = new Map<string, Promise<unknown>>();
  function serial<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const queued = (gateQueues.get(phone) || Promise.resolve()).catch(() => {}).then(fn);
    gateQueues.set(phone, queued);
    queued.catch(() => {}).finally(() => { if (gateQueues.get(phone) === queued) gateQueues.delete(phone); });
    return queued;
  }
  const { GATE_CONFIG_KEYS } = dk;
  const AREA_CODE_SETTINGS = ['10 Area Codes', '255 Area Codes'];
  return { objectField, HERE, config, HOST, PORT, PUBLIC_HOST, ROOT, store, IDLE_MS, MAX_AGE_MS, STEP_UP_MS, MAX_BODY_BYTES, MAX_FAILED_SIGN_INS, SIGN_IN_WINDOW_MS, defaults, client, cameras, mailer, APP, NO_EMAIL, logged, NO_GATE, ADMIN_ONLY, asGate, gateFor, prefsOf, siteNameOf, gateInfo, serial, GATE_CONFIG_KEYS, AREA_CODE_SETTINGS };
}

export type ContextModule = ReturnType<typeof createContext>;
